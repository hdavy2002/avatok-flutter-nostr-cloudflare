// [AVA-MKT-ENTITLEMENTS-1] Listing publish entitlement — the §5 quota + §1.3 token
// charge, consumed INSIDE the publish, keyed on listing_id (§3.3c).
//
// This is the single coherent helper BOTH publish paths call — the classic form path
// (routes/listings.ts publishListing) and the AI-compose path (routes/compose.ts
// composePublish). It answers the two per-LISTING questions the marketplace has to
// answer on every publish (and that the token ledger deliberately does NOT — see
// migrations/2026-07-18-listing-entitlements.sql):
//   1. "Has this uid used their 5 free listings this period?"  (the quota, §5)
//   2. Charge 100 tokens (= $1, M-D2) for the 6th+ via chargeFeature, idempotently.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS SAFE TO RETRY — THE §3.3c CORRECTNESS POINT.
//
// "The quota + charge MUST be consumed INSIDE the publish transaction, keyed on
// listing_id — a retried publish must never double-charge the user's wallet."
//
// Two independent idempotency layers, both keyed on the LISTING (never on a
// wall-clock value, never on a separate call):
//
//   (a) The wallet debit is idempotent on op_id = `${listingId}:${period}`. WalletDO
//       dedupes the spend, so a second charge for the same (listing, period) is a
//       no-op at the money layer (feature_pricing.ts chargeFeature → walletOp op_id).
//   (b) The entitlement row is idempotent on the PRIMARY KEY (listing_id, period).
//       This helper reads that row FIRST: if it exists, we return it AS-IS and never
//       charge again. The INSERT that records a fresh grant/charge is INSERT OR
//       IGNORE, so even a race that slips past the read no-ops on the PK.
//
// `period` is a DETERMINISTIC ORDINAL (1 = initial publish, 2 = first renewal, …),
// NOT a timestamp — so a retry of the initial publish is ALWAYS period 1 and always
// collides with the same PK. Belt (a) and braces (b): the money can't move twice and
// the row can't be written twice, for the same (listing, period).
//
// ORDERING THE CALLER MUST HONOUR (documented at both call sites too):
//   moderation passes  →  consumeListingEntitlement  →  status flip to 'published'.
// A listing that fails moderation is never charged (the caller returns 422/503 before
// reaching here); a charged listing always publishes (the caller flips status only on
// {ok:true}). On {ok:false} the caller publishes NOTHING and this helper wrote NOTHING
// (no entitlement row on the insufficient/charge-failed path) — so nothing is charged
// either.
//
// FLAG GATE — `listingFeeEnabled` (config.ts, default false):
//   OFF → everyone is 'free' (no charge, no quota rejection), but we STILL write the
//         entitlement row so the quota count is accurate the day it flips ON.
//   ON  → enforce 5-free-then-charge.
// Note betaFreePremium independently short-circuits chargeFeature to {ok:true,
// charged:0} BEFORE any wallet call, so even with listingFeeEnabled ON, a beta user is
// never debited — the row lands source='paid', charged=0. That is intended: the billing
// machinery lands dark.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { FEATURE_COSTS, chargeFeature } from "../feature_pricing";
import { readConfig } from "../routes/config";

/** 5 free listings per uid per 30-day period (§5, §1.3). */
export const FREE_LISTING_QUOTA = 5;
/** A listing period is 30 days (§1.3 — "$1/listing/month", M-D2). */
export const LISTING_PERIOD_MS = 30 * 86_400_000;

export type ListingEntitlementOk = {
  ok: true;
  source: "free" | "paid";
  charged: number;      // tokens debited (0 for free, and 0 under betaFreePremium)
  period: number;
  expires_at: number;   // epoch ms — when this period's live window ends
};
export type ListingEntitlementErr =
  // insufficient_funds → the caller returns a clean 402 with `needed`; nothing published.
  | { ok: false; error: "insufficient_funds"; needed: number }
  // charge_failed → the wallet could not be reached / errored. NOT a paywall; the caller
  //   returns 503 (same fail-closed posture as moderation_unavailable) — nothing charged,
  //   nothing published, safe to retry.
  | { ok: false; error: "charge_failed" };
export type ListingEntitlementResult = ListingEntitlementOk | ListingEntitlementErr;

/** Per-vertical fee key (§1.3 note / M-D2). Same price for now, so Connect can price
 *  differently later at zero structural cost. */
function feeKeyFor(vertical: string | undefined): "listing_post" | "listing_post_connect" {
  return vertical === "connect" ? "listing_post_connect" : "listing_post";
}

/**
 * Consume the publish entitlement for one (listing, period). Runs against DB_META — the
 * SAME database as `listings` — so it is co-located with, and callable as part of, the
 * publish write (D1 has no cross-database transaction; §3.3c requires this be one DB).
 *
 * Call AFTER moderation passes and BEFORE/AS the status flip. See the ordering note above.
 *
 * @returns {ok:true, source, charged} on success (row written);
 *          {ok:false, error:'insufficient_funds', needed} when the 6th+ listing cannot be
 *          paid for (NO row written, nothing published);
 *          {ok:false, error:'charge_failed'} on a wallet error (NO row written).
 *
 * Renewal (period 2+) is another one-shot charge (§1.3) and is triggered by a separate
 * route/cron — this primitive is callable with period=N: it derives op_id
 * `${listingId}:${period}`, writes a NEW (listing_id, period) row, and never overwrites a
 * prior period. This function builds that primitive; it does not schedule renewals.
 */
export async function consumeListingEntitlement(
  env: Env,
  args: { uid: string; listingId: string; vertical?: string; period?: number; now?: number },
): Promise<ListingEntitlementResult> {
  const db = metaDb(env);
  const period = args.period ?? 1;
  const now = args.now ?? Date.now();

  // ── (b) IDEMPOTENCY FIRST — a republish/retry is a no-op, never a second grant ──
  // If the (listing_id, period) row already exists, this publish was already entitled;
  // hand it back untouched. No second quota grant, no second charge. This is what makes
  // archive→restore→republish (classic path) and any at-least-once retry safe.
  const existing = await db.prepare(
    "SELECT source, charged, expires_at FROM listing_entitlements WHERE listing_id=?1 AND period=?2",
  ).bind(args.listingId, period).first<{ source: string; charged: number; expires_at: number }>();
  if (existing) {
    return {
      ok: true,
      source: existing.source === "paid" ? "paid" : "free",
      charged: Number(existing.charged ?? 0),
      period,
      expires_at: Number(existing.expires_at ?? now + LISTING_PERIOD_MS),
    };
  }

  const periodStart = now;
  const expiresAt = now + LISTING_PERIOD_MS;

  // INSERT OR IGNORE (never OR REPLACE): the (listing_id, period) PK makes a racing second
  // insert a no-op rather than an overwrite that destroys the prior grant's audit.
  const writeRow = async (source: "free" | "paid", charged: number, opId: string | null) => {
    await db.prepare(
      `INSERT OR IGNORE INTO listing_entitlements
         (listing_id, period, uid, source, charged, op_id, period_start, expires_at, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(args.listingId, period, args.uid, source, charged, opId, periodStart, expiresAt, now).run();
  };

  // ── FLAG GATE ────────────────────────────────────────────────────────────────
  // Read defensively: the key may not be in the PlatformConfig type yet (it is being
  // added to config.ts alongside this). Absent/unreadable ⇒ OFF (fail-open on the
  // PAYWALL is correct — an unknown flag must not start charging users).
  let feeOn = false;
  try {
    feeOn = (await readConfig(env) as { listingFeeEnabled?: boolean }).listingFeeEnabled === true;
  } catch { feeOn = false; }

  // FEE OFF → everyone free. Still record the row so the quota count is accurate the day
  // the flag flips on (the entitlement is tracked even when it costs nothing).
  if (!feeOn) {
    await writeRow("free", 0, null);
    return { ok: true, source: "free", charged: 0, period, expires_at: expiresAt };
  }

  // ── QUOTA — has this uid used their 5 free listings this period? (§5) ───────────
  // Counts active free entitlements via the (uid, source, expires_at) index. "This
  // period" = free rows whose 30-day window has not yet elapsed.
  const q = await db.prepare(
    "SELECT COUNT(*) AS n FROM listing_entitlements WHERE uid=?1 AND source='free' AND expires_at>?2",
  ).bind(args.uid, now).first<{ n: number }>();
  const freeUsed = Number(q?.n ?? 0);
  if (freeUsed < FREE_LISTING_QUOTA) {
    await writeRow("free", 0, null);
    return { ok: true, source: "free", charged: 0, period, expires_at: expiresAt };
  }

  // ── 6th+ → CHARGE (idempotent on op_id = `${listingId}:${period}`) ─────────────
  const feeKey = feeKeyFor(args.vertical);
  const opId = `${args.listingId}:${period}`;
  const cost = FEATURE_COSTS[feeKey] ?? 100;
  const r = await chargeFeature(env, args.uid, feeKey, opId);
  if (!r.ok) {
    // insufficient → a real paywall. Nothing published, nothing charged, NO row written
    // (the §5 quota is unchanged; the user tops up and retries with the same listing_id →
    // op_id dedupes and the PK dedupes, so the retry is safe).
    if (r.reason === "insufficient") return { ok: false, error: "insufficient_funds", needed: cost };
    // unknown_feature / wallet error — do not publish, do not invent a paywall. Fail closed.
    return { ok: false, error: "charge_failed" };
  }
  // Charged OK (charged>0 normally; charged=0 when betaFreePremium short-circuited the
  // wallet — the machinery is live but the beta user is not debited, by design).
  await writeRow("paid", Number(r.charged ?? 0), opId);
  return { ok: true, source: "paid", charged: Number(r.charged ?? 0), period, expires_at: expiresAt };
}
