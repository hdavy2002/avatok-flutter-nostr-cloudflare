// worker/src/lib/campaign_did_renewal.ts — [AVA-CAMP-P-ENGINE] Lazy monthly
// renewal for a campaign DID (Specs/OUTBOUND-AI-CALLING-CAMPAIGNS.md §5 "DID
// 700/mo lazy renewal, 3-day grace -> past_due pauses campaigns on that DID").
//
// "Lazy" means there is no cron: renewal is checked opportunistically by
// whichever code path happens to touch a `user_dids` row when its
// `next_renewal_at` has come due —
//   - worker/src/do/campaign_do.ts's alarm() admission check (the DID a
//     running campaign is about to dial through), and
//   - worker/src/routes/campaign_dids_route.ts's GET /dids list (renew-on-
//     read, so an owner who never runs a campaign that day still sees an
//     accurate status/next_renewal_at).
// Both call sites are best-effort: a renewal-check failure must never block
// admission or the list response, so this module never throws.
//
// Idempotent via the SAME monthly op_id pattern buyDid() already uses
// (worker/src/routes/campaign_dids_route.ts): `did:<uid>:<e164>:<YYYY-MM>`.
// chargeAmount() (feature_pricing.ts) dedupes a SUCCESSFUL charge on this
// op_id, so re-entering this function multiple times within the same period
// (multiple campaign ticks, multiple /dids list views) charges at most once;
// a FAILED attempt (insufficient balance) is safe to retry with the same
// op_id on a later tick since nothing was charged.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { chargeAmount } from "../feature_pricing";

export const DID_MONTHLY_TOKENS = 700;
export const DID_RENEWAL_FEATURE_KEY = "campaign_did_month";
const MS_PER_DAY = 24 * 3600 * 1000;
export const DID_RENEWAL_PERIOD_MS = 30 * MS_PER_DAY; // mirrors campaign_dids_route.ts's RENEWAL_PERIOD_MS
const DID_RENEWAL_GRACE_MS = 3 * MS_PER_DAY; // spec §5 "3-day grace"

function periodOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7); // "YYYY-MM" — same shape as buyDid()'s opId
}

export interface RenewableDid {
  id: string;
  uid: string;
  e164: string;
  next_renewal_at: number | null;
  status: string;
}

/**
 * Check + (if due) charge this month's DID rental. Never throws — callers
 * (campaign_do.ts admission, campaign_dids_route.ts list) treat a caught
 * exception the same as {status: did.status, renewed:false} would have meant,
 * i.e. "couldn't confirm, don't change anything, try again next lazy check."
 *
 * Contract:
 *   - status !== 'active' on input (already 'past_due'/'released') -> passthrough,
 *     no charge attempted (a past_due/released DID isn't billed further here;
 *     recovering from past_due is a separate/manual flow, out of this task's scope).
 *   - not yet due (next_renewal_at is null or in the future) -> {active, renewed:false}.
 *   - due, charge succeeds -> next_renewal_at += ~30d in D1, {active, renewed:true}.
 *   - due, charge fails, still within the 3-day grace window of the ORIGINAL
 *     due date -> stays active (silently retried next lazy check),
 *     {active, renewed:false}.
 *   - due, charge fails, past the grace window -> user_dids.status='past_due'
 *     in D1, {past_due, renewed:false}.
 */
export async function maybeRenewDid(
  env: Env,
  did: RenewableDid,
): Promise<{ status: "active" | "past_due" | "released"; renewed: boolean }> {
  try {
    if (did.status !== "active") {
      // 'past_due' | 'released' | any other terminal/non-active status —
      // nothing for lazy renewal to do; the caller's own admission/list logic
      // already treats non-'active' as inactive.
      return { status: did.status === "released" ? "released" : "past_due", renewed: false };
    }

    const now = Date.now();
    const nextRenewalAt = did.next_renewal_at ?? 0;
    if (!nextRenewalAt || nextRenewalAt > now) {
      return { status: "active", renewed: false }; // not due yet
    }

    const opId = `did:${did.uid}:${did.e164}:${periodOf(now)}`;
    const charge = await chargeAmount(env, did.uid, DID_RENEWAL_FEATURE_KEY, DID_MONTHLY_TOKENS, opId);

    if (charge.ok) {
      const newNextRenewalAt = nextRenewalAt + DID_RENEWAL_PERIOD_MS;
      try {
        await metaDb(env)
          .prepare(`UPDATE user_dids SET next_renewal_at=?2 WHERE id=?1`)
          .bind(did.id, newNextRenewalAt)
          .run();
      } catch {
        // The charge already landed (idempotent op_id) — a D1 write failure
        // here just means the next lazy check re-derives the same due date
        // and retries the SAME op_id, which chargeAmount's dedupe will treat
        // as an already-satisfied charge rather than double-billing.
      }
      return { status: "active", renewed: true };
    }

    // Charge failed (insufficient balance, or a transient wallet error) —
    // within the 3-day grace period of the ORIGINAL due date, stay active and
    // let a later lazy check retry.
    if (now <= nextRenewalAt + DID_RENEWAL_GRACE_MS) {
      return { status: "active", renewed: false };
    }

    try {
      await metaDb(env).prepare(`UPDATE user_dids SET status='past_due' WHERE id=?1`).bind(did.id).run();
    } catch {
      // Best-effort — if this write fails, the next lazy check simply re-runs
      // the same past-grace charge attempt and re-tries the status flip.
    }
    return { status: "past_due", renewed: false };
  } catch {
    // Never throw into an admission/list path — report the status unchanged
    // (best guess: whatever was passed in, defaulting a non-'active' input
    // straight through) rather than risk a caller crash over a renewal check.
    return { status: did.status === "released" ? "released" : did.status === "past_due" ? "past_due" : "active", renewed: false };
  }
}
