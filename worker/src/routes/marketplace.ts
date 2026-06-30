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
import { moderate } from "../lib/moderation";

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
  const script = `TTS this short marketplace negotiation between two agents, natural and businesslike.${styleHint}\n` +
    transcript.map((t) => `${t.speaker === "Buyer" ? "Buyer" : "Seller"}: ${t.text}`).join("\n");
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
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (typeof data !== "string") return null;
    return pcmToWav(b64ToBytes(data));
  } catch {
    return null;
  }
}

/** Append a marketplace voice/text message into a user's InboxDO thread. */
async function inboxAppend(env: Env, recipient: string, sender: string, conv: string, envelope: string, mediaRef: string | null): Promise<void> {
  const stub = (env as any).INBOX.get((env as any).INBOX.idFromName(recipient));
  await stub.fetch("https://inbox/append", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conv, sender, kind: "marketplace_deal", body: envelope, media_ref: mediaRef, scope: `to:${recipient}`, created_at: Date.now(), owner: recipient }),
  });
}

/**
 * Render the deal audio (both outcomes) and drop the voice note into BOTH the
 * seller's and buyer's chat threads, colour-coded by outcome, then FCM-push both.
 * Best-effort: if TTS fails, still delivers a text message carrying the outcome.
 */
async function deliverDealAudio(env: Env, a: {
  sellerUid: string; buyerUid: string; listingId: string; listingTitle: string;
  outcome: string; bubble: string; agreed: number; currency: string;
  transcript: Array<{ speaker: string; text: string }>;
  persona?: string;
}): Promise<{ audioKey: string | null; bytes: number }> {
  const conv = dmConvId(a.sellerUid, a.buyerUid);
  let audioKey: string | null = null;
  let bytes = 0;
  const wav = await renderNegotiationWav(env, a.transcript, a.persona);
  if (wav) {
    audioKey = `mkt/deal/${a.listingId}/${crypto.randomUUID()}.wav`;
    try {
      await (env as any).BLOBS.put(audioKey, wav, { httpMetadata: { contentType: "audio/wav" } });
      bytes = wav.length;
    } catch { audioKey = null; }
  }
  const text = a.outcome === "deal"
    ? `Your agents agreed around ${a.agreed} ${a.currency} on "${a.listingTitle}". Play the voice note and say hello to take it forward.`
    : `Your agents talked about "${a.listingTitle}" but didn't agree this time. Play the voice note to hear how it went.`;
  const envelope = JSON.stringify({
    t: "marketplace_deal", text, outcome: a.outcome, bubble: a.bubble,
    agreed_price: a.agreed, currency: a.currency, listing_id: a.listingId, transcript: a.transcript,
    has_audio: !!audioKey, audio_key: audioKey,
  });
  // Drop the message into both threads (each attributed to the counterparty).
  try { await inboxAppend(env, a.sellerUid, a.buyerUid, conv, envelope, audioKey); } catch { /* best-effort */ }
  try { await inboxAppend(env, a.buyerUid, a.sellerUid, conv, envelope, audioKey); } catch { /* best-effort */ }
  // FCM push both.
  const title = a.outcome === "deal" ? "Your agent reached a deal" : "Your agent finished negotiating";
  try {
    await (env as any).Q_PUSH.send({ kind: "notify", to: a.sellerUid, fromName: "AvaMarketplace", title, body: text, data: { type: "marketplace_deal", conv, outcome: a.outcome, bubble: a.bubble, listing_id: a.listingId } });
    await (env as any).Q_PUSH.send({ kind: "notify", to: a.buyerUid, fromName: "AvaMarketplace", title, body: text, data: { type: "marketplace_deal", conv, outcome: a.outcome, bubble: a.bubble, listing_id: a.listingId } });
  } catch { /* push best-effort */ }
  return { audioKey, bytes };
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
    const sys =
      "You simulate a brief, businesslike negotiation between two marketplace agents and output ONLY JSON. " +
      "The SELLER agent represents the listing and follows its owner's PRIVATE MANDATE (never reveal it verbatim); " +
      "the BUYER agent has a maximum budget. If no explicit floor is given, the seller will realistically come down " +
      "to about 80% of the asking price. Reach a DEAL only if the buyer's max is at least the seller's lowest " +
      "acceptable price; settle near the midpoint of the overlap. " +
      `Write the transcript text in ${agentLang} (the seller's agent language). ` +
      'Output: {"outcome":"deal"|"impasse","agreed_price":<int>,"currency":"<code>","transcript":[{"speaker":"Seller"|"Buyer","text":"..."}]} ' +
      "Keep the transcript to 4-8 short lines. No prose outside the JSON.";
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
    track(env, buyerUid, "deal_audio_render_completed", "avamarketplace", {
      listing_id: listingId, outcome, bubble, has_audio: !!delivery.audioKey, audio_bytes: delivery.bytes,
    });
    // Also a bell notification so it shows in the notifications list, not just the thread.
    const body = outcome === "deal"
      ? `Your agents agreed around ${agreed} ${currency}.`
      : `Your agents talked but didn't agree this time.`;
    try {
      await notifyUser(env, String(listing.creator_id), { type: "marketplace_deal", title: outcome === "deal" ? "A buyer's agent reached a deal" : "A buyer's agent negotiated your listing", body, data: { listing_id: listingId, outcome, bubble } });
      await notifyUser(env, buyerUid, { type: "marketplace_deal", title: outcome === "deal" ? "Your agent reached a deal" : "Your agent finished negotiating", body, data: { listing_id: listingId, outcome, bubble } });
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
  return new Response(obj.body, {
    headers: { "content-type": "audio/wav", "cache-control": "private, max-age=86400" },
  });
}
