// Live Voice Translation — Gemini 3.5 Live Translate (PROPOSAL-LIVE-TRANSLATION-GEMINI.md).
//
// The listener's DEVICE streams the incoming call audio straight to Google via
// a short-lived ephemeral token minted here; no media ever flows through the
// Worker. This module does exactly two jobs: tokens + AvaCoins metering.
//
//   POST /api/translate/start        → wallet check → session row → ephemeral token
//   POST /api/translate/:id/beat     → bill elapsed 5-min slices (prepaid first, then wallet)
//   POST /api/translate/:id/stop     → end session + per-minute pro-rata true-up
//   POST /api/translate/:id/token    → fresh ephemeral token (reconnects; tokens are 1-use/30-min)
//   GET  /api/translate/quote        → price preview for the booking pipeline
//
// Billing: 5 AvaCoins/min = 300/hour = $3/hour (1 coin = $0.01). 100% of every
// translation fee lands in platform:fees — the creator NEVER shares in it
// (owner rule). Two modes:
//   prepaid — chosen at booking; coins sit in escrow trl_<orderId>; consumed
//             minutes settle escrow→platform at booking settlement, the rest
//             refunds via the refund engine (money_engine hook).
//   payg    — started in-call from the Translate menu; wallet is debited per
//             slice (op_id idempotent). Insufficient balance → 402 → the app
//             shows the "top up your wallet" pop-up and pauses translation.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { walletOp } from "./wallet";
import { acctUser, ACCT_PLATFORM_FEES, refund } from "../ledger";
import { rateLimit } from "../money";
import { track, metric } from "../hooks";
import { readConfig } from "./config";

export const TRANSLATE_MODEL = "gemini-3.5-live-translate-preview";
export const RATE_PER_MIN = 5;            // AvaCoins/min → 300/h = $3/h
export const SLICE_MIN = 5;               // billing granularity (one heartbeat slice)
export const SLICE_COINS = SLICE_MIN * RATE_PER_MIN; // 25
const MIN_START_COINS = 3 * SLICE_COINS;  // need ≥15 min of runway to start payg
const APP = "avatranslate";

// BCP-47 codes Live Translation supports (docs 2026-06-09). Server-side guard;
// the client renders the picker from its own mirrored list.
export const LANGS = new Set(["af","ak","sq","am","ar","hy","az","eu","be","bn","bg","my","ca","zh-Hans","zh-Hant","hr","cs","da","nl","en","et","fil","fi","fr","gl","ka","de","el","gu","ha","he","hi","hu","is","id","it","ja","jv","kn","kk","km","rw","ko","lo","lv","lt","mk","ms","ml","mr","mn","ne","no","nb","fa","pl","pt-BR","pt-PT","pa","ro","ru","sr","sd","si","sk","sl","es","su","sw","sv","ta","te","th","tr","uk","ur","uz","vi","zu"]);

/** Pure slice math (tested): how many 5-min slices must be paid after
 *  elapsedMin minutes — always one slice ahead of the clock. */
export function slicesDue(elapsedMin: number): number {
  return Math.floor(Math.max(0, elapsedMin) / SLICE_MIN) + 1;
}

/** Pure pro-rata true-up (tested): coins owed for a session that ran usedMs. */
export function fairCoins(usedMs: number, ratePerMin = RATE_PER_MIN): number {
  return Math.max(1, Math.ceil(usedMs / 60_000)) * ratePerMin;
}

interface TrlSession {
  id: string; uid: string; context: string; ref: string;
  booking_id: string | null; trl_order_id: string | null; mode: string;
  target_lang: string; rate_per_min: number; started_at: number;
  last_beat_at: number; billed_min: number; billed_coins: number; status: string;
}

// ---------------------------------------------------------------------------
// Gemini ephemeral tokens (v1alpha auth_tokens — REST equivalent of the SDK's
// authTokens.create). translationConfig is LOCKED into the token constraints so
// a tampered client cannot change language or model without paying again.
// ---------------------------------------------------------------------------
async function mintToken(env: Env, targetLang: string): Promise<{ token: string; expires_at: number } | { error: string }> {
  if (!env.GEMINI_API_KEY) return { error: "translation unavailable: GEMINI_API_KEY unset" };
  const expireMs = Date.now() + 30 * 60_000;
  // REST shape verified 2026-06-11: the SDK's liveConnectConstraints maps to
  // `bidiGenerateContentSetup`; transcription toggles sit at setup level,
  // translationConfig inside generationConfig.
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
    bidiGenerateContentSetup: {
      model: `models/${TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode: targetLang, echoTargetLanguage: false },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j?.name) return { error: `token mint failed (${r.status}): ${j?.error?.message ?? "unknown"}` };
  return { token: String(j.name), expires_at: expireMs };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadSession(env: Env, id: string): Promise<TrlSession | null> {
  const r = await metaDb(env).prepare("SELECT * FROM translation_sessions WHERE id=?1").bind(id).first<any>();
  return r ? (r as TrlSession) : null;
}

async function balance(env: Env, uid: string): Promise<number> {
  const r = await walletOp(env, uid, { op: "balance", uid });
  return Number(r.body?.balance ?? 0);
}

/** Debit one payg slice from the listener's wallet → platform:fees. Idempotent on op_id. */
async function billWalletSlice(env: Env, s: TrlSession, slice: number): Promise<boolean> {
  const r = await walletOp(env, s.uid, {
    op: "spend", uid: s.uid, amount: SLICE_COINS, type: "spend", app_name: APP,
    ref: s.id, op_id: `trl:${s.id}:${slice}`,
    ledger: {
      debit: acctUser(s.uid), credit: ACCT_PLATFORM_FEES, type: "translation_fee", ref: s.id,
      meta: JSON.stringify({ title: `Voice translation (${s.target_lang})`, minutes: SLICE_MIN, rate_per_min: s.rate_per_min, context: s.context, ref: s.ref }),
    },
  });
  return r.status === 200;
}

/** Coins already consumed against a prepaid translation order (all sessions). */
async function prepaidConsumed(env: Env, trlOrderId: string): Promise<number> {
  const r = await metaDb(env).prepare(
    "SELECT COALESCE(SUM(billed_coins),0) AS c FROM translation_sessions WHERE trl_order_id=?1",
  ).bind(trlOrderId).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

/**
 * Bill a session up to "now": every started 5-min slice is paid in advance.
 * Prepaid coins are consumed first (no money moves yet — settlement happens at
 * booking close); when prepay runs out, the session continues against the
 * wallet. Returns the state the client must act on.
 */
async function meter(env: Env, s: TrlSession, now: number): Promise<{ ok: boolean; reason?: string; billedMin: number; billedCoins: number; mode: string }> {
  // BETA PHASE: live translation is free for everyone — keep the session active
  // and never bill (no wallet spend, no escrow consume). billed_coins stays as-is
  // (0 for beta sessions), so translateStop's true-up moves nothing. Flip
  // betaFreePremium off in KV to restore $3/h metering.
  try {
    if ((await readConfig(env)).betaFreePremium) {
      await metaDb(env).prepare(
        "UPDATE translation_sessions SET status='active', last_beat_at=?2, updated_at=?2 WHERE id=?1",
      ).bind(s.id, now).run();
      return { ok: true, billedMin: s.billed_min, billedCoins: s.billed_coins, mode: s.mode };
    }
  } catch { /* meter normally if the config lookup fails */ }
  const elapsedMin = Math.floor((now - s.started_at) / 60_000);
  const needSlices = slicesDue(elapsedMin);                        // pay-ahead
  let paidSlices = Math.floor(s.billed_min / SLICE_MIN);
  let billedMin = s.billed_min, billedCoins = s.billed_coins, mode = s.mode;

  // Prepay budget left on this booking (shared across the booking's sessions).
  let prepayLeft = 0;
  if (s.trl_order_id) {
    const bk = await metaDb(env).prepare("SELECT translation_coins FROM bookings WHERE trl_order_id=?1").bind(s.trl_order_id).first<{ translation_coins: number }>();
    prepayLeft = Math.max(0, Number(bk?.translation_coins ?? 0) - await prepaidConsumed(env, s.trl_order_id));
  }

  while (paidSlices < needSlices) {
    if (mode === "prepaid" && prepayLeft >= SLICE_COINS) {
      prepayLeft -= SLICE_COINS;                                    // consumed from escrow at settlement
    } else {
      if (mode === "prepaid") mode = "payg";                        // prepay exhausted → wallet
      const ok = await billWalletSlice(env, { ...s, mode } as TrlSession, paidSlices);
      if (!ok) {
        await metaDb(env).prepare(
          "UPDATE translation_sessions SET billed_min=?2, billed_coins=?3, mode=?4, status='paused_funds', last_beat_at=?5, updated_at=?5 WHERE id=?1",
        ).bind(s.id, billedMin, billedCoins, mode, now).run();
        return { ok: false, reason: "insufficient_avacoins", billedMin, billedCoins, mode };
      }
    }
    paidSlices++; billedMin += SLICE_MIN; billedCoins += SLICE_COINS;
  }

  await metaDb(env).prepare(
    "UPDATE translation_sessions SET billed_min=?2, billed_coins=?3, mode=?4, status='active', last_beat_at=?5, updated_at=?5 WHERE id=?1",
  ).bind(s.id, billedMin, billedCoins, mode, now).run();
  return { ok: true, billedMin, billedCoins, mode };
}

// ---------------------------------------------------------------------------
// GET /api/translate/quote?minutes=60 — booking-pipeline price preview.
// ---------------------------------------------------------------------------
export function translateQuote(req: Request): Response {
  const m = Math.max(1, Math.min(480, Math.trunc(Number(new URL(req.url).searchParams.get("minutes") || 60))));
  return json({ minutes: m, rate_per_min: RATE_PER_MIN, coins: m * RATE_PER_MIN, usd_per_hour: 3, note: "Voice translation — 100% platform fee, not shared with the creator" });
}

// ---------------------------------------------------------------------------
// POST /api/translate/start { context, ref, booking_id?, target_lang }
// ---------------------------------------------------------------------------
export async function translateStart(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const cfg = await readConfig(env);
  if (!cfg.translationEnabled) return json({ error: "translation disabled", flag: "translationEnabled" }, 503);
  if (!env.GEMINI_API_KEY) return json({ error: "translation unavailable", reason: "GEMINI_API_KEY unset" }, 503);
  const limited = await rateLimit(env, `trl:${ctx.uid}`, 10, 3600);
  if (limited) return limited;

  const b = (await req.json().catch(() => ({}))) as any;
  const context = String(b.context || "");
  const ref = String(b.ref || "");
  const lang = String(b.target_lang || "");
  if (!["consult", "live", "conference"].includes(context)) return json({ error: "context must be consult|live|conference" }, 400);
  if (!ref || ref.length > 64) return json({ error: "ref required" }, 400);
  if (!LANGS.has(lang)) return json({ error: "unsupported target_lang", lang }, 400);
  if (context === "conference" && !cfg.translationGroupEnabled) return json({ error: "group translation disabled", flag: "translationGroupEnabled" }, 503);

  const db = metaDb(env);
  // Entitlement + prepaid lookup.
  let bookingId: string | null = null, trlOrderId: string | null = null, mode = "payg";
  if (context === "consult") {
    const bk = await db.prepare("SELECT id, creator_id, buyer_id, translation_lang, translation_coins, trl_order_id FROM bookings WHERE id=?1").bind(ref).first<any>();
    if (!bk) return json({ error: "booking not found" }, 404);
    if (bk.creator_id !== ctx.uid && bk.buyer_id !== ctx.uid) return json({ error: "not your session" }, 403);
    bookingId = String(bk.id);
    // Prepay applies to the BUYER who chose translation at checkout.
    if (bk.buyer_id === ctx.uid && bk.trl_order_id && Number(bk.translation_coins) > 0) {
      trlOrderId = String(bk.trl_order_id);
      const left = Number(bk.translation_coins) - await prepaidConsumed(env, trlOrderId);
      if (left >= SLICE_COINS) mode = "prepaid";
    }
  } else if (context === "live") {
    const l = await db.prepare("SELECT id, creator_id FROM listings WHERE id=?1").bind(ref).first<any>();
    if (!l) return json({ error: "listing not found" }, 404);
    if (l.creator_id !== ctx.uid) {
      const o = await db.prepare("SELECT 1 FROM orders WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('held','free','settled')").bind(ref, ctx.uid).first();
      if (!o) return json({ error: "no valid order for this event" }, 403);
      // Viewer prepay rides the event booking.
      const bk = await db.prepare("SELECT id, translation_coins, trl_order_id FROM bookings WHERE listing_id=?1 AND buyer_id=?2 AND status IN ('confirmed','completed') ORDER BY created_at DESC LIMIT 1").bind(ref, ctx.uid).first<any>();
      if (bk) {
        bookingId = String(bk.id);
        if (bk.trl_order_id && Number(bk.translation_coins) > 0) {
          trlOrderId = String(bk.trl_order_id);
          const left = Number(bk.translation_coins) - await prepaidConsumed(env, trlOrderId);
          if (left >= SLICE_COINS) mode = "prepaid";
        }
      }
    }
  } // conference: any authed member may translate; billing is on them.

  // Wallet runway check for payg starts — the FIRST pop-up ("you don't have
  // AvaCoins in your wallet to listen to live translation").
  if (mode === "payg" && !cfg.betaFreePremium) {
    const bal = await balance(env, ctx.uid);
    if (bal < MIN_START_COINS) {
      return json({ error: "insufficient_avacoins", needed: MIN_START_COINS, balance: bal, rate_per_min: RATE_PER_MIN }, 402);
    }
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO translation_sessions (id, uid, context, ref, booking_id, trl_order_id, mode, target_lang, rate_per_min, started_at, last_beat_at, billed_min, billed_coins, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,0,0,'active',?10,?10)`,
  ).bind(id, ctx.uid, context, ref, bookingId, trlOrderId, mode, lang, RATE_PER_MIN, now).run();

  const s = (await loadSession(env, id))!;
  const m = await meter(env, s, now); // bills the first slice (prepay or wallet)
  if (!m.ok) return json({ error: "insufficient_avacoins", session_id: id, rate_per_min: RATE_PER_MIN }, 402);

  const t = await mintToken(env, lang);
  if ("error" in t) return json({ error: t.error }, 502);
  track(env, ctx.uid, "translation_started", APP, { context, lang, mode: m.mode });
  // One Brain B1 §5 — live-session attribution (a Gemini Live cloud session opens
  // at token mint). Unified event across all live features (feature, uid, model).
  track(env, ctx.uid, "live_session_open", APP, { feature: "translate", model: TRANSLATE_MODEL, verb: "transcribe", session_id: id, lang });
  metric(env, "translation_start", [1]);
  return json({
    ok: true, session_id: id, token: t.token, token_expires_at: t.expires_at,
    model: TRANSLATE_MODEL, target_lang: lang, mode: m.mode,
    rate_per_min: RATE_PER_MIN, slice_min: SLICE_MIN,
    beat_every_sec: SLICE_MIN * 60, billed_min: m.billedMin,
  });
}

// ---------------------------------------------------------------------------
// POST /api/translate/:id/beat — renew the meter (every slice_min minutes).
// ---------------------------------------------------------------------------
export async function translateBeat(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await loadSession(env, id);
  if (!s || s.uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status === "ended") return json({ error: "session ended" }, 409);

  const m = await meter(env, s, Date.now());
  if (!m.ok) {
    track(env, ctx.uid, "translation_paused_funds", APP, { billed_min: m.billedMin });
    // The SECOND pop-up ("you have utilized your AvaCoins for your voice
    // translation, please top up your wallet to add some more coins").
    return json({ error: "insufficient_avacoins", reason: "balance_exhausted", billed_min: m.billedMin, rate_per_min: RATE_PER_MIN }, 402);
  }
  return json({ ok: true, billed_min: m.billedMin, billed_coins: m.billedCoins, mode: m.mode, beat_every_sec: SLICE_MIN * 60 });
}

// ---------------------------------------------------------------------------
// POST /api/translate/:id/stop — end + per-minute pro-rata true-up. The user
// pays for ceil(elapsed minutes), never the whole advance slice.
// ---------------------------------------------------------------------------
export async function translateStop(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await loadSession(env, id);
  if (!s || s.uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status === "ended") return json({ ok: true, already: true });

  const now = Date.now();
  const fair = fairCoins(now - s.started_at, s.rate_per_min);
  const usedMin = fair / s.rate_per_min;
  let finalMin = s.billed_min, finalCoins = s.billed_coins;

  if (s.billed_coins > fair) {
    const over = s.billed_coins - fair;
    if (s.mode === "payg") {
      // Refund the unused tail of the advance slice (idempotent op_id).
      await walletOp(env, s.uid, {
        op: "credit", uid: s.uid, amount: over, type: "refund", app_name: APP, ref: s.id, op_id: `trl:${id}:trueup`,
        ledger: { debit: ACCT_PLATFORM_FEES, credit: acctUser(s.uid), type: "translation_refund", ref: s.id, meta: JSON.stringify({ title: "Voice translation — unused minutes", coins: over }) },
      });
    }
    // Prepaid: nothing moved yet — just shrink the consumption marker so
    // settlement charges only real minutes.
    finalMin = usedMin; finalCoins = fair;
  }

  await metaDb(env).prepare(
    "UPDATE translation_sessions SET status='ended', billed_min=?2, billed_coins=?3, last_beat_at=?4, updated_at=?4 WHERE id=?1",
  ).bind(id, finalMin, finalCoins, now).run();
  track(env, ctx.uid, "translation_stopped", APP, { minutes: finalMin, coins: finalCoins, mode: s.mode });
  // One Brain B1 §5 — live-session close (natural close hook exists here).
  track(env, ctx.uid, "live_session_close", APP, { feature: "translate", model: TRANSLATE_MODEL, verb: "transcribe", session_id: id, minutes: finalMin });
  metric(env, "translation_minutes", [finalMin, finalCoins]);
  return json({ ok: true, minutes: finalMin, coins: finalCoins });
}

// ---------------------------------------------------------------------------
// POST /api/translate/:id/token — fresh ephemeral token for a reconnect (the
// Live API needs a new connection every ≤10 min unless sessionResumption).
// ---------------------------------------------------------------------------
export async function translateToken(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const s = await loadSession(env, id);
  if (!s || s.uid !== ctx.uid) return json({ error: "not found" }, 404);
  if (s.status !== "active") return json({ error: "session not active", status: s.status }, 409);
  const t = await mintToken(env, s.target_lang);
  if ("error" in t) return json({ error: t.error }, 502);
  return json({ ok: true, token: t.token, token_expires_at: t.expires_at, model: TRANSLATE_MODEL });
}

// ---------------------------------------------------------------------------
// Settlement hook (Phase 5) — called by the money engine when a booking's
// order settles/cancels. Consumed prepaid minutes go escrow→platform:fees
// (ledger-only row, idempotent on the row id); the remainder refunds to the
// buyer immediately (spendable — not held).
// ---------------------------------------------------------------------------
export async function settleTranslation(env: Env, sid: string, kind: "live_event" | "consult"): Promise<void> {
  const db = metaDb(env);
  const rows = kind === "consult"
    ? await db.prepare("SELECT id, buyer_id, translation_coins, trl_order_id FROM bookings WHERE id=?1 AND trl_order_id IS NOT NULL AND translation_coins>0").bind(sid).all()
    : await db.prepare("SELECT id, buyer_id, translation_coins, trl_order_id FROM bookings WHERE listing_id=?1 AND trl_order_id IS NOT NULL AND translation_coins>0").bind(sid).all();

  for (const bk of ((rows.results ?? []) as any[])) {
    const trlOrderId = String(bk.trl_order_id);
    // Idempotency marker — same settlement_log table the engine uses.
    const fresh = await db.prepare(
      "INSERT INTO settlement_log (id, session_id, order_id, rule, action, amount, created_at) VALUES (?1,?2,?3,'TRL','translation_settle',NULL,?4) ON CONFLICT(id) DO NOTHING",
    ).bind(`${sid}:translation:${trlOrderId}`, sid, trlOrderId, Date.now()).run();
    if ((fresh.meta?.changes ?? 0) === 0) continue; // already settled

    const prepaid = Number(bk.translation_coins);
    const consumed = Math.min(prepaid, await prepaidConsumed(env, trlOrderId));
    const unused = prepaid - consumed;

    if (consumed > 0) {
      // Ledger-only: escrow → platform:fees (100% platform — never the creator).
      await env.Q_WALLET.send({
        id: `trlfee:${trlOrderId}`, ts: Date.now(), amount: consumed,
        ledger: { debit: `escrow:${trlOrderId}`, credit: ACCT_PLATFORM_FEES, type: "translation_fee", ref: trlOrderId, meta: JSON.stringify({ title: "Voice translation (consumed)", booking: bk.id, coins: consumed }) },
      });
    }
    if (unused > 0) {
      await refund(env, trlOrderId, String(bk.buyer_id), unused, { opId: `refund:${trlOrderId}:trl`, reason: "unused voice translation minutes", title: "Voice translation" });
    }
    metric(env, "translation_settled", [consumed, unused]);
  }
}
