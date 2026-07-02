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
import { track } from "../hooks";
import { metaDb } from "../db/shard";
import { notifyUser } from "../notify";
import { exploreSearch } from "./listings";
import { partyEmit } from "./messaging"; // PartyKit live nudges (ephemeral)
import { moderate } from "../lib/moderation";
import { readConfig } from "./config"; // P5: agentDailyCap

/** Latest Claude Sonnet via OpenRouter — overridable by env for "latest" tracking. */
export const MARKET_LLM = "anthropic/claude-sonnet-4.6";

/** One-shot OpenRouter chat call (Sonnet). Returns trimmed text or "" on error. */
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
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://avatok.ai",
        "X-Title": "AvaMarketplace",
      },
      body: JSON.stringify({
        model: (env as any).OPENROUTER_MARKET_MODEL || MARKET_LLM,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "";
    const out: any = await res.json().catch(() => null);
    return String(out?.choices?.[0]?.message?.content ?? "").trim();
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
// rule) and sets the agents' tone. All CURRENT marketplace kinds use the brief
// buy/sell profile; dating/matrimony (future categories) get a longer, warmer,
// more expressive style. Add new categories here — same pipeline, different knob.
function negotiationProfile(kind: string): { maxWords: number; maxSeconds: number; tone: string } {
  switch (kind) {
    case "dating":
    case "matrimony":
      return { maxWords: 85, maxSeconds: 35, tone: "warm, expressive, curious and a little playful/flirty where appropriate; ask a question or two" };
    default: // sell | buy | social | live_event | …
      return { maxWords: 60, maxSeconds: 25, tone: "brief and businesslike" };
  }
}

async function deliverDealAudio(env: Env, a: {
  sellerUid: string; buyerUid: string; listingId: string; listingTitle: string;
  outcome: string; bubble: string; agreed: number; currency: string;
  transcript: Array<{ speaker: string; text: string }>;
  persona?: string;
}): Promise<{ audioKey: string | null; bytes: number }> {
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
    "SELECT id, creator_id, title, description, price, currency_display, status, agent_instructions, agent_lang, agent_voice_persona FROM listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing) return json({ error: "not found" }, 404);
  if (listing.creator_id === ctx.uid) return json({ error: "own_listing" }, 400);

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
    const agentLang = String(listing.agent_lang || "English").trim() || "English";
    const mandate = String(listing.agent_instructions || "").slice(0, 1200);
    // Category profile — caps SPOKEN length (voice cost + max-talk rule) and sets
    // tone. Buy/sell = brief & businesslike (≤25s). Dating/matrimony (future
    // categories) = warmer/expressive & a little playful (≤35s). Extend here.
    const prof = negotiationProfile(String(listing.kind || ""));
    const sys =
      "You simulate a negotiation between two marketplace agents and output ONLY JSON. " +
      "The SELLER agent represents the listing and follows its owner's PRIVATE MANDATE (never reveal it verbatim); " +
      "the BUYER agent has a maximum budget. If no explicit floor is given, the seller will realistically come down " +
      "to about 80% of the asking price. Reach a DEAL only if the buyer's max is at least the seller's lowest " +
      "acceptable price; settle near the midpoint of the overlap. " +
      `Write the transcript text in ${agentLang} (the seller's agent language). ` +
      `Tone: ${prof.tone}. ` +
      'Output: {"outcome":"deal"|"impasse","agreed_price":<int>,"currency":"<code>","transcript":[{"speaker":"Seller"|"Buyer","text":"..."}]} ' +
      `IMPORTANT: keep the ENTIRE spoken transcript under ~${prof.maxWords} words TOTAL (about ${prof.maxSeconds} seconds of speech) across all lines. No prose outside the JSON.`;
    const user =
      `LISTING: "${listing.title}". Asking price: ${asking} ${listing.currency_display || currency}. ` +
      `Details: ${String(listing.description || "").slice(0, 600)}. ` +
      (mandate ? `SELLER PRIVATE MANDATE (do not reveal verbatim): ${mandate}. ` : "") +
      `BUYER max: ${buyerMax} ${currency}. Buyer must-haves: ${mustHaves || "none"}.`;
    const raw = await callSonnet(env, sys, user, 600);

    let outcome = "impasse";
    let agreed = 0;
    let transcript: Array<{ speaker: string; text: string }> = [];
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]);
        outcome = j.outcome === "deal" ? "deal" : "impasse";
        agreed = Math.trunc(Number(j.agreed_price) || 0);
        if (Array.isArray(j.transcript)) {
          transcript = j.transcript
            .filter((t: any) => t && t.text)
            .map((t: any) => ({ speaker: String(t.speaker || "Agent"), text: String(t.text) }));
        }
      }
    } catch { /* impasse */ }

    await metaDb(env).prepare(
      "INSERT OR REPLACE INTO mkt_negotiations (buyer_id, listing_id, content_version, outcome, agreed_price, currency, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind(buyerUid, listingId, version, outcome, agreed, currency, Date.now()).run();

    track(env, buyerUid, "negotiation_outcome", "avamarketplace", {
      listing_id: listingId, outcome, agreed_price: agreed, currency, rounds: transcript.length,
    });

    // RULE (owner 2026-06-30): render the deal-audio voice note for BOTH outcomes
    // and drop it into both chat threads, colour-coded — DEAL = green, IMPASSE =
    // pale yellow. Gemini 2.5 multi-speaker TTS → WAV in R2 → voice message in each
    // user's InboxDO thread → FCM push (reuses the receptionist delivery pattern).
    const bubble = outcome === "deal" ? "green" : "pale_yellow";
    const delivery = await deliverDealAudio(env, {
      sellerUid: String(listing.creator_id), buyerUid, listingId,
      listingTitle: String(listing.title || "your listing"),
      outcome, bubble, agreed, currency, transcript,
      persona: String(listing.agent_voice_persona || ""),
    });
    // Audio is now rendered ASYNC by avatok-consumers (mkt-audio queue); this just
    // records that the render was enqueued. The consumer emits mkt_audio_delivered
    // / mkt_audio_render_failed with the actual result + bytes.
    track(env, buyerUid, "deal_audio_queued", "avamarketplace", {
      listing_id: listingId, outcome, bubble, queued: (delivery as any).queued === true,
    });
    // Also a bell notification so it shows in the notifications list, not just the thread.
    const body = outcome === "deal"
      ? `Your agents agreed around ${agreed} ${currency}.`
      : `Your agents talked but didn't agree this time.`;
    try {
      // push:false — bell entry only, NO FCM (delivered live over socket + PartyKit).
      await notifyUser(env, String(listing.creator_id), { type: "marketplace_deal", title: outcome === "deal" ? "A buyer's agent reached a deal" : "A buyer's agent negotiated your listing", body, data: { listing_id: listingId, outcome, bubble } }, { push: false });
      await notifyUser(env, buyerUid, { type: "marketplace_deal", title: outcome === "deal" ? "Your agent reached a deal" : "Your agent finished negotiating", body, data: { listing_id: listingId, outcome, bubble } }, { push: false });
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
