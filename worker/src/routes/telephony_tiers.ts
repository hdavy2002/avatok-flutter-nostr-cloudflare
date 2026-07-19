// worker/src/routes/telephony_tiers.ts — [TEL-TIERS-1] Phase 4 of
// Specs/PLAN-2026-07-19-tokens-cockpit-pstn-master.md: telephony subscription
// tiers (Teler/Vobiz DID resale). Canonical pricing (Graphiti "CANONICAL
// PRICING" + the master plan):
//
//   Tier 1 "Voicemail/Receptionist"  ₹700/mo  = 1 channel + 1 number
//   Tier 2 "Bulk calling"          ₹2,500/mo  = 4 channels + 4 numbers
//   Add-on channel                   ₹700/mo  = +1 channel +1 number
//
// 1 token = ₹1 (wallet units are $0.01 tokens), so ₹700 = 700 tokens.
// CHANNELS = concurrent call slots; NUMBERS = phone addresses — DECOUPLED
// concepts that happen to move together in today's products. Wholesale cost is
// ~₹600/channel (context only — never exposed, never used in code).
//
// Endpoints (all requireUser; wired in index.ts next to /api/wallet/*):
//   POST /api/telephony/subscribe {tier:"tier1"|"tier2"}
//   POST /api/telephony/addon                    (+1 channel +1 number)
//   POST /api/telephony/cancel                   (keeps access until renews_at)
//   GET  /api/telephony/status                   (row + totals + concurrency)
//
// BILLING: chargeAmount (feature_pricing.ts) with explicit amounts — these are
// deliberately NOT FEATURE_COSTS entries (subscriptions aren't per-use AI
// features). Idempotent per calendar month via op_id `telsub:<uid>:<YYYY-MM>`
// (add-ons: `teladdon:<uid>:<YYYY-MM>:<n>`), so webhook retries / double-taps
// can never double-charge. forceMeter:false → beta free-premium applies like
// every other feature. Wallet-statement labels for the three featureKeys live
// in wallet_statement.ts's FEATURE_LABELS.
//
// RENEWAL is LAZY — no cron. On GET /status or on PSTN call admission
// (routes/pstn.ts → getTelephonySubscription), an active row past renews_at
// attempts the new period's charge; failure → status "past_due" with a 3-day
// grace window, after which the subscription reads as inactive. Cancel keeps
// access until renews_at (already paid for).
//
// CONCURRENCY TRACKING (the brief's critical rule — peak simultaneous calls,
// busy/rejection rate, 80% pressure alert) lives in routes/pstn.ts (KV gauges,
// best-effort, fail-open); this module only owns the subscription record and
// the shared read helper.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { chargeAmount } from "../feature_pricing";
import { track, trackUserContact } from "../hooks";
import { contactFor } from "../lib/identity";

const APP = "telephony";

// Canonical prices in tokens (1 token = ₹1). Owner-approved 2026-07-19.
const TIERS: Record<string, { price: number; channels: number; numbers: number; featureKey: string }> = {
  tier1: { price: 700, channels: 1, numbers: 1, featureKey: "telephony_tier1" },
  tier2: { price: 2500, channels: 4, numbers: 4, featureKey: "telephony_tier2" },
};
const ADDON_PRICE = 700;                       // ₹700/mo = +1 channel +1 number
const ADDON_FEATURE_KEY = "telephony_addon";
const PERIOD_MS = 30 * 24 * 3600 * 1000;       // 30-day billing cycle
const GRACE_MS = 3 * 24 * 3600 * 1000;         // past_due grace before inactive

/** Calendar period for charge idempotency, e.g. "2026-07". Renewals inside the
 *  same calendar month dedupe to one charge by design (the 30-day cycle can
 *  brush a month boundary; the brief chose per-month op_ids deliberately). */
function periodOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

export interface TelephonySubRow {
  uid: string;
  tier: string | null;
  channels: number;
  numbers: number;
  addon_channels: number;
  started_at: number;
  renews_at: number;
  status: string | null; // active | past_due | cancelled
  updated_at: number;
}

// Self-migrating table — this codebase's established D1 pattern (guarded DDL,
// once per isolate; see ensureStatusColumns in routes/receptionist.ts).
// CREATE TABLE IF NOT EXISTS is a no-op once applied. On failure the flag is
// reset so a transient D1 error retries on the next request.
let _telTableEnsured = false;
async function ensureTable(env: Env): Promise<void> {
  if (_telTableEnsured) return;
  _telTableEnsured = true;
  try {
    await metaDb(env).prepare(
      `CREATE TABLE IF NOT EXISTS telephony_subscriptions (
         uid TEXT PRIMARY KEY,
         tier TEXT,
         channels INTEGER,
         numbers INTEGER,
         addon_channels INTEGER,
         started_at INTEGER,
         renews_at INTEGER,
         status TEXT,
         updated_at INTEGER
       )`,
    ).run();
  } catch {
    _telTableEnsured = false; // retry next request — never wedge the isolate
  }
}

async function loadRow(env: Env, uid: string): Promise<TelephonySubRow | null> {
  const r = await metaDb(env)
    .prepare("SELECT * FROM telephony_subscriptions WHERE uid=?1")
    .bind(uid).first<TelephonySubRow>();
  return r ?? null;
}

/** Access semantics: active → yes; past_due → yes inside the 3-day grace;
 *  cancelled → yes until the already-paid renews_at; anything else → no. */
export function telephonyActive(row: TelephonySubRow | null, now: number): boolean {
  if (!row) return false;
  const status = (row.status || "").trim();
  if (status === "active") return true; // maybeRenew flips to past_due on charge failure
  if (status === "past_due") return now <= Number(row.renews_at || 0) + GRACE_MS;
  if (status === "cancelled") return now <= Number(row.renews_at || 0);
  return false;
}

export function channelsTotal(row: TelephonySubRow): number {
  return Math.max(0, Number(row.channels || 0)) + Math.max(0, Number(row.addon_channels || 0));
}

export function numbersTotal(row: TelephonySubRow): number {
  return Math.max(0, Number(row.numbers || 0)) + Math.max(0, Number(row.addon_channels || 0));
}

/** LAZY RENEWAL — called from GET /status and from PSTN call admission
 *  (getTelephonySubscription). An active row past renews_at attempts the new
 *  period's charge: base tier + every add-on channel, as ONE idempotent charge
 *  (`telsub:<uid>:<YYYY-MM>`) so a race between /status and a webhook can
 *  never bill twice. Success rolls renews_at forward one cycle (re-anchored to
 *  now if the row lapsed more than a full cycle — one charge never buys more
 *  than one 30-day period). Failure → past_due (3-day grace, see
 *  telephonyActive). Returns the possibly-updated row. */
async function maybeRenew(env: Env, row: TelephonySubRow, now: number): Promise<TelephonySubRow> {
  if ((row.status || "").trim() !== "active") return row;
  if (now <= Number(row.renews_at || 0)) return row;

  const tier = TIERS[(row.tier || "").trim()];
  if (!tier) return row; // unknown tier — never charge blindly
  const addons = Math.max(0, Number(row.addon_channels || 0));
  const price = tier.price + addons * ADDON_PRICE;
  const period = periodOf(now);

  const r = await chargeAmount(
    env, row.uid, tier.featureKey, price, `telsub:${row.uid}:${period}`, { forceMeter: false },
  ).catch(() => ({ ok: false as const, reason: "error" }));

  if (r.ok) {
    let renewsAt = Number(row.renews_at || 0) + PERIOD_MS;
    if (renewsAt < now) renewsAt = now + PERIOD_MS;
    await metaDb(env)
      .prepare("UPDATE telephony_subscriptions SET renews_at=?2, status='active', updated_at=?3 WHERE uid=?1")
      .bind(row.uid, renewsAt, now).run();
    try {
      const contact = await contactFor(env, row.uid).catch(() => ({ email: null, phone: null }));
      await trackUserContact(env, row.uid, contact.email, contact.phone, "telephony_renewed", APP, {
        tier: row.tier, addon_channels: addons, tokens: price, period, renews_at: renewsAt,
      });
    } catch { /* best-effort */ }
    return { ...row, renews_at: renewsAt, status: "active", updated_at: now };
  }

  await metaDb(env)
    .prepare("UPDATE telephony_subscriptions SET status='past_due', updated_at=?2 WHERE uid=?1")
    .bind(row.uid, now).run();
  try {
    const contact = await contactFor(env, row.uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, row.uid, contact.email, contact.phone, "telephony_renewal_failed", APP, {
      tier: row.tier, addon_channels: addons, tokens: price, period,
      reason: ("reason" in r ? r.reason : "error") ?? "error",
      grace_until: Number(row.renews_at || 0) + GRACE_MS,
    });
  } catch { /* best-effort */ }
  return { ...row, status: "past_due", updated_at: now };
}

/** Shared read for routes/pstn.ts's concurrency gate (and any future
 *  provisioning code): the subscription row AFTER lazy renewal, plus the
 *  computed entitlements. Returns null when the user has no row at all —
 *  callers must treat that as "no subscription, unchanged legacy behavior".
 *  BILLING-PLUMBING ONLY — safe under pstn.ts's no-engine-import rule. */
export async function getTelephonySubscription(
  env: Env, uid: string,
): Promise<{ row: TelephonySubRow; active: boolean; channels_total: number; numbers_total: number } | null> {
  await ensureTable(env);
  let row = await loadRow(env, uid);
  if (!row) return null;
  const now = Date.now();
  try { row = await maybeRenew(env, row, now); } catch { /* best-effort — stale row is still truthful */ }
  return { row, active: telephonyActive(row, now), channels_total: channelsTotal(row), numbers_total: numbersTotal(row) };
}

// ---------------------------------------------------------------------------
// POST /api/telephony/subscribe {tier:"tier1"|"tier2"}
// ---------------------------------------------------------------------------
export async function telephonySubscribe(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);

  const b = (await req.json().catch(() => ({}))) as { tier?: string };
  const tierKey = String(b.tier || "").trim().toLowerCase();
  const tier = TIERS[tierKey];
  if (!tier) return json({ error: "bad_tier", allowed: Object.keys(TIERS) }, 400);

  const now = Date.now();
  const existing = await loadRow(env, ctx.uid);
  if (existing && telephonyActive(existing, now) && (existing.status || "") !== "cancelled") {
    if ((existing.tier || "") === tierKey) {
      // Idempotent re-subscribe — the monthly op_id would dedupe the charge
      // anyway; answer honestly without touching the row.
      return json({
        ok: true, already: true, tier: tierKey, status: existing.status,
        renews_at: existing.renews_at,
        channels_total: channelsTotal(existing), numbers_total: numbersTotal(existing),
      });
    }
    // Tier CHANGE while active is deliberately unsupported in v1: the monthly
    // op_id `telsub:<uid>:<YYYY-MM>` has already been consumed this period, so
    // an in-place upgrade would grant Tier-2 entitlements for a deduped ₹0
    // charge. Proration is a later, deliberate feature — not a silent bug.
    return json({
      error: "tier_change_unsupported", current: existing.tier, renews_at: existing.renews_at,
      message: "Cancel first; the new tier can start after the paid period ends.",
    }, 409);
  }

  const period = periodOf(now);
  const r = await chargeAmount(
    env, ctx.uid, tier.featureKey, tier.price, `telsub:${ctx.uid}:${period}`, { forceMeter: false },
  );
  if (!r.ok) {
    if (r.reason === "insufficient") {
      // 402 passthrough — same shape family as the other paywalls so the
      // client can deep-link to top-up.
      return json({ error: "insufficient_tokens", needed: tier.price, balance: Number(r.balance ?? 0) }, 402);
    }
    return json({ error: "charge_failed", reason: r.reason || "error" }, 500);
  }

  const renewsAt = now + PERIOD_MS;
  // Fresh subscription: add-ons reset to 0 (they are month-to-month purchases
  // on top of a live base subscription, never carried across a lapse).
  await metaDb(env).prepare(
    `INSERT INTO telephony_subscriptions (uid, tier, channels, numbers, addon_channels, started_at, renews_at, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 'active', ?5)
     ON CONFLICT(uid) DO UPDATE SET
       tier=excluded.tier, channels=excluded.channels, numbers=excluded.numbers,
       addon_channels=0, started_at=excluded.started_at, renews_at=excluded.renews_at,
       status='active', updated_at=excluded.updated_at`,
  ).bind(ctx.uid, tierKey, tier.channels, tier.numbers, now, renewsAt).run();

  try {
    const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, ctx.uid, contact.email, contact.phone, "telephony_subscribed", APP, {
      tier: tierKey, tokens: r.charged ?? tier.price, period,
      channels: tier.channels, numbers: tier.numbers, renews_at: renewsAt,
    });
  } catch { /* best-effort */ }

  return json({
    ok: true, tier: tierKey, status: "active", started_at: now, renews_at: renewsAt,
    channels: tier.channels, numbers: tier.numbers, addon_channels: 0,
    channels_total: tier.channels, numbers_total: tier.numbers,
    charged: r.charged ?? tier.price, balance: r.balance ?? null,
  });
}

// ---------------------------------------------------------------------------
// POST /api/telephony/addon — +1 channel +1 number, ₹700/mo, requires a live
// base subscription. op_id `teladdon:<uid>:<YYYY-MM>:<n>` (n = the add-on's
// ordinal) so buying a SECOND add-on in the same month charges again, while a
// retried request for the SAME add-on dedupes.
// ---------------------------------------------------------------------------
export async function telephonyAddon(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);

  const now = Date.now();
  let row = await loadRow(env, ctx.uid);
  if (row) { try { row = await maybeRenew(env, row, now); } catch { /* best-effort */ } }
  if (!row || !telephonyActive(row, now) || (row.status || "") === "cancelled") {
    return json({ error: "no_active_subscription", message: "An active Tier 1 or Tier 2 subscription is required for add-on channels." }, 409);
  }

  const n = Math.max(0, Number(row.addon_channels || 0)) + 1;
  const period = periodOf(now);
  const r = await chargeAmount(
    env, ctx.uid, ADDON_FEATURE_KEY, ADDON_PRICE, `teladdon:${ctx.uid}:${period}:${n}`, { forceMeter: false },
  );
  if (!r.ok) {
    if (r.reason === "insufficient") {
      return json({ error: "insufficient_tokens", needed: ADDON_PRICE, balance: Number(r.balance ?? 0) }, 402);
    }
    return json({ error: "charge_failed", reason: r.reason || "error" }, 500);
  }

  await metaDb(env)
    .prepare("UPDATE telephony_subscriptions SET addon_channels=?2, updated_at=?3 WHERE uid=?1")
    .bind(ctx.uid, n, now).run();
  const updated: TelephonySubRow = { ...row, addon_channels: n, updated_at: now };

  try {
    const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, ctx.uid, contact.email, contact.phone, "telephony_addon_purchased", APP, {
      tier: row.tier, addon_n: n, tokens: r.charged ?? ADDON_PRICE, period,
      channels_total: channelsTotal(updated), numbers_total: numbersTotal(updated),
    });
  } catch { /* best-effort */ }

  return json({
    ok: true, tier: row.tier, addon_channels: n,
    channels_total: channelsTotal(updated), numbers_total: numbersTotal(updated),
    charged: r.charged ?? ADDON_PRICE, balance: r.balance ?? null,
  });
}

// ---------------------------------------------------------------------------
// POST /api/telephony/cancel — mark cancelled; access continues until the
// already-paid renews_at (telephonyActive honors that), no refunds, no proration.
// ---------------------------------------------------------------------------
export async function telephonyCancel(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);

  const now = Date.now();
  const row = await loadRow(env, ctx.uid);
  if (!row) return json({ error: "not_subscribed" }, 404);
  if ((row.status || "") === "cancelled") {
    return json({ ok: true, already: true, status: "cancelled", access_until: row.renews_at });
  }

  await metaDb(env)
    .prepare("UPDATE telephony_subscriptions SET status='cancelled', updated_at=?2 WHERE uid=?1")
    .bind(ctx.uid, now).run();

  try {
    const contact = await contactFor(env, ctx.uid).catch(() => ({ email: null, phone: null }));
    await trackUserContact(env, ctx.uid, contact.email, contact.phone, "telephony_cancelled", APP, {
      tier: row.tier, addon_channels: row.addon_channels, access_until: row.renews_at,
    });
  } catch { /* best-effort */ }

  return json({ ok: true, status: "cancelled", access_until: row.renews_at });
}

// ---------------------------------------------------------------------------
// GET /api/telephony/status — row + computed totals + this month's concurrency
// stats (the KV gauges routes/pstn.ts maintains: live active-call count, peak
// simultaneous calls, and busy rejections — all best-effort observability).
// Doubles as the lazy-renewal touchpoint.
// ---------------------------------------------------------------------------
export async function telephonyStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await ensureTable(env);

  const now = Date.now();
  const period = periodOf(now);
  let row = await loadRow(env, ctx.uid);
  if (row) { try { row = await maybeRenew(env, row, now); } catch { /* best-effort */ } }

  // Concurrency gauges (KV, may be absent — default 0). Key shapes owned by
  // routes/pstn.ts: pstn_active:<uid>, pstn_peak:<uid>:<YYYY-MM>, pstn_reject:<uid>:<YYYY-MM>.
  let activeCalls = 0, peak = 0, rejects = 0;
  try {
    const [a, p, rj] = await Promise.all([
      env.TOKENS.get(`pstn_active:${ctx.uid}`),
      env.TOKENS.get(`pstn_peak:${ctx.uid}:${period}`),
      env.TOKENS.get(`pstn_reject:${ctx.uid}:${period}`),
    ]);
    activeCalls = Math.max(0, Number(a || 0) || 0);
    peak = Math.max(0, Number(p || 0) || 0);
    rejects = Math.max(0, Number(rj || 0) || 0);
  } catch { /* best-effort — stats never break status */ }

  if (!row) {
    return json({
      subscribed: false, active: false, channels_total: 0, numbers_total: 0,
      concurrency: { active_calls: activeCalls, peak_this_month: peak, rejects_this_month: rejects, period },
    });
  }

  try { await track(env, ctx.uid, "telephony_status_read", APP, { tier: row.tier, status: row.status }); } catch { /* best-effort */ }

  return json({
    subscribed: true,
    tier: row.tier, status: row.status,
    channels: row.channels, numbers: row.numbers, addon_channels: row.addon_channels,
    started_at: row.started_at, renews_at: row.renews_at,
    channels_total: channelsTotal(row), numbers_total: numbersTotal(row),
    active: telephonyActive(row, now),
    grace_until: (row.status || "") === "past_due" ? Number(row.renews_at || 0) + GRACE_MS : null,
    concurrency: { active_calls: activeCalls, peak_this_month: peak, rejects_this_month: rejects, period },
  });
}
