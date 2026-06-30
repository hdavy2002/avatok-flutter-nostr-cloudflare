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
import { requireUser, isFail } from "../authz";
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
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return "";
    const out: any = await res.json().catch(() => null);
    return String(out?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return "";
  }
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

export async function marketplaceNegotiate(req: Request, env: Env): Promise<Response> {
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
    "SELECT id, creator_id, title, description, price, currency_display, status FROM listings WHERE id=?1",
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

  // Run the negotiation. The agents talk in TEXT (cheap Sonnet); audio is only
  // rendered on a DEAL (deferred to the TTS worker — see TODO below).
  track(env, ctx.uid, "negotiation_started", "avamarketplace", { listing_id: listingId });
  const asking = Math.trunc(Number(listing.price) || 0);
  const sys =
    "You simulate a brief, businesslike negotiation between two marketplace agents and output ONLY JSON. " +
    "The SELLER agent represents the listing; the BUYER agent has a maximum budget. The seller asks the " +
    "listing price and will realistically come down to about 80% of it if needed. Reach a DEAL only if the " +
    "buyer's max is at least the seller's lowest acceptable price; settle near the midpoint of the overlap. " +
    'Output: {"outcome":"deal"|"impasse","agreed_price":<int>,"currency":"<code>","transcript":[{"speaker":"Seller"|"Buyer","text":"..."}]} ' +
    "Keep the transcript to 4-8 short lines. No prose outside the JSON.";
  const user =
    `LISTING: "${listing.title}". Asking price: ${asking} ${listing.currency_display || currency}. ` +
    `Details: ${String(listing.description || "").slice(0, 600)}. ` +
    `BUYER max: ${buyerMax} ${currency}. Buyer must-haves: ${mustHaves || "none"}.`;
  const raw = await callSonnet(env, sys, user, 500);

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
  ).bind(ctx.uid, listingId, version, outcome, agreed, currency, Date.now()).run();

  track(env, ctx.uid, "negotiation_outcome", "avamarketplace", {
    listing_id: listingId, outcome, agreed_price: agreed, currency, rounds: transcript.length,
  });

  // RULE CHANGE (owner 2026-06-30): render the deal-audio voice note in BOTH
  // outcomes and drop it into both chat threads — colour-coded by outcome:
  //   DEAL    → audio bubble GREEN (go)
  //   IMPASSE → audio bubble PALE YELLOW (no-go)
  // This OVERRIDES the earlier "audio only on a deal" cost rule: TTS now runs on
  // every completed negotiation, so both owners always get the voice note.
  const bubble = outcome === "deal" ? "green" : "pale_yellow";
  // NOTE (P5 follow-up still pending): actually render `transcript` to a 2-voice
  // note via Gemini 2.5 multi-speaker TTS and post it as a voice MESSAGE in each
  // thread, styled by `bubble`. For now both parties get a notification carrying
  // {outcome, bubble} so the dropped audio can be coloured correctly.
  const body = outcome === "deal"
    ? `Your agents agreed around ${agreed} ${currency}. Open the chat to hear it and take it forward.`
    : `Your agents talked but didn't agree this time. Open the chat to hear how it went.`;
  try {
    await notifyUser(env, listing.creator_id, {
      type: "marketplace_negotiation",
      title: outcome === "deal" ? "A buyer's agent reached a deal" : "A buyer's agent negotiated your listing",
      body, data: { listing_id: listingId, outcome, bubble },
    });
    await notifyUser(env, ctx.uid, {
      type: "marketplace_negotiation",
      title: outcome === "deal" ? "Your agent reached a deal" : "Your agent finished negotiating",
      body, data: { listing_id: listingId, outcome, bubble },
    });
  } catch { /* notify best-effort */ }
  return json({ ok: true, outcome, agreed_price: agreed, currency, bubble, transcript });
}
// ── P6: AI search over active listings ────────────────────────────────────────
// ONE shared marketplace index (owner rule: no per-user AI Search instances).
// Today this delegates to the single shared FTS5 index behind /api/explore/search
// so search works now; the documented upgrade is to point this at one Cloudflare
// AI Search index (env.AI_SEARCH binding) for semantic ranking without changing
// the client contract.
export async function marketplaceSearch(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const q = u.searchParams.get("q") ?? "";
  const t0 = Date.now();
  const res = await exploreSearch(req, env);
  // Best-effort telemetry (no uid needed; search is public/guest-friendly).
  try {
    track(env, "guest", "marketplace_search", "avamarketplace", { query_len: q.length, ai_search_ms: Date.now() - t0 });
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

  // 1) text moderation (porn / scam / hate / etc.)
  const tMod = await moderate(env, { text: title, field: "listing_title" });
  if (!tMod.safe) {
    track(env, ctx.uid, "listing_rejected", "avamarketplace", { failing_check: "text_title" });
    return json({ ok: false, reason: tMod.reason || "Title isn’t allowed.", failing_check: "title" }, 200);
  }
  const dMod = await moderate(env, { text: description, field: "listing_desc" });
  if (!dMod.safe) {
    track(env, ctx.uid, "listing_rejected", "avamarketplace", { failing_check: "text_desc" });
    return json({ ok: false, reason: dMod.reason || "Description isn’t allowed.", failing_check: "description" }, 200);
  }

  // 2) PII strip — remove phone numbers + emails, including obfuscated forms.
  //    LLM beats regex on "nine-eight-seven…" / "name [at] gmail dot com"; a
  //    regex backstop catches the obvious cases if the model is unavailable.
  let cleaned = description;
  if (description.trim()) {
    const out = await callSonnet(
      env,
      "You redact contact details from marketplace text. Remove ALL phone numbers and email addresses, " +
        "including obfuscated forms (spelled-out digits, 'at'/'dot', spaces or unicode look-alikes). Keep " +
        "everything else exactly as written. Output ONLY the cleaned text, no commentary.",
      description,
      400,
    );
    cleaned = (out && out.length > 0 ? out : description)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[removed]")
      .replace(/(?:\+?\d[\s().-]?){7,}\d/g, "[removed]");
  }
  const stripped = cleaned !== description;
  track(env, ctx.uid, "moderation_pii_stripped", "avamarketplace", { changed: stripped });
  return json({ ok: true, cleaned_description: cleaned, pii_stripped: stripped });
}
