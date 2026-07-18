// AvaMarketplace routes (Specs/AVAMARKETPLACE-FINAL-PROPOSAL.md).
// Buy/sell/social marketplace glue on top of the Phase-6 listings tables:
//   POST /api/marketplace/ai-assist          P3 — "Help me write" (Claude Sonnet)
//   POST /api/marketplace/negotiate          P5 — queue agent↔agent negotiation
//   GET  /api/marketplace/negotiate/state     P5 — talk-once-per-version check
//   GET  /api/marketplace/search              P6 — AI search over active listings
//   POST /api/marketplace/precheck            P7 — text + PII safety precheck
// All write routes require auth. The negotiation LLM is the latest Claude Sonnet
// via OpenRouter; deal audio (Gemini 2.5 multi-speaker TTS) is rendered ONLY on
// a DEAL. Everything here is dark until the marketplaceEnabled kill switch is on.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail, dmConvId } from "../authz";
import { track, trackUserContact } from "../hooks";
import { metaDb } from "../db/shard";
import { notifyUser } from "../notify";
import { exploreSearch } from "./listings";
import { partyEmit } from "./messaging"; // PartyKit live nudges (ephemeral)
import { moderate } from "../lib/moderation";
import { avaReason } from "../lib/ava_reason"; // One Brain B1: unified reasoning gateway
import { readConfig } from "./config"; // P5: agentDailyCap
import { getAgentSettings, type AgentSettings } from "./agent_settings"; // MKT-LANG: buyer/seller lang, floor, tone, guardrails
import { contactFor } from "../lib/identity"; // MKT-LANG-5: stamp email on translation telemetry

/** Latest Claude Sonnet via OpenRouter — overridable by env for "latest" tracking. */
export const MARKET_LLM = "anthropic/claude-sonnet-4.6";

/**
 * One-shot OpenRouter chat call (Sonnet). Returns trimmed text or "" on error.
 *
 * One Brain B1 (SPEC §4): routed through the shared avaReason gateway instead of a
 * raw fetch, so this call now gains unified `ava_reason_call` telemetry, the abort
 * timeout, and centralised error logging. Behaviour preserved EXACTLY: the model is
 * still pinned via `legacyModel` (single OpenRouter call, no reasoner-ladder
 * fallback — the worker `legacyModel` plan is noFallback), temperature 0.4,
 * max_tokens = maxTokens, same `OPENROUTER_MARKET_MODEL` env override → MARKET_LLM.
 * The ""-on-error / ""-when-no-key contract is kept here at the call site; provider
 * failures are now logged/telemetered by the gateway rather than swallowed silently.
 * (The only observable delta is the OpenRouter `X-Title` header: "AvaMarketplace" →
 * "AvaTOK avaReason" — a dashboard label, not model input or output.)
 */
export async function callSonnet(
  env: Env,
  system: string,
  user: string,
  maxTokens = 400,
  timeoutMs = 25000,
): Promise<string> {
  const key = (env as any).OPENROUTER_API_KEY as string | undefined;
  if (!key) return "";
  try {
    return await avaReason(env, {
      role: "marketplace", capability: "assist", trigger: "call_sonnet",
      feature: "marketplace",
      legacyModel: (env as any).OPENROUTER_MARKET_MODEL || MARKET_LLM,
      system, user,
      temperature: 0.4, maxTokens, timeoutMs,
    });
  } catch {
    return "";
  }
}

// ── Deal-audio render (Gemini 2.5 multi-speaker TTS) + voice-note delivery ────
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap 24kHz mono 16-bit PCM as a playable WAV (chat voice notes are WAV). */
function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  const ch = 1, bits = 16;
  const byteRate = (sampleRate * ch * bits) / 8, block = (ch * bits) / 8;
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, byteRate, true);
  v.setUint16(32, block, true); v.setUint16(34, bits, true); w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(head), 0); out.set(pcm, 44);
  return out;
}

/** Render a 2-voice negotiation transcript to a WAV via Gemini TTS. null on error. */
async function renderNegotiationWav(env: Env, transcript: Array<{ speaker: string; text: string }>, persona?: string): Promise<Uint8Array | null> {
  const key = (env as any).RECEPTIONIST_GEMINI_API_KEY || (env as any).GEMINI_API_KEY;
  if (!key || !transcript.length) return null;
  const styleHint = persona && persona.trim() ? ` Speak in this style/accent: ${persona.trim()}.` : "";
  // Keep the SPOKEN version SHORT. A full multi-round transcript makes the TTS
  // model generate 40-60s of audio, which takes longer than the Worker's
  // background (waitUntil) budget → the render is reaped before it finishes and
  // NO audio is delivered. Cap to the opening exchange + the closing line so the
  // clip is ~10-15s and reliably renders inside budget. The full text + the
  // "Transcript" link already carry the complete negotiation.
  const lines = transcript.map((t) => `${t.speaker === "Buyer" ? "Buyer" : "Seller"}: ${t.text}`);
  const spoken = lines.length > 6 ? [...lines.slice(0, 5), lines[lines.length - 1]] : lines;
  const script = `TTS this short marketplace negotiation between two agents, natural and businesslike.${styleHint}\n` +
    spoken.join("\n");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: script }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: [
        { speaker: "Seller", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
        { speaker: "Buyer", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      ] } },
    },
  };
  try {
    // 25s cap. With the SHORT (capped) script above the render finishes in
    // ~10-15s, comfortably inside the Worker's background budget. (60s was worse:
    // the long render outlived the budget and the whole job was reaped → no
    // completion event, no audio at all.)
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (typeof data !== "string") return null;
    return pcmToWav(b64ToBytes(data));
  } catch {
    return null;
  }
}

/**
 * Create the DM thread (conversations + conversation_members rows) for both
 * parties. WITHOUT this the chat list — which is driven by
 * `conversations JOIN conversation_members` (GET /api/conversations) — never
 * shows the thread, even though the message is in the InboxDO. This mirrors
 * messaging.ts `ensureDm`, which every normal DM calls before appending.
 */
async function ensureDmThread(env: Env, a: string, b: string, context: string | null): Promise<void> {
  const conv = dmConvId(a, b);
  const now = Date.now();
  const db = metaDb(env);
  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO conversations (id, kind, created_by, created_at, updated_at, context) VALUES (?1,'dm',?2,?3,?3,?4)").bind(conv, a, now, context),
      db.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, a, now),
      db.prepare("INSERT OR IGNORE INTO conversation_members (conv_id, uid, role, joined_at) VALUES (?1,?2,'member',?3)").bind(conv, b, now),
    ]);
  } catch { /* best-effort — InboxDO append still carries the message */ }
}

/** Append a marketplace voice/text message into a user's InboxDO thread.
 *  kind is "text": the app's sync/ingest layer surfaces normal text messages and
 *  the chat_thread renderer special-cases the BODY envelope's {t:'marketplace_deal'}
 *  to draw the deal card (this is how every body-envelope special — card/poll/
 *  sticker/recept-ack — is delivered; a CUSTOM kind like 'marketplace_deal' was
 *  NOT surfaced as a message, so the thread looked empty). */
async function inboxAppend(env: Env, recipient: string, sender: string, conv: string, envelope: string, mediaRef: string | null): Promise<void> {
  const stub = (env as any).INBOX.get((env as any).INBOX.idFromName(recipient));
  // No `scope` → thread-scoped (audience null), i.e. a NORMAL DM message. We already
  // write a separate copy to each party's own InboxDO, so per-recipient privacy
  // scoping isn't needed — and an unscoped message is what the app's sync/chat-list
  // reliably surfaces (a `to:<uid>` private scope was an extra failure surface).
  try {
    const res = await stub.fetch("https://inbox/append", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conv, sender, kind: "text", body: envelope, media_ref: mediaRef, created_at: Date.now(), owner: recipient }),
    });
    const out: any = await res.json().catch(() => ({}));
    // Definitive proof the row landed in the recipient's InboxDO (msg_id) vs a
    // silent failure — distinguishes "delivery broken" from "app didn't render".
    // `live` (from the InboxDO append) = was the recipient's socket connected at
    // delivery, i.e. did the deal get broadcast in realtime. false ⇒ it only
    // sits in storage until a resync pulls it — the exact case the client-side
    // bounded forceResync() after Contact-agent now covers (no FCM).
    track(env, recipient, "mkt_inbox_appended", "avamarketplace", { ok: res.ok, status: res.status, msg_id: out?.id ?? null, live: out?.live ?? null, recipient, sender, conv });
  } catch (e) {
    track(env, recipient, "mkt_inbox_append_error", "avamarketplace", { recipient, conv, error: String((e as any)?.message ?? e).slice(0, 160) });
    throw e;
  }
}

/**
 * Render the deal audio (both outcomes) and drop the voice note into BOTH the
 * seller's and buyer's chat threads, colour-coded by outcome, then FCM-push both.
 * Best-effort: if TTS fails, still delivers a text message carrying the outcome.
 */
// Per-category negotiation profile: caps SPOKEN length (voice cost + max-talk
// rule) and sets the agents' tone.
//
// The live `listings.kind` values are: live_event | consult | sell | buy | social.
// ALL of them fall through to the brief buy/sell profile below — that is intended,
// not an oversight. The dating/matrimony branch is RESERVED for future categories
// and is unreachable until a listing can actually be created with one of those
// kinds; don't "fix" it by inventing kinds that no listing has.
//
// Add new categories here — same pipeline, different knob. Callers MUST select
// `kind` in their listing row query, or every negotiation silently gets the default.
function negotiationProfile(kind: string): { maxWords: number; maxSeconds: number; tone: string } {
  switch (kind) {
    case "dating":     // reserved — not a current listings.kind value
    case "matrimony":  // reserved — not a current listings.kind value
      return { maxWords: 85, maxSeconds: 35, tone: "warm, expressive, curious and a little playful/flirty where appropriate; ask a question or two" };
    default: // sell | buy | social | live_event | …
      return { maxWords: 60, maxSeconds: 25, tone: "brief and businesslike" };
  }
}

// ── MKT-LANG: English-canonical negotiation helpers ──────────────────────────
/** BCP-47 code → English language name (for the translate prompt + TTS preamble).
 *  Kept in sync with the AGENT_LANGS allowlist in agent_settings.ts. */
const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", hi: "Hindi", fr: "French", de: "German",
  pt: "Portuguese", ar: "Arabic", zh: "Chinese", ja: "Japanese", ru: "Russian",
  id: "Indonesian", ur: "Urdu", bn: "Bengali", sw: "Swahili", tr: "Turkish", vi: "Vietnamese",
};
export function langName(code: string): string {
  return LANG_NAMES[String(code || "en").toLowerCase()] || "English";
}

/** Map a tone key → a short prompt hint injected into the negotiation system prompt. */
function toneHint(tone: string): string {
  switch (tone) {
    case "professional": return "formal, precise and businesslike";
    case "brief": return "extremely concise — as few words as possible while still closing";
    default: return "warm, friendly and approachable"; // friendly
  }
}

/** Is `now` inside the [start,end) quiet-hours window (both "HH:MM", local-agnostic
 *  UTC minutes)? Handles windows that wrap past midnight. Empty window → false. */
export function inQuietHours(quietStart: string | null, quietEnd: string | null, now = new Date()): boolean {
  if (!quietStart || !quietEnd) return false;
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const start = toMin(quietStart), end = toMin(quietEnd);
  if (start === end) return false;
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** Translate a negotiation transcript + bubble/summary text to `targetLang` in ONE
 *  LLM call, preserving the Speaker: prefixes. Returns null on any failure (caller
 *  keeps the English original). */
async function translateNegotiation(
  env: Env,
  target: string,
  transcript: Array<{ speaker: string; text: string }>,
  summary: string,
): Promise<{ transcript: Array<{ speaker: string; text: string }>; summary: string } | null> {
  if (target === "en" || !transcript.length) return null;
  const name = langName(target);
  const sys =
    `You translate a short marketplace negotiation into ${name}. Keep the JSON shape EXACTLY. ` +
    `Preserve the "speaker" values verbatim (they are "Seller" or "Buyer" — do NOT translate them). ` +
    `Translate ONLY the "text" fields and the "summary". Natural, conversational ${name}. ` +
    `Output ONLY the JSON, no prose.`;
  const payload = JSON.stringify({ summary, transcript });
  const raw = await callSonnet(env, sys, payload, 900);
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const outT = Array.isArray(j.transcript)
      ? j.transcript.filter((t: any) => t && t.text).map((t: any) => ({ speaker: String(t.speaker || "Agent"), text: String(t.text) }))
      : [];
    if (!outT.length) return null;
    return { transcript: outT, summary: String(j.summary || summary) };
  } catch {
    return null;
  }
}

/** Cap the ENGLISH transcript to the category's spoken-length budget BEFORE
 *  translation (voice cost + max-talk rule). Keeps the opening exchange + closing
 *  line when the transcript is long, mirroring the old TTS-side cap but applied to
 *  the canonical English so EVERY language render is bounded identically. */
function capTranscriptForSpeech(transcript: Array<{ speaker: string; text: string }>): Array<{ speaker: string; text: string }> {
  return transcript.length > 6 ? [...transcript.slice(0, 5), transcript[transcript.length - 1]] : transcript;
}

async function deliverDealAudio(env: Env, a: {
  sellerUid: string; buyerUid: string; listingId: string; listingTitle: string;
  outcome: string; bubble: string; agreed: number; currency: string;
  transcript: Array<{ speaker: string; text: string }>;
  persona?: string;
  // MKT-LANG: the buyer-language render. `lang` (=buyerLang) drives the TTS
  // "Speak in <language>." preamble; `transcript` here is ALREADY in the buyer's
  // language (translated + capped). `buyerVoice` is the buyer's chosen Gemini
  // voice (consumer falls back to Aoede). `transcriptI18n` caches translations so
  // reopens never re-translate.
  lang?: string; buyerVoice?: string | null;
  transcriptEn?: Array<{ speaker: string; text: string }>;
  transcriptI18n?: Record<string, Array<{ speaker: string; text: string }>>;
  summary?: string; pendingOwnerApproval?: boolean;
}): Promise<{ audioKey: string | null; bytes: number; queued?: boolean }> {
  const conv = dmConvId(a.sellerUid, a.buyerUid);
  // CREATE the DM thread so it appears in the buyer's chat list.
  await ensureDmThread(env, a.sellerUid, a.buyerUid, `event:${a.listingId}`);
  // TWO-MESSAGE FLOW (owner decision 2026-07-01): NO "No audio" text card. Message
  // 1 is the buyer's optimistic "your agents are negotiating (may take up to an
  // hour)" bubble (client-side). Message 2 is the VOICE card only, delivered by the
  // avatok-consumers render (buyer-only for now). So here we do NOT deliver a text
  // result card — we only enqueue the voice render below.
  track(env, a.buyerUid, "deal_reached", "avamarketplace", { listing_id: a.listingId, outcome: a.outcome });

  // ── PHASE 2: ENQUEUE the voice render (async → avatok-consumers `mkt-audio`).
  // The Gemini multi-speaker TTS of a FULL multi-round transcript takes 30-60s,
  // which does NOT fit this request's background budget — running it inline got
  // the job reaped → "No audio". The consumer renders the FULL transcript with
  // its own per-message budget, uploads the WAV, and appends the voice card to
  // both InboxDOs + nudges the live thread. Robust at scale: renders fan out over
  // the queue instead of hanging request paths. The text card (phase 1) already
  // landed, so a slow/failed replay is never fatal.
  let queued = false;
  try {
    await (env as any).Q_MKT_AUDIO?.send({
      conv, sellerUid: a.sellerUid, buyerUid: a.buyerUid, listingId: a.listingId,
      outcome: a.outcome, bubble: a.bubble, agreed: a.agreed, currency: a.currency,
      transcript: a.transcript, persona: a.persona, enqueuedAt: Date.now(),
      // MKT-LANG-4: buyer language + buyer voice + i18n cache + English canonical.
      lang: a.lang || "en", buyerVoice: a.buyerVoice || null,
      transcriptEn: a.transcriptEn, transcriptI18n: a.transcriptI18n,
      summary: a.summary, pendingOwnerApproval: a.pendingOwnerApproval === true,
    });
    queued = true;
  } catch { /* best-effort; text card already delivered */ }
  return { audioKey: null as string | null, bytes: 0, queued };
}

// ── P3: AI writing help ──────────────────────────────────────────────────────
// want = instructions | title | description. `fields` carries the form so far.
export async function marketplaceAiAssist(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const want = String(b.want || "instructions");
  const kind = String(b.kind || "sell");
  const f = (b.fields ?? {}) as Record<string, unknown>;

  const ctxLine =
    `Listing type: ${kind}. Title: ${f.title ?? ""}. Category: ${f.category ?? ""}. ` +
    `Description: ${f.description ?? ""}. Price: ${f.price_amount ?? ""} ${f.price_currency ?? ""}. ` +
    `Location: ${f.location ?? ""}.`;

  let system: string;
  if (want === "title") {
    system =
      "You write short, honest marketplace listing TITLES (max 8 words). No phone numbers, " +
      "emails, emojis, ALL-CAPS or hype. Output only the title text.";
  } else if (want === "description") {
    system =
      "You write clear, honest marketplace DESCRIPTIONS (2-4 short sentences). Never invent facts. " +
      "Never include phone numbers, emails or off-platform contact details. Output only the description.";
  } else {
    system =
      "You write a short INSTRUCTION a person gives their negotiation agent for a marketplace listing. " +
      "Cover their price stance (floor/target for sellers, max for buyers), key facts to mention, and tone. " +
      "2-4 sentences, first person ('You represent me...'). No contact details. Output only the instruction.";
  }

  const text = await callSonnet(env, system, ctxLine, want === "title" ? 40 : 250);
  track(env, ctx.uid, "listing_ai_assist_used", "avamarketplace", { want, kind, ok: text.length > 0 });
  if (!text) return json({ error: "ai_unavailable" }, 503);
  return json({ ok: true, text });
}

// ── P5: agent↔agent negotiation ──────────────────────────────────────────────
// Idempotent ledger so a buyer can negotiate a listing only once PER CONTENT
// VERSION (an owner edit bumps the version and reopens the door — Specs §3 B).
async function ensureLedger(env: Env): Promise<void> {
  await metaDb(env).prepare(
    `CREATE TABLE IF NOT EXISTS mkt_negotiations (
       buyer_id TEXT, listing_id TEXT, content_version INTEGER,
       outcome TEXT, agreed_price INTEGER, currency TEXT, created_at INTEGER,
       PRIMARY KEY (buyer_id, listing_id, content_version)
     )`,
  ).run();
  // P5: index the daily-cap count query (per buyer, by day).
  await metaDb(env).prepare(
    "CREATE INDEX IF NOT EXISTS idx_mkt_neg_buyer_created ON mkt_negotiations (buyer_id, created_at)",
  ).run();
}

export async function marketplaceNegotiateState(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ already_talked: false }, 200);
  const u = new URL(req.url);
  const listingId = u.searchParams.get("listing_id") ?? "";
  const version = Number(u.searchParams.get("content_version") ?? "0");
  await ensureLedger(env);
  const row = await metaDb(env).prepare(
    "SELECT 1 FROM mkt_negotiations WHERE buyer_id=?1 AND listing_id=?2 AND content_version=?3",
  ).bind(ctx.uid, listingId, version).first<any>();
  return json({ already_talked: !!row });
}

export async function marketplaceNegotiate(req: Request, env: Env, exctx?: ExecutionContext): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const listingId = String(b.listing_id || "");
  const version = Number(b.content_version || 0);
  const buyerMax = Math.max(0, Math.trunc(Number(b.buyer_max) || 0));
  const currency = String(b.currency || "USD");
  const mustHaves = String(b.must_haves || "");
  if (!listingId) return json({ error: "listing_id required" }, 400);

  const listing = await metaDb(env).prepare(
    // `kind` is REQUIRED here: runNegotiationJob feeds it to negotiationProfile(),
    // which caps the spoken transcript length. Omitting it silently degrades every
    // negotiation to the default profile.
    "SELECT id, creator_id, kind, title, description, price, currency_display, status, agent_instructions, agent_lang, agent_voice_persona FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing) return json({ error: "not found" }, 404);
  if (listing.creator_id === ctx.uid) return json({ error: "own_listing" }, 400);

  // MKT-LANG-3: quiet-hours guardrail. If the BUYER has quiet hours set and we're
  // inside that window, defer — do NOT start the agent call. The client renders a
  // friendly deferral card from this response (no slot reserved, so they can retry
  // later). Gated by the mktI18nNegotiationEnabled flag (off → skip the gate).
  const cfgQ = await readConfig(env);
  if ((cfgQ as any).mktI18nNegotiationEnabled !== false) {
    const buyerSet = await getAgentSettings(env, ctx.uid).catch(() => null);
    if (buyerSet && inQuietHours(buyerSet.quiet_start, buyerSet.quiet_end)) {
      track(env, ctx.uid, "agent_call_deferred_quiet_hours", "avamarketplace", {
        listing_id: listingId, quiet_start: buyerSet.quiet_start, quiet_end: buyerSet.quiet_end,
      });
      return json({
        ok: false, deferred: true, reason: "quiet_hours",
        quiet_start: buyerSet.quiet_start, quiet_end: buyerSet.quiet_end,
        message: "Your agent is resting during your quiet hours. Try again after they end.",
      }, 200);
    }
  }

  await ensureLedger(env);
  const seen = await metaDb(env).prepare(
    "SELECT 1 FROM mkt_negotiations WHERE buyer_id=?1 AND listing_id=?2 AND content_version=?3",
  ).bind(ctx.uid, listingId, version).first<any>();
  if (seen) {
    track(env, ctx.uid, "agent_call_blocked_already_talked", "avamarketplace", { listing_id: listingId, content_version: version });
    return json({ ok: false, already_talked: true }, 200);
  }

  // P5: per-user daily cap on DISTINCT listings negotiated today (UTC). The
  // per-listing dedupe above already returned for a re-open, so this only counts
  // NEW distinct listings. Cap is a KV-tunable flag (no redeploy). cap<=0 disables.
  {
    const cap = Math.max(0, Math.trunc(Number((await readConfig(env)).agentDailyCap ?? 10)));
    if (cap > 0) {
      const dayStartMs = Math.floor(Date.now() / 86_400_000) * 86_400_000; // UTC midnight
      const usedRow = await metaDb(env).prepare(
        "SELECT COUNT(DISTINCT listing_id) AS n FROM mkt_negotiations WHERE buyer_id=?1 AND created_at>=?2",
      ).bind(ctx.uid, dayStartMs).first<{ n: number }>();
      const used = usedRow?.n ?? 0;
      if (used >= cap) {
        const resetsAt = new Date(dayStartMs + 86_400_000).toISOString();
        track(env, ctx.uid, "agent_daily_limit_hit", "avamarketplace", { listing_id: listingId, used, cap });
        return json({ error: "agent_daily_limit", used, cap, resets_at: resetsAt }, 429);
      }
    }
  }

  // Reserve the talk-once slot NOW (outcome 'pending') so repeat taps are blocked
  // immediately — even while the slow negotiation runs in the background.
  await metaDb(env).prepare(
    "INSERT OR REPLACE INTO mkt_negotiations (buyer_id, listing_id, content_version, outcome, agreed_price, currency, created_at) VALUES (?1,?2,?3,'pending',0,?4,?5)",
  ).bind(ctx.uid, listingId, version, currency, Date.now()).run();
  track(env, ctx.uid, "negotiation_started", "avamarketplace", { listing_id: listingId });

  // The negotiation (Sonnet ~8s) + voice render (Gemini TTS ~up to 30s) + delivery
  // is SLOW. If we ran it inline, a client disconnect (the app sends the user back
  // to browsing) kills the worker mid-render and NOTHING reaches the chat thread —
  // exactly the "no negotiation appeared" bug. Run it in the background via
  // waitUntil so it always completes and lands in both threads. Respond instantly.
  const work = runNegotiationJob(env, {
    listing, buyerUid: ctx.uid, listingId, version, buyerMax, currency, mustHaves,
  });
  if (exctx && typeof exctx.waitUntil === "function") exctx.waitUntil(work);
  else await work; // fallback: no ctx (e.g. tests) → run inline
  return json({ ok: true, queued: true });
}

/** The heavy negotiation job — runs in the background (waitUntil). */
async function runNegotiationJob(env: Env, a: {
  listing: any; buyerUid: string; listingId: string; version: number;
  buyerMax: number; currency: string; mustHaves: string;
}): Promise<void> {
  const { listing, buyerUid, listingId, version, buyerMax, currency, mustHaves } = a;
  try {
    const asking = Math.trunc(Number(listing.price) || 0);
    const mandate = String(listing.agent_instructions || "").slice(0, 1200);

    // ── MKT-LANG-3: resolve languages, names, tone, and guardrails ────────────
    // buyerLang = the BUYER's marketplace_agent_settings.lang (default en).
    // sellerLang = listing.agent_lang if set, else the SELLER's settings.lang, else en.
    // The i18n path is flag-gated; when off we behave English-canonical with no
    // translation (buyer/seller both read the English transcript).
    const cfg = await readConfig(env);
    const i18nOn = (cfg as any).mktI18nNegotiationEnabled !== false;
    const sellerUid = String(listing.creator_id);
    const buyerSet: AgentSettings = await getAgentSettings(env, buyerUid).catch(() => null as any) || null as any;
    const sellerSet: AgentSettings = await getAgentSettings(env, sellerUid).catch(() => null as any) || null as any;
    const buyerLang = (i18nOn && buyerSet ? String(buyerSet.lang || "en") : "en").toLowerCase();
    const listingLang = String(listing.agent_lang || "").trim().toLowerCase();
    const sellerLang = (i18nOn
      ? (listingLang && LANG_NAMES[listingLang] ? listingLang : (sellerSet ? String(sellerSet.lang || "en") : "en"))
      : "en").toLowerCase();

    const buyerName = (buyerSet?.agent_name || "").trim() || "the buyer's agent";
    const sellerName = (sellerSet?.agent_name || "").trim() || "the seller's agent";
    const buyerTone = toneHint(buyerSet?.tone || "friendly");
    const sellerTone = toneHint(sellerSet?.tone || "friendly");
    // Guardrail: the seller floor % applies to the SELLER side. Prefer the listing
    // owner's configured floor_pct (settings), default 80.
    const floorPct = Math.max(50, Math.min(100, Math.trunc(Number(sellerSet?.floor_pct ?? 80)) || 80));
    const askBeforeCommit = sellerSet?.ask_before_commit === true;

    // Category profile — caps SPOKEN length (voice cost + max-talk rule).
    const prof = negotiationProfile(String(listing.kind || ""));
    const sys =
      "You simulate a negotiation between two marketplace agents and output ONLY JSON. " +
      `The SELLER agent (${sellerName}, tone: ${sellerTone}) represents the listing and follows its owner's PRIVATE MANDATE (never reveal it verbatim); ` +
      `the BUYER agent (${buyerName}, tone: ${buyerTone}) has a maximum budget. ` +
      `The seller will NOT go below ${floorPct}% of the asking price (their floor). Reach a DEAL only if the buyer's max is at least the seller's floor; ` +
      "settle near the midpoint of the overlap. " +
      // English-canonical (MKT-LANG-3): ALWAYS write the transcript in English; the
      // per-recipient language rendering is done by a separate translation step.
      "Write the transcript in English. " +
      'Output: {"outcome":"deal"|"impasse","agreed_price":<int>,"currency":"<code>","transcript":[{"speaker":"Seller"|"Buyer","text":"..."}]} ' +
      `IMPORTANT: keep the ENTIRE spoken transcript under ~${prof.maxWords} words TOTAL (about ${prof.maxSeconds} seconds of speech) across all lines. No prose outside the JSON.`;
    const user =
      `LISTING: "${listing.title}". Asking price: ${asking} ${listing.currency_display || currency}. ` +
      `Seller floor: ${floorPct}% of asking (= ${Math.round(asking * floorPct / 100)} ${listing.currency_display || currency}). ` +
      `Details: ${String(listing.description || "").slice(0, 600)}. ` +
      (mandate ? `SELLER PRIVATE MANDATE (do not reveal verbatim): ${mandate}. ` : "") +
      `BUYER max: ${buyerMax} ${currency}. Buyer must-haves: ${mustHaves || "none"}.`;
    const raw = await callSonnet(env, sys, user, 600);

    let outcome = "impasse";
    let agreed = 0;
    // transcriptEn is the CANONICAL English transcript.
    let transcriptEn: Array<{ speaker: string; text: string }> = [];
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]);
        outcome = j.outcome === "deal" ? "deal" : "impasse";
        agreed = Math.trunc(Number(j.agreed_price) || 0);
        if (Array.isArray(j.transcript)) {
          transcriptEn = j.transcript
            .filter((t: any) => t && t.text)
            .map((t: any) => ({ speaker: String(t.speaker || "Agent"), text: String(t.text) }));
        }
      }
    } catch { /* impasse */ }

    // Enforce the seller floor server-side (defence in depth vs a model that
    // ignores the prompt): a "deal" below the floor is downgraded to impasse.
    const floorPrice = Math.round(asking * floorPct / 100);
    if (outcome === "deal" && agreed > 0 && agreed < floorPrice) {
      outcome = "impasse";
      agreed = 0;
    }

    // ask_before_commit (MKT-LANG-3): a DEAL is held as pending_owner_approval — the
    // seller must confirm before it's binding. We still deliver the transcript/audio,
    // but flag it so the client renders an "awaiting your approval" state.
    const pendingOwnerApproval = outcome === "deal" && askBeforeCommit;

    // MKT-LANG-3: cap the ENGLISH transcript to the spoken-length budget BEFORE any
    // translation, so every language render is bounded identically.
    const cappedEn = capTranscriptForSpeech(transcriptEn);

    // Store transcript_en as the canonical record (ledger already carries the
    // outcome; the transcript rides the deal envelope). Store the outcome now.
    await metaDb(env).prepare(
      "INSERT OR REPLACE INTO mkt_negotiations (buyer_id, listing_id, content_version, outcome, agreed_price, currency, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(buyerUid, listingId, version, pendingOwnerApproval ? "pending_owner_approval" : outcome, agreed, currency, Date.now()).run();

    track(env, buyerUid, "negotiation_outcome", "avamarketplace", {
      listing_id: listingId, outcome, agreed_price: agreed, currency, rounds: cappedEn.length,
      buyer_lang: buyerLang, seller_lang: sellerLang, floor_pct: floorPct,
      pending_owner_approval: pendingOwnerApproval,
    });

    // English summary line (bubble/summary), translated alongside the transcript.
    const summaryEn = outcome === "deal"
      ? `The agents agreed at about ${agreed} ${currency}.`
      : "The agents talked but did not reach a deal this time.";

    // ── MKT-LANG-3: translate to the BUYER's language (one LLM call), cache it in
    // the i18n map so reopens never re-translate. English → no-op. Seller card text
    // is translated separately below (for the notify body) when sellerLang!=en.
    const transcriptI18n: Record<string, Array<{ speaker: string; text: string }>> = { en: cappedEn };
    let buyerTranscript = cappedEn;
    let buyerSummary = summaryEn;
    if (i18nOn && buyerLang !== "en") {
      const tr = await translateNegotiation(env, buyerLang, cappedEn, summaryEn);
      if (tr) {
        buyerTranscript = tr.transcript;
        buyerSummary = tr.summary;
        transcriptI18n[buyerLang] = tr.transcript;
      }
    }
    // Seller-side text card (for the bell notify body) when the seller reads a
    // non-English language and it differs from the buyer's.
    let sellerSummary = summaryEn;
    if (i18nOn && sellerLang !== "en") {
      if (sellerLang === buyerLang) {
        sellerSummary = buyerSummary;
      } else {
        const trS = await translateNegotiation(env, sellerLang, cappedEn, summaryEn);
        if (trS) { sellerSummary = trS.summary; transcriptI18n[sellerLang] = trS.transcript; }
      }
    }
    if (i18nOn && (buyerLang !== "en" || sellerLang !== "en")) {
      const contact = await contactFor(env, buyerUid).catch(() => ({ email: null, phone: null }));
      const chars = cappedEn.reduce((n, t) => n + t.text.length, 0) + summaryEn.length;
      trackUserContact(env, buyerUid, contact.email, contact.phone, "mkt_negotiation_translated", "avamarketplace", {
        buyer_lang: buyerLang, seller_lang: sellerLang, chars,
      });
    }

    // RULE (owner 2026-06-30): render the deal-audio voice note for BOTH outcomes
    // and drop it into both chat threads, colour-coded — DEAL = green, IMPASSE =
    // pale yellow. Gemini 2.5 multi-speaker TTS → WAV in R2 → voice message in each
    // user's InboxDO thread → FCM push (reuses the receptionist delivery pattern).
    // The buyer-language transcript (buyerTranscript) is what the consumer TTS's;
    // the buyer's chosen voice drives the buyer speaker.
    const bubble = outcome === "deal" ? "green" : "pale_yellow";
    const delivery = await deliverDealAudio(env, {
      sellerUid, buyerUid, listingId,
      listingTitle: String(listing.title || "your listing"),
      outcome, bubble, agreed, currency,
      transcript: buyerTranscript,
      persona: String(listing.agent_voice_persona || ""),
      lang: buyerLang, buyerVoice: buyerSet?.voice || null,
      transcriptEn: cappedEn, transcriptI18n, summary: buyerSummary,
      pendingOwnerApproval,
    });
    // Audio is now rendered ASYNC by avatok-consumers (mkt-audio queue); this just
    // records that the render was enqueued. The consumer emits mkt_audio_delivered
    // / mkt_audio_render_failed with the actual result + bytes.
    track(env, buyerUid, "deal_audio_queued", "avamarketplace", {
      listing_id: listingId, outcome, bubble, queued: (delivery as any).queued === true,
    });
    // Also a bell notification so it shows in the notifications list, not just the
    // thread. Bodies use each party's language summary (MKT-LANG-3). When the deal
    // is held for owner approval, tell the seller it awaits them.
    try {
      // push:false — bell entry only, NO FCM (delivered live over socket + PartyKit).
      const sellerBody = pendingOwnerApproval
        ? (sellerLang !== "en" ? sellerSummary : `A buyer's agent reached a deal around ${agreed} ${currency} — it's awaiting your approval.`)
        : sellerSummary;
      await notifyUser(env, sellerUid, { type: "marketplace_deal", title: outcome === "deal" ? (pendingOwnerApproval ? "A deal awaits your approval" : "A buyer's agent reached a deal") : "A buyer's agent negotiated your listing", body: sellerBody, data: { listing_id: listingId, outcome, bubble, pending_owner_approval: pendingOwnerApproval } }, { push: false });
      await notifyUser(env, buyerUid, { type: "marketplace_deal", title: outcome === "deal" ? (pendingOwnerApproval ? "Deal reached — awaiting the seller" : "Your agent reached a deal") : "Your agent finished negotiating", body: buyerSummary, data: { listing_id: listingId, outcome, bubble, pending_owner_approval: pendingOwnerApproval } }, { push: false });
    } catch { /* notify best-effort */ }
  } catch (e) {
    // A rare failure shouldn't burn the buyer's single chance — release the slot
    // (only if it's still 'pending', i.e. never produced an outcome) so they can retry.
    try {
      await metaDb(env).prepare(
        "DELETE FROM mkt_negotiations WHERE buyer_id=?1 AND listing_id=?2 AND content_version=?3 AND outcome='pending'",
      ).bind(buyerUid, listingId, version).run();
    } catch { /* ignore */ }
    track(env, buyerUid, "negotiation_failed", "avamarketplace", { listing_id: listingId, error: String((e as any)?.message ?? e).slice(0, 200) });
  }
}
// ── P6: AI search over active listings ────────────────────────────────────────
// ONE shared marketplace index (owner rule: no per-user AI Search instances).
// Today this delegates to the single shared FTS5 index behind /api/explore/search
// so search works now; the documented upgrade is to point this at one Cloudflare
// AI Search index (env.AI_SEARCH binding) for semantic ranking without changing
// the client contract.
export async function marketplaceSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim();
  // AI query expansion (Sonnet) → synonyms/brands/category, OR'd into the FTS
  // match for broad recall — makes keyword search feel semantic.
  let expanded = q;
  if (q) {
    const syn = await callSonnet(
      env,
      "Expand a marketplace search query into 3-6 closely related search keywords (synonyms, common brands, the category). Output ONLY a comma-separated list, nothing else.",
      q, 40,
    );
    if (syn) expanded = `${q} ${syn.replace(/[,\n]+/g, " ")}`.slice(0, 200);
  }
  // Rebuild the request for exploreSearch with the expanded query + market filter,
  // preserving auth headers so viewer/block-filter context still works.
  const target = new URL(req.url);
  if (expanded) target.searchParams.set("q", expanded);
  target.searchParams.set("market", "1");
  const t0 = Date.now();
  const res = await exploreSearch(new Request(target.toString(), req), env);
  try {
    track(env, "guest", "marketplace_search", "avamarketplace", { query_len: q.length, ai_search_ms: Date.now() - t0, expanded: expanded !== q });
  } catch { /* ignore */ }
  return res;
}
// ── P7: safety precheck (text moderation + PII strip) ─────────────────────────
// Defence-in-depth before publish. Server-side createListing already runs the
// Nemotron gate on title/description; this also strips contact details (phone /
// email, including obfuscated forms) from the description so contact stays in
// AvaTOK. Image NSFW screening runs in the upload path (vision classifier);
// CSAM hash-matching is the deferred P8 hard gate. Reject-with-reason here.
export async function marketplacePrecheck(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const title = String(b.title || "").slice(0, 400);
  const description = String(b.description || "").slice(0, 4000);
  const t0 = Date.now();

  // 1) text moderation (porn / scam / hate / etc.) — title + description in
  //    parallel so the submit gate isn't two sequential round-trips (pic 4).
  const [tMod, dMod] = await Promise.all([
    moderate(env, { text: title, field: "listing_title" }),
    description.trim() ? moderate(env, { text: description, field: "listing_desc" }) : Promise.resolve({ safe: true } as any),
  ]);
  if (!tMod.safe) {
    track(env, ctx.uid, "listing_rejected", "avamarketplace", { failing_check: "text_title", precheck_ms: Date.now() - t0 });
    return json({ ok: false, reason: tMod.reason || "Title isn’t allowed.", failing_check: "title" }, 200);
  }
  if (!dMod.safe) {
    track(env, ctx.uid, "listing_rejected", "avamarketplace", { failing_check: "text_desc", precheck_ms: Date.now() - t0 });
    return json({ ok: false, reason: dMod.reason || "Description isn’t allowed.", failing_check: "description" }, 200);
  }

  // 2) PII strip — remove phone numbers + emails, including obfuscated forms.
  //    LLM beats regex on "nine-eight-seven…" / "name [at] gmail dot com"; a
  //    regex backstop catches the obvious cases. Short 8s timeout so a slow/
  //    unavailable model can't stall the submit — the regex backstop still runs.
  let cleaned = description;
  if (description.trim()) {
    const out = await callSonnet(
      env,
      "You redact contact details from marketplace text. Remove ALL phone numbers and email addresses, " +
        "including obfuscated forms (spelled-out digits, 'at'/'dot', spaces or unicode look-alikes). Keep " +
        "everything else exactly as written. Output ONLY the cleaned text, no commentary.",
      description,
      400,
      8000,
    );
    cleaned = (out && out.length > 0 ? out : description)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[removed]")
      .replace(/(?:\+?\d[\s().-]?){7,}\d/g, "[removed]");
  }
  const stripped = cleaned !== description;
  track(env, ctx.uid, "moderation_pii_stripped", "avamarketplace", { changed: stripped, precheck_ms: Date.now() - t0 });
  return json({ ok: true, cleaned_description: cleaned, pii_stripped: stripped });
}

// ── Deal-audio stream — authed playback of a rendered negotiation voice note ───
// GET /api/marketplace/audio?key=mkt/deal/...   (the key from the chat envelope)
export async function marketplaceAudio(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return new Response("unauthorized", { status: 401 });
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key.startsWith("mkt/deal/")) return new Response("bad key", { status: 400 });
  const obj = await (env as any).BLOBS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  // Serve the object's stored type (new deals are .mp3, older ones .wav).
  const ct = obj.httpMetadata?.contentType || (key.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
  return new Response(obj.body, {
    headers: { "content-type": ct, "cache-control": "private, max-age=86400" },
  });
}
