// Phase 2 commercial settlement executor.
//
// Signed terminal provider evidence creates one job per snapshotted order.
// This runner verifies escrow once, records that durable fact, then uses a
// stable WalletDO op_id so retries cannot duplicate creator earnings.

import type { Env } from "./types";
import { metaDb } from "./db/shard";
import { walletOp } from "./routes/wallet";
import { ACCT_PLATFORM_FEES, acctEscrow, acctUser, escrowBalance } from "./ledger";
import { ACCT_PLATFORM_TAX } from "./lib/commercial_tax";
import { commercialEvent } from "./lib/commercial_telemetry";
import { notifyCommercialUsers } from "./lib/commercial_notifications";
import { claimCommercialMoney, completeCommercialMoneyClaim } from "./commercial_money_claim";
import { executeCommercialRefund, finalizeCommercialRefund } from "./lib/commercial_refund_rail";
import { readConfig } from "./routes/config";

type SettlementJob = {
  settlement_job_id: string;
  commercial_session_id: string;
  order_id: string;
  state: string;
  attempts: number;
  funds_verified_at: number | null;
};

type SettlementAuthority = {
  kind: "live_event" | "consult_1to1";
  listing_id: string;
  booking_id: string | null;
  creator_id: string;
  session_state: string;
  live_started_at: number | null;
  scheduled_at: number;
  order_id: string;
  buyer_id: string;
  order_creator_id: string;
  order_amount: number;
  order_status: string;
  policy_snapshot_id: string;
  gross_amount: number;
  currency: string;
  creator_fee_pct: number;
  settlement_hold_hours: number;
  platform_fee_amount: number;
  creator_amount: number;
  cancellation_policy_json: string;
  conversion_snapshot_json: string | null;
  policy_version: string;
  // [TAX-GST-1] Nullable so a snapshot written before the gst migration still loads.
  gst_amount: number | null;
  // [LIVE-GRACE-1] Nullable — NULL for every consult_1to1 and for a live_event
  // that ended normally. 'host_no_return' is the only value that routes here
  // (RULEBOOK-PAID-SESSIONS.md v2 §4 L5) to settleLiveHostNoReturn instead of
  // the two-party deliveryError() decision.
  end_outcome: string | null;
};

type OverdueNoShowAuthority = {
  commercial_session_id: string;
  kind: "live_event" | "consult_1to1";
  listing_id: string;
  booking_id: string | null;
  creator_id: string;
  buyer_id: string;
  order_id: string;
  order_status: string;
  session_state: string;
  settlement_state: string;
  scheduled_at: number;
  policy_snapshot_id: string;
  gross_amount: number;
  currency: string;
  creator_fee_pct: number;
  settlement_hold_hours: number;
  platform_fee_amount: number;
  creator_amount: number;
  cancellation_policy_json: string;
  gst_amount: number | null;
};

function safeJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function markReview(env: Env, jobId: string, reason: string): Promise<void> {
  const now = Date.now();
  await metaDb(env).batch([
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='review_pending',last_error=?2,
        attempts=attempts+1,updated_at=?3 WHERE settlement_job_id=?1`,
    ).bind(jobId, reason.slice(0, 500), now),
    metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
       WHERE commercial_session_id=(SELECT commercial_session_id FROM commercial_settlement_jobs WHERE settlement_job_id=?1)
         AND settlement_state NOT IN ('settled','refunded')`,
    ).bind(jobId, now),
  ]);
  commercialEvent(env, "settlement", null, { outcome: "review_pending", reason: reason.slice(0, 80) });
}

async function loadAuthority(env: Env, job: SettlementJob): Promise<SettlementAuthority | null> {
  return await metaDb(env).prepare(
    `SELECT s.kind,s.listing_id,s.booking_id,s.creator_id,s.state session_state,
      s.live_started_at,s.scheduled_at,s.end_outcome,
      o.id order_id,o.buyer_id,o.creator_id order_creator_id,o.amount order_amount,
      o.status order_status,p.policy_snapshot_id,p.gross_amount,p.currency,
      p.creator_fee_pct,p.settlement_hold_hours,p.platform_fee_amount,p.creator_amount,
      p.cancellation_policy_json,p.conversion_snapshot_json,p.policy_version,
      p.gst_amount
     FROM commercial_sessions s
     JOIN commercial_policy_snapshots p ON p.order_id=?2
       AND p.listing_id=s.listing_id
       AND COALESCE(p.booking_id,'')=COALESCE(s.booking_id,'')
     JOIN orders o ON o.id=p.order_id
     WHERE s.commercial_session_id=?1
       AND NOT EXISTS (
         SELECT 1 FROM commercial_refund_receipts rr
          WHERE rr.order_id=o.id AND rr.settlement_state='refunded'
       )`,
  ).bind(job.commercial_session_id, job.order_id).first<SettlementAuthority>();
}

/** [SETTLE-CHECKIN-1] `sessionCreatorCheckInMin` (default 20) replaces the old
 *  hardcoded 15-minute window — see RULEBOOK-PAID-SESSIONS.md §2 C1/C2. Read via
 *  readConfig() (KV over DEFAULTS), never assumed from the DEFAULTS literal. */
/**
 * [SETTLE-CHECKIN-3] R10: the ONE place `sessionCreatorCheckInMin` /
 * `commercialConsultJoinEarlyMin` are parsed and defaulted. `consultCheckInDecision`,
 * the orphan-no-show sweep (commercial_lifecycle.ts) and the C1 backfill
 * (commercial_session_clock.ts) all call this instead of each re-deriving the same
 * maths and fallback defaults (20 / 10 minutes) — three copies that could silently
 * drift apart is exactly how fix 3's bounded window regresses back to unbounded.
 */
export function resolveConsultCheckInCfg(cfg: Record<string, unknown>): { earlyMs: number; checkInMs: number } {
  const rawCheckIn = Number(cfg.sessionCreatorCheckInMin);
  const rawEarly = Number(cfg.commercialConsultJoinEarlyMin);
  const checkInMin = Number.isFinite(rawCheckIn) && rawCheckIn > 0 ? rawCheckIn : 20;
  const earlyMin = Number.isFinite(rawEarly) && rawEarly >= 0 ? rawEarly : 10;
  return { earlyMs: earlyMin * 60_000, checkInMs: checkInMin * 60_000 };
}

/**
 * [SETTLE-CHECKIN-3] R9: a `consult_1to1` session whose creator DID check in (evidence
 * inside the same window fix 3 uses) but whose state machine never left
 * scheduled/backstage stays in this result set FOREVER on the old query — every cron
 * tick it re-occupies a `LIMIT` slot ahead of genuine no-shows, ordered oldest-first, and
 * starves them. Excluding checked-in sessions here (rather than only skipping them
 * inside `finalizeOverdueNoShow`, fix 2) means they never take a slot at all.
 */
async function loadOverdueNoShowAuthorities(env: Env, limit: number): Promise<OverdueNoShowAuthority[]> {
  const cfg = await readConfig(env) as unknown as Record<string, unknown>;
  const { earlyMs, checkInMs } = resolveConsultCheckInCfg(cfg);
  const now = Date.now();
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await metaDb(env).prepare(
    `SELECT s.commercial_session_id,s.kind,s.listing_id,s.booking_id,s.creator_id,
      o.buyer_id,o.id order_id,o.status order_status,s.state session_state,s.settlement_state,
      s.scheduled_at,p.policy_snapshot_id,p.gross_amount,p.currency,p.creator_fee_pct,
      p.settlement_hold_hours,p.platform_fee_amount,p.creator_amount,p.cancellation_policy_json,p.gst_amount
     FROM commercial_sessions s
     JOIN commercial_policy_snapshots p
       ON p.listing_id=s.listing_id AND COALESCE(p.booking_id,'')=COALESCE(s.booking_id,'')
     JOIN orders o ON o.id=p.order_id
     WHERE s.state IN ('scheduled','backstage')
       AND s.settlement_state NOT IN ('settled','refunded')
       AND s.scheduled_at <= ?1
       AND (s.kind <> 'consult_1to1' OR (
         NOT EXISTS (
           SELECT 1 FROM session_attendance a
            WHERE a.session_id=s.booking_id AND a.role='host' AND a.user_id=s.creator_id
              AND a.joined_at<=s.scheduled_at+?2 AND COALESCE(a.left_at,?3)>=s.scheduled_at-?4
         )
         AND NOT EXISTS (
           SELECT 1 FROM commercial_participant_intervals i
            JOIN commercial_session_members m
              ON m.commercial_session_id=i.commercial_session_id AND m.account_id=i.account_id
            WHERE i.commercial_session_id=s.commercial_session_id AND m.role='creator' AND i.account_id=s.creator_id
              AND i.joined_at<=s.scheduled_at+?2 AND COALESCE(i.left_at,?3)>=s.scheduled_at-?4
         )
       ))
     ORDER BY s.scheduled_at ASC
     LIMIT ?5`,
  ).bind(now - checkInMs, checkInMs, now, earlyMs, safeLimit).all<OverdueNoShowAuthority>();
  return rows.results ?? [];
}

async function deliveryError(
  env: Env,
  sessionId: string,
  authority: SettlementAuthority,
): Promise<string | null> {
  let policy: Record<string, unknown>;
  try { policy = JSON.parse(authority.cancellation_policy_json) as Record<string, unknown>; } catch {
    return "commercial policy snapshot is invalid";
  }
  if (policy.auto_release_on_provider_end !== true) {
    return "commercial policy requires settlement review";
  }
  const configuredMinimum = Number(policy.min_connected_ms);
  const minimumMs = Number.isFinite(configuredMinimum) && configuredMinimum >= 0
    ? Math.trunc(configuredMinimum)
    : 60_000;
  if (authority.kind === "live_event") {
    if (!authority.live_started_at) return "live event never reached provider-confirmed live state";
    const host = await metaDb(env).prepare(
      `SELECT COALESCE(SUM(i.connected_ms),0) total
       FROM commercial_participant_intervals i
       JOIN commercial_session_members m
         ON m.commercial_session_id=i.commercial_session_id AND m.account_id=i.account_id
       WHERE i.commercial_session_id=?1 AND m.role='host'
         AND i.reconciliation_state IN ('closed','reconciled')`,
    ).bind(sessionId).first<{ total: number }>();
    return Number(host?.total ?? 0) >= minimumMs ? null : "insufficient signed host delivery evidence";
  }
  const overlap = await metaDb(env).prepare(
    `SELECT COALESCE(MAX(
      MAX(0,MIN(c.left_at,b.left_at)-MAX(c.joined_at,b.joined_at))
    ),0) overlap_ms
     FROM commercial_participant_intervals c
     JOIN commercial_session_members cm
       ON cm.commercial_session_id=c.commercial_session_id AND cm.account_id=c.account_id
     JOIN commercial_participant_intervals b
       ON b.commercial_session_id=c.commercial_session_id
     JOIN commercial_session_members bm
       ON bm.commercial_session_id=b.commercial_session_id AND bm.account_id=b.account_id
     WHERE c.commercial_session_id=?1 AND cm.role='creator' AND bm.role='buyer'
       AND c.reconciliation_state IN ('closed','reconciled')
       AND b.reconciliation_state IN ('closed','reconciled')
       AND c.left_at IS NOT NULL AND b.left_at IS NOT NULL`,
  ).bind(sessionId).first<{ overlap_ms: number }>();
  let delivered = Number(overlap?.overlap_ms ?? 0);
  if (authority.policy_version.endsWith(":extension")) {
    let boundary: { base_ends_at?: number; extension_ends_at?: number } = {};
    try { boundary = JSON.parse(authority.conversion_snapshot_json ?? "{}"); } catch { return "extension delivery boundary unavailable"; }
    if (!Number.isSafeInteger(boundary.base_ends_at) || !Number.isSafeInteger(boundary.extension_ends_at)
      || Number(boundary.extension_ends_at) <= Number(boundary.base_ends_at)) return "extension delivery boundary invalid";
    const incremental = await metaDb(env).prepare(
      `SELECT COALESCE(MAX(MAX(0,MIN(c.left_at,b.left_at,?3)-MAX(c.joined_at,b.joined_at,?2))),0) overlap_ms
       FROM commercial_participant_intervals c
       JOIN commercial_session_members cm ON cm.commercial_session_id=c.commercial_session_id AND cm.account_id=c.account_id
       JOIN commercial_participant_intervals b ON b.commercial_session_id=c.commercial_session_id
       JOIN commercial_session_members bm ON bm.commercial_session_id=b.commercial_session_id AND bm.account_id=b.account_id
       WHERE c.commercial_session_id=?1 AND cm.role='creator' AND bm.role='buyer'
         AND c.reconciliation_state IN ('closed','reconciled') AND b.reconciliation_state IN ('closed','reconciled')
         AND c.left_at IS NOT NULL AND b.left_at IS NOT NULL
         AND c.left_at>?2 AND b.left_at>?2 AND c.joined_at<?3 AND b.joined_at<?3`,
    ).bind(sessionId, Number(boundary.base_ends_at), Number(boundary.extension_ends_at)).first<{ overlap_ms: number }>();
    delivered = Number(incremental?.overlap_ms ?? 0);
  }
  return delivered >= minimumMs
    ? null
    : "insufficient signed two-party delivery evidence";
}

/**
 * [SETTLE-CHECKIN-2] fix 3: the check-in window is an OVERLAP test, not a one-sided
 * `joined_at <= closesAt`. Exported so `commercial_lifecycle.ts` (the orphan no-show
 * sweep, fix 1) and `commercial_session_clock.ts` (the C1 backfill) compute the exact
 * same window instead of re-deriving their own copy.
 *
 * [SETTLE-CHECKIN-3] R10: takes already-resolved milliseconds (`resolveConsultCheckInCfg`'s
 * output), not raw config minutes — the minutes-to-ms conversion and its defaulting
 * happen in exactly ONE place now, not here too.
 */
export function consultCheckInWindow(
  startsAt: number,
  earlyMs: number,
  checkInMs: number,
): { opensAt: number; closesAt: number } {
  return { opensAt: startsAt - Math.max(0, Math.trunc(Number(earlyMs))), closesAt: startsAt + Math.max(0, Math.trunc(Number(checkInMs))) };
}

/**
 * [SETTLE-CHECKIN-1] The check-in decision for a 1:1 consult (RULEBOOK-PAID-SESSIONS.md
 * §2, contract in Specs/PLAN-2026-09-11-WAITING-ROOM-BUILD.md). Replaces the two-party
 * GetStream-overlap test (`deliveryError`, still used for live_event) for consults: the
 * creator is checked in iff a `session_attendance` row with role='host' for THIS creator
 * overlaps `[starts_at - commercialConsultJoinEarlyMin, starts_at + sessionCreatorCheckInMin]`
 * (fix 3 -- a one-sided `joined_at <= closesAt` test let a check-in from the day before
 * count), OR a `commercial_participant_intervals` row for the creator (role='creator' in
 * `commercial_session_members`) overlaps the same window. Whether the BUYER ever joined
 * is irrelevant to this decision (C1: checked in → full price, no matter when or
 * whether the customer joins).
 */
export async function consultCheckInDecision(
  env: Env,
  sessionId: string,
  bookingId: string | null,
  startsAt: number,
  creatorId: string,
): Promise<{ checkedIn: boolean; checkedInAt: number | null }> {
  const cfg = await readConfig(env) as unknown as Record<string, unknown>;
  const { earlyMs, checkInMs } = resolveConsultCheckInCfg(cfg);
  const { opensAt, closesAt } = consultCheckInWindow(startsAt, earlyMs, checkInMs);
  const now = Date.now();
  if (bookingId) {
    const att = await metaDb(env).prepare(
      `SELECT MIN(joined_at) at FROM session_attendance
        WHERE session_id=?1 AND role='host' AND user_id=?2
          AND joined_at<=?3 AND COALESCE(left_at,?4)>=?5`,
    ).bind(bookingId, creatorId, closesAt, now, opensAt).first<{ at: number | null }>();
    if (att?.at != null) return { checkedIn: true, checkedInAt: Number(att.at) };
  }
  const interval = await metaDb(env).prepare(
    `SELECT MIN(i.joined_at) at
       FROM commercial_participant_intervals i
       JOIN commercial_session_members m
         ON m.commercial_session_id=i.commercial_session_id AND m.account_id=i.account_id
      WHERE i.commercial_session_id=?1 AND m.role='creator' AND i.account_id=?2
        AND i.joined_at<=?3 AND COALESCE(i.left_at,?4)>=?5`,
  ).bind(sessionId, creatorId, closesAt, now, opensAt).first<{ at: number | null }>();
  if (interval?.at != null) return { checkedIn: true, checkedInAt: Number(interval.at) };
  return { checkedIn: false, checkedInAt: null };
}

/**
 * [SETTLE-CHECKIN-1] Mirrors the `account_strikes` insert in money_engine.ts's
 * `applyAction` "strike" case — same columns, same `source`/`action_taken` shape — so a
 * creator's strike history reads the same regardless of which engine recorded it.
 * Best-effort: a strike-write failure must never block or roll back the refund it rides
 * with (the refund is the money-safety property; the strike is a policy record).
 */
export async function insertNoShowStrike(env: Env, creatorId: string, orderId: string, sessionId: string): Promise<void> {
  try {
    // [SETTLE-CHECKIN-2] fix 7: deterministic id keyed by order_id + INSERT OR IGNORE —
    // a retried settlement job (or the overdue sweep racing the settlement job on the
    // same order) must strike the creator at most once per order, not once per attempt.
    await metaDb(env).prepare(
      `INSERT OR IGNORE INTO account_strikes
         (id, uid, clerk_user_id, category, evidence_url, ai_confidence, source, action_taken, created_at)
       VALUES (?1,?2,?2,'marketplace_no_show',?3,NULL,'commercial_settlement','strike',?4)`,
    ).bind(`strike:no-show:${orderId}`, creatorId, sessionId, Date.now()).run();
  } catch (e) { console.warn("commercial no-show strike write skipped:", String(e)); }
}

function authorityError(value: SettlementAuthority): string | null {
  const gross = Math.trunc(Number(value.gross_amount));
  const creator = Math.trunc(Number(value.creator_amount));
  const platform = Math.trunc(Number(value.platform_fee_amount));
  const pct = Number(value.creator_fee_pct);
  const hold = Number(value.settlement_hold_hours);
  if (value.session_state !== "ended") return "session is not terminal";
  if (value.creator_id !== value.order_creator_id) return "creator authority mismatch";
  if (gross !== Math.trunc(Number(value.order_amount)) || gross < 0) return "gross snapshot mismatch";
  if (creator < 0 || platform < 0 || creator + platform !== gross) return "split snapshot mismatch";
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "creator percentage invalid";
  if (creator !== Math.round(gross * pct / 100)) return "creator amount does not match percentage";
  if (!Number.isFinite(hold) || hold < 0 || hold > 365 * 24) return "settlement hold invalid";
  // [TAX-GST-1] Tax is validated but NOT folded into the split assertion above: the
  // creator + platform === gross identity is exactly what proves the creator is not being
  // paid out of tax money, and it must keep holding with tax switched on.
  const gst = Math.trunc(Number(value.gst_amount ?? 0));
  if (!Number.isInteger(gst) || gst < 0) return "gst snapshot invalid";
  if (!["held", "free", "settled"].includes(value.order_status)) return "order is not settleable";
  return null;
}

async function releaseSnapshot(
  env: Env,
  authority: SettlementAuthority,
): Promise<{ duplicate: boolean }> {
  const gross = Math.trunc(Number(authority.gross_amount));
  const creatorAmount = Math.trunc(Number(authority.creator_amount));
  const platformAmount = Math.trunc(Number(authority.platform_fee_amount));
  const gstAmount = Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
  // [TAX-GST-1] A free listing can still carry no tax; both being zero means nothing to
  // move. Guard on the total so a hypothetical zero-price-with-tax order is not skipped.
  if (gross === 0 && gstAmount === 0) return { duplicate: false };

  const opId = `commercial:release:${authority.order_id}`;
  let duplicate = false;
  if (creatorAmount > 0) {
    const result = await walletOp(env, authority.creator_id, {
      op: "earn",
      uid: authority.creator_id,
      amount: creatorAmount,
      commission: platformAmount,
      hold_hours: Math.trunc(Number(authority.settlement_hold_hours)),
      app_name: authority.kind === "live_event" ? "avalive" : "avaconsult",
      ref: authority.order_id,
      op_id: opId,
      ledger: {
        debit: acctEscrow(authority.order_id),
        credit: acctUser(authority.creator_id),
        type: "commercial_escrow_release",
        ref: authority.order_id,
        meta: JSON.stringify({
          gross,
          creator_amount: creatorAmount,
          platform_fee_amount: platformAmount,
          creator_fee_pct: authority.creator_fee_pct,
          policy_snapshot_id: authority.policy_snapshot_id,
        }),
      },
    });
    if (result.status !== 200) throw new Error(`commercial creator release failed: ${result.status}`);
    duplicate = result.body?.duplicate === true;
  }
  if (platformAmount > 0) {
    await env.Q_WALLET.send({
      id: `commercial:fee:${authority.order_id}`,
      ts: Date.now(),
      amount: platformAmount,
      ledger: {
        debit: acctEscrow(authority.order_id),
        credit: ACCT_PLATFORM_FEES,
        type: "commercial_platform_fee",
        ref: authority.order_id,
        meta: JSON.stringify({
          gross,
          creator_fee_pct: authority.creator_fee_pct,
          policy_snapshot_id: authority.policy_snapshot_id,
        }),
      },
    });
  }
  // [TAX-GST-1] The tax leg. Out of escrow, into the platform's TAX-LIABILITY account —
  // never ACCT_PLATFORM_FEES, which is revenue. GST is money held on behalf of a tax
  // authority and mixing it into fees makes it unremittable and overstates income.
  // Paid LAST so a failure here cannot strand a creator unpaid; the money stays in escrow
  // and the job's own retry picks it up (the op id makes the earlier legs idempotent).
  if (gstAmount > 0) {
    await env.Q_WALLET.send({
      id: `commercial:gst:${authority.order_id}`,
      ts: Date.now(),
      amount: gstAmount,
      ledger: {
        debit: acctEscrow(authority.order_id),
        credit: ACCT_PLATFORM_TAX,
        type: "commercial_gst",
        ref: authority.order_id,
        meta: JSON.stringify({
          gst_amount: gstAmount,
          taxable_base: gross,
          policy_snapshot_id: authority.policy_snapshot_id,
        }),
      },
    });
  }
  return { duplicate };
}

/**
 * [COMM-NOSHOW-1] How long the party who OWES the session was actually connected.
 *
 * deliveryError() answers "was it delivered"; this answers "by whom was it not". The
 * distinction decides who keeps the money: a creator who never showed owes a refund,
 * while a buyer who never showed is `no_show_policy: session_charged` and the creator
 * is paid. Collapsing the two — which is what parking everything in review_pending did —
 * treats a creator no-show and a buyer no-show identically, and one of those is theft
 * from the buyer while the other is theft from the creator.
 */
async function creatorConnectedMs(env: Env, sessionId: string, kind: string): Promise<number> {
  const role = kind === "live_event" ? "host" : "creator";
  const row = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(i.connected_ms),0) total
       FROM commercial_participant_intervals i
       JOIN commercial_session_members m
         ON m.commercial_session_id=i.commercial_session_id AND m.account_id=i.account_id
      WHERE i.commercial_session_id=?1 AND m.role=?2
        AND i.reconciliation_state IN ('closed','reconciled')`,
  ).bind(sessionId, role).first<{ total: number }>();
  return Math.max(0, Math.trunc(Number(row?.total ?? 0)));
}

async function connectedMs(env: Env, sessionId: string, buyerId: string): Promise<number> {
  const row = await metaDb(env).prepare(
    `SELECT COALESCE(SUM(connected_ms),0) total FROM commercial_participant_intervals
     WHERE commercial_session_id=?1 AND account_id=?2
       AND reconciliation_state IN ('closed','reconciled')`,
  ).bind(sessionId, buyerId).first<{ total: number }>();
  return Math.max(0, Math.trunc(Number(row?.total ?? 0)));
}

async function finishSettlement(
  env: Env,
  job: SettlementJob,
  authority: SettlementAuthority,
  // [SETTLE-CHECKIN-1] null for live_event (unchanged decision) and for a consult that
  // somehow reaches this function without check-in evidence having been read (should not
  // happen — processJob always resolves this before calling in). 'creator_checked_in' is
  // the only rule this function ever writes; 'creator_no_show' is written on the refund
  // path instead (see processJob), which never reaches here.
  checkIn: { rule: "creator_checked_in"; checkedInAt: number } | null = null,
): Promise<void> {
  const receiptId = `commercial:receipt:${authority.order_id}`;
  const duration = await connectedMs(env, job.commercial_session_id, authority.buyer_id);
  const now = Date.now();
  const rule = checkIn?.rule ?? null;
  const checkedInAt = checkIn?.checkedInAt ?? null;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_receipts
       (receipt_id,commercial_session_id,order_id,listing_id,booking_id,buyer_id,
        creator_id,kind,gross_amount,platform_fee_amount,creator_amount,currency,
        settlement_state,connected_ms,policy_snapshot_id,issued_at,rule,checked_in_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'settled',?13,?14,?15,?16,?17)`,
  ).bind(
    receiptId, job.commercial_session_id, authority.order_id, authority.listing_id,
    authority.booking_id, authority.buyer_id, authority.creator_id, authority.kind,
    authority.gross_amount, authority.platform_fee_amount, authority.creator_amount,
    authority.currency, duration, authority.policy_snapshot_id, now, rule, checkedInAt,
  ).run();

  const receipt = await metaDb(env).prepare(
    `SELECT commercial_session_id,order_id,listing_id,booking_id,buyer_id,creator_id,
      kind,gross_amount,platform_fee_amount,creator_amount,currency,settlement_state,
      connected_ms,policy_snapshot_id,rule,checked_in_at FROM commercial_receipts WHERE receipt_id=?1`,
  ).bind(receiptId).first<Record<string, unknown>>();
  if (!receipt
    || receipt.commercial_session_id !== job.commercial_session_id
    || receipt.order_id !== authority.order_id
    || receipt.listing_id !== authority.listing_id
    || (receipt.booking_id ?? null) !== (authority.booking_id ?? null)
    || receipt.buyer_id !== authority.buyer_id
    || receipt.creator_id !== authority.creator_id
    || receipt.kind !== authority.kind
    || Number(receipt.gross_amount) !== Number(authority.gross_amount)
    || Number(receipt.platform_fee_amount) !== Number(authority.platform_fee_amount)
    || Number(receipt.creator_amount) !== Number(authority.creator_amount)
    || receipt.currency !== authority.currency
    || receipt.settlement_state !== "settled"
    || Number(receipt.connected_ms) !== duration
    || receipt.policy_snapshot_id !== authority.policy_snapshot_id
    // [SETTLE-CHECKIN-2] fix 6: a receipt written before this migration has rule=NULL
    // forever (receipts are immutable) — that must never read as a mismatch against a
    // job that now computes a real rule, or a retried pre-migration job throws and
    // never settles. Only a receipt that already carries a rule must match exactly.
    || ((receipt.rule ?? null) !== null
      && ((receipt.rule ?? null) !== rule || (receipt.checked_in_at ?? null) !== checkedInAt))) {
    throw new Error("commercial receipt immutable replay mismatch");
  }
  await metaDb(env).batch([
    metaDb(env).prepare(
      "UPDATE orders SET status='settled',updated_at=?2 WHERE id=?1 AND status IN ('held','free','settled')",
    ).bind(authority.order_id, now),
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='settled',ledger_confirmed_at=COALESCE(ledger_confirmed_at,?2),
        attempts=attempts+1,last_error=NULL,updated_at=?2 WHERE settlement_job_id=?1`,
    ).bind(job.settlement_job_id, now),
  ]);
  await completeCommercialMoneyClaim(env, {
    orderId: authority.order_id,
    claimType: "settlement",
    claimId: job.settlement_job_id,
  });

  const remaining = await metaDb(env).prepare(
    `SELECT COUNT(*) count FROM commercial_settlement_jobs
     WHERE commercial_session_id=?1 AND state NOT IN ('settled','refunded')`,
  ).bind(job.commercial_session_id).first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='settled',updated_at=?2
       WHERE commercial_session_id=?1 AND state='ended'`,
    ).bind(job.commercial_session_id, Date.now()).run();
  }
  await notifyCommercialUsers(env, [authority.buyer_id, authority.creator_id], {
    type: "commercial_receipt",
    eventId: receiptId,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    sessionId: job.commercial_session_id,
    title: "Commercial receipt ready",
    body: "Your commercial receipt is ready to view.",
  });
  commercialEvent(env, "settlement", null, { kind: authority.kind, outcome: "settled" });
}

/**
 * [LIVE-GRACE-1] RULEBOOK-PAID-SESSIONS.md v2 §4 L5 — the slot is the
 * listing's scheduled duration, starting at `scheduled_at`. `duration_min`
 * missing or non-positive (should not happen for a published live_event) is
 * a defensive 60-minute fallback, not a silent zero-refund.
 */
async function slotMsForListing(env: Env, listingId: string): Promise<number> {
  const row = await metaDb(env).prepare(
    "SELECT duration_min FROM listings WHERE id=?1",
  ).bind(listingId).first<{ duration_min: number | null }>();
  const min = Number(row?.duration_min);
  return (Number.isFinite(min) && min > 0 ? min : 60) * 60_000;
}

/**
 * [LIVE-GRACE-1] This ticket holder's connected time inside the slot, minus
 * whatever overlaps a recorded host outage window (commercial_live_outages —
 * armed on the host's `participant_left`, closed on rejoin or on the grace
 * alarm firing). A viewer who stayed connected through the whole outage is
 * not charged for it even though their own interval never closed for it.
 *
 * [SETTLE-CHECKIN-3] R15: every interval is clipped to `[windowStart, windowEnd]`
 * (the listing's slot) before any subtraction. An interval that started before the
 * slot (an early-join grace) or that never closed and is read long after `windowEnd`
 * must not inflate either the eligible or the outage total beyond what the ticket
 * actually covers.
 */
async function watchedEligibleMs(
  env: Env, sessionId: string, buyerId: string, windowStart: number, windowEnd: number,
): Promise<number> {
  return (await outageSplit(env, sessionId, buyerId, windowStart, windowEnd)).eligibleMs;
}

/**
 * [SETTLE-CHECKIN-3] R11: the same clipped intervals, but summing the OUTAGE overlap
 * instead of subtracting it — this is "how many of this ticket's watched minutes fell
 * inside a recorded host outage", which RULEBOOK-PAID-SESSIONS.md v2 §4 L4 says must be
 * refunded pro-rata even when the host returns within grace (a normal end, never routed
 * through `settleLiveHostNoReturn`). Shares one query pass with `watchedEligibleMs`
 * (eligible + outage always sum to the clipped connected time) so the two can never
 * drift apart from independently-rounded or independently-clipped arithmetic.
 */
async function outageOverlapMs(
  env: Env, sessionId: string, buyerId: string, windowStart: number, windowEnd: number,
): Promise<number> {
  return (await outageSplit(env, sessionId, buyerId, windowStart, windowEnd)).outageMs;
}

async function outageSplit(
  env: Env, sessionId: string, buyerId: string, windowStart: number, windowEnd: number,
): Promise<{ eligibleMs: number; outageMs: number }> {
  const intervals = await metaDb(env).prepare(
    `SELECT joined_at,COALESCE(left_at,joined_at) left_at FROM commercial_participant_intervals
       WHERE commercial_session_id=?1 AND account_id=?2
         AND reconciliation_state IN ('closed','reconciled')`,
  ).bind(sessionId, buyerId).all<{ joined_at: number; left_at: number }>();
  const outages = await metaDb(env).prepare(
    `SELECT started_at,COALESCE(ended_at,started_at) ended_at FROM commercial_live_outages
       WHERE commercial_session_id=?1`,
  ).bind(sessionId).all<{ started_at: number; ended_at: number }>();
  let eligible = 0;
  let outageMs = 0;
  for (const iv of intervals.results ?? []) {
    const start = Math.max(Number(iv.joined_at), windowStart);
    const end = Math.min(Number(iv.left_at), windowEnd);
    if (end <= start) continue;
    let ivOutage = 0;
    for (const outage of outages.results ?? []) {
      const overlap = Math.max(0, Math.min(end, Number(outage.ended_at))
        - Math.max(start, Number(outage.started_at)));
      ivOutage += overlap;
    }
    ivOutage = Math.min(ivOutage, end - start);
    eligible += (end - start) - ivOutage;
    outageMs += ivOutage;
  }
  return { eligibleMs: Math.max(0, Math.trunc(eligible)), outageMs: Math.max(0, Math.trunc(outageMs)) };
}

/**
 * [SETTLE-CHECKIN-3] R5: derive the platform's consumed share as the REMAINDER after
 * the gross refund and the creator's (independently rounded) consumed share, rather
 * than rounding a third independent fraction. Rounding three shares independently can
 * drift the sum away from `gross` by ±1 in either direction — over, and the three legs
 * try to move more than escrow holds; under, and a token is stranded in escrow forever.
 * This way `refundGross + consumedCreatorAmount + consumedPlatformAmount === gross`,
 * exactly, every time.
 */
export function partialRefundSplit(
  gross: number, gstAmount: number, creatorAmount: number, platformAmount: number, refundFraction: number,
): {
  refundGross: number; refundGst: number; refundable: number;
  consumedCreatorAmount: number; consumedPlatformAmount: number; consumedGstAmount: number;
} {
  const fraction = Math.max(0, Math.min(1, refundFraction));
  const refundGross = Math.round(gross * fraction);
  const refundGst = Math.round(gstAmount * fraction);
  const consumedCreatorAmount = creatorAmount - Math.round(creatorAmount * fraction);
  const consumedPlatformAmount = Math.max(0, (gross - refundGross) - consumedCreatorAmount);
  const consumedGstAmount = gstAmount - refundGst;
  return {
    refundGross, refundGst, refundable: refundGross + refundGst,
    consumedCreatorAmount, consumedPlatformAmount, consumedGstAmount,
  };
}

/**
 * [SETTLE-CHECKIN-3] R2 BLOCKER fix: write the refund leg of a PARTIAL commercial
 * settlement directly into `commercial_refund_receipts` with `settlement_state=
 * 'partial_refund'` (a state that table's own CHECK constraint already allows — it was
 * simply never used). This must never go through `finalizeCommercialRefund`: that
 * helper hardcodes `creator_amount=0`/`remaining_amount=0` and marks the order,
 * booking, entitlements AND settlement job fully 'refunded' — correct for a 100%
 * refund, and wrong here, where the creator is still owed his consumed share and the
 * settlement job that pays it still has to run. `INSERT OR IGNORE` on a receipt id
 * derived from the order makes a retry's refund-recording idempotent without
 * re-touching order/job state a second time.
 */
export async function recordPartialRefundReceipt(env: Env, args: {
  orderId: string; sessionId: string | null; listingId: string; bookingId: string | null;
  buyerId: string; creatorId: string; kind: string; grossAmount: number; refundedAmount: number;
  consumedCreatorAmount: number; consumedPlatformAmount: number; consumedGstAmount: number;
  currency: string; policySnapshotId: string; reason: string;
}): Promise<void> {
  const remainingAmount = args.consumedCreatorAmount + args.consumedPlatformAmount + args.consumedGstAmount;
  await metaDb(env).prepare(
    `INSERT OR IGNORE INTO commercial_refund_receipts
     (refund_receipt_id,order_id,commercial_session_id,listing_id,booking_id,buyer_id,creator_id,
      kind,gross_amount,refunded_amount,remaining_amount,platform_fee_amount,creator_amount,
      currency,settlement_state,reason,actor,policy_snapshot_id,issued_at,gst_amount)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'partial_refund',?15,'system',?16,?17,?18)`,
  ).bind(
    `commercial-refund:${args.orderId}`, args.orderId, args.sessionId, args.listingId, args.bookingId,
    args.buyerId, args.creatorId, args.kind, args.grossAmount, args.refundedAmount, remainingAmount,
    args.consumedPlatformAmount, args.consumedCreatorAmount, args.currency, args.reason.slice(0, 200),
    args.policySnapshotId, Date.now(), args.consumedGstAmount,
  ).run();
}

/**
 * [SETTLE-CHECKIN-3] R2 BLOCKER fix: ONE claim, of type 'settlement', held around BOTH
 * legs (refund leg + release leg) of a partial commercial settlement. The old
 * `settleLiveHostNoReturn` took a 'refund' claim for the first leg and completed it,
 * then tried to take a SEPARATE 'settlement' claim for the second — but
 * `commercial_money_claims.order_id` is the table's primary key (one claim per order,
 * ever), so that second claim could never be owned once the first had been. Every
 * partial refund went to review_pending forever with the creator's share stuck in
 * escrow, and a retry could not recover it either (the receipt `finalizeCommercialRefund`
 * wrote already read as a full, terminal refund). Used by both `settleLiveHostNoReturn`
 * (R2) and the new outage-minutes refund (R11) — one helper, one claim discipline.
 */
async function applyPartialCommercialSettlement(
  env: Env, job: SettlementJob, authority: SettlementAuthority,
  parts: ReturnType<typeof partialRefundSplit> & { reason: string; claimId: string; telemetryOutcome: string },
): Promise<void> {
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id, claimType: "settlement", claimId: parts.claimId,
  });
  if (!claim.owned) {
    const owner = claim.existing ? `${claim.existing.claim_type}:${claim.existing.claim_id}` : "unknown";
    return await markReview(env, job.settlement_job_id, `commercial money claim owned by ${owner}`);
  }
  if (parts.refundable > 0) {
    const money = await executeCommercialRefund(env, {
      orderId: authority.order_id, buyerId: authority.buyer_id, amount: parts.refundable, reason: parts.reason,
    });
    if (!money.ok) return await markReview(env, job.settlement_job_id, `${parts.reason}_refund_failed:${money.error}`);
    await recordPartialRefundReceipt(env, {
      orderId: authority.order_id, sessionId: job.commercial_session_id, listingId: authority.listing_id,
      bookingId: authority.booking_id, buyerId: authority.buyer_id, creatorId: authority.creator_id,
      kind: authority.kind, grossAmount: Math.trunc(Number(authority.gross_amount)), refundedAmount: parts.refundable,
      consumedCreatorAmount: parts.consumedCreatorAmount, consumedPlatformAmount: parts.consumedPlatformAmount,
      consumedGstAmount: parts.consumedGstAmount, currency: authority.currency,
      policySnapshotId: authority.policy_snapshot_id, reason: parts.reason,
    });
  }

  const consumed: SettlementAuthority = {
    ...authority,
    creator_amount: parts.consumedCreatorAmount,
    platform_fee_amount: parts.consumedPlatformAmount,
    gst_amount: parts.consumedGstAmount,
  };
  if (parts.consumedCreatorAmount > 0 || parts.consumedPlatformAmount > 0 || parts.consumedGstAmount > 0) {
    await releaseSnapshot(env, consumed);
  }
  // [SETTLE-CHECKIN-3] R2: the order only becomes 'settled' HERE, inside
  // finishSettlement -- once the creator's consumed share has actually been released --
  // never earlier via a refund-path helper that would mark it 'refunded' while money is
  // still owed out to the creator.
  await finishSettlement(env, job, consumed, null);
  commercialEvent(env, "settlement", null, { outcome: parts.telemetryOutcome, kind: authority.kind });
}

async function ensureFundsVerified(env: Env, job: SettlementJob, authority: SettlementAuthority): Promise<string | null> {
  const gross = Math.trunc(Number(authority.gross_amount));
  const gstAmount = Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
  const escrowRequired = gross + gstAmount;
  if (job.funds_verified_at || escrowRequired <= 0) return null;
  const available = await escrowBalance(env, authority.order_id);
  if (available < escrowRequired) return "escrow balance below immutable gross";
  const verifiedAt = Date.now();
  await metaDb(env).prepare(
    `UPDATE commercial_settlement_jobs SET funds_verified_at=?2,updated_at=?2
     WHERE settlement_job_id=?1 AND funds_verified_at IS NULL`,
  ).bind(job.settlement_job_id, verifiedAt).run();
  job.funds_verified_at = verifiedAt;
  return null;
}

/**
 * [LIVE-GRACE-1] RULEBOOK-PAID-SESSIONS.md v2 §4 L5: `refund = gross ×
 * (slot_ms − watched_eligible_ms) / slot_ms` for this ticket, gst pro-rated
 * the same way. The consumed remainder (gross/gst/creator/platform amounts
 * scaled by the watched fraction) is released through the SAME
 * releaseSnapshot()/finishSettlement() rails a normal settlement uses — "the
 * rest" of the RULEBOOK sentence — just with the reduced creator/platform
 * split; the receipt keeps the ORIGINAL `gross_amount` for audit (the ticket
 * price never changes, only how much of it the creator/platform actually
 * keep vs refund).
 */
async function settleLiveHostNoReturn(env: Env, job: SettlementJob, authority: SettlementAuthority): Promise<void> {
  const reviewReason = await ensureFundsVerified(env, job, authority);
  if (reviewReason) return await markReview(env, job.settlement_job_id, reviewReason);

  const slotMs = await slotMsForListing(env, authority.listing_id);
  const watchedMs = await watchedEligibleMs(env, job.commercial_session_id, authority.buyer_id, authority.scheduled_at, authority.scheduled_at + slotMs);
  const unwatchedFraction = slotMs > 0 ? (slotMs - watchedMs) / slotMs : 1;
  const parts = partialRefundSplit(
    Math.trunc(Number(authority.gross_amount)), Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0))),
    Math.trunc(Number(authority.creator_amount)), Math.trunc(Number(authority.platform_fee_amount)), unwatchedFraction,
  );
  await applyPartialCommercialSettlement(env, job, authority, {
    ...parts, reason: "host_no_return",
    claimId: `host-no-return:${job.settlement_job_id}`,
    telemetryOutcome: "host_no_return_partial",
  });
}

/**
 * [SETTLE-CHECKIN-3] R11: RULEBOOK-PAID-SESSIONS.md v2 §4 L4 -- the host dropped and
 * RETURNED within grace (this session did NOT end via `settleLiveHostNoReturn`'s
 * `end_outcome==='host_no_return'` path), so the event itself is a normal, fully
 * delivered show. But every minute recorded in `commercial_live_outages` for it is a
 * minute nobody could have been watching ANY host, and RULEBOOK says those minutes are
 * "not charged: refunded pro-rata to everyone who was waiting" -- not "the whole slot
 * pays full because the host came back". Reuses the exact same claim/receipt/release
 * plumbing as R2's host-no-return path (`applyPartialCommercialSettlement`), just with
 * an outage-overlap fraction instead of an unwatched-from-end fraction.
 *
 * Scope: this covers ONLY the money -- refunding the outage minutes once a session with
 * outage rows ends normally. It does not add any new outage detection (that already
 * exists: `commercial_live_outages` rows are armed/closed elsewhere, outside this file)
 * and it bypasses `deliveryError`'s host-delivery-sufficiency check for these sessions,
 * which is safe by construction: an outage row only ever exists for a host who WAS
 * live and connected before dropping, so the evidentiary question that check answers is
 * already settled.
 */
async function settleLiveOutageRefund(env: Env, job: SettlementJob, authority: SettlementAuthority): Promise<void> {
  const reviewReason = await ensureFundsVerified(env, job, authority);
  if (reviewReason) return await markReview(env, job.settlement_job_id, reviewReason);

  const slotMs = await slotMsForListing(env, authority.listing_id);
  const windowEnd = authority.scheduled_at + slotMs;
  const outageMs = await outageOverlapMs(env, job.commercial_session_id, authority.buyer_id, authority.scheduled_at, windowEnd);
  const outageFraction = slotMs > 0 ? outageMs / slotMs : 0;
  const parts = partialRefundSplit(
    Math.trunc(Number(authority.gross_amount)), Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0))),
    Math.trunc(Number(authority.creator_amount)), Math.trunc(Number(authority.platform_fee_amount)), outageFraction,
  );
  await applyPartialCommercialSettlement(env, job, authority, {
    ...parts, reason: "host_outage_grace",
    claimId: `host-outage:${job.settlement_job_id}`,
    telemetryOutcome: "host_outage_partial",
  });
}

async function hasRecordedOutage(env: Env, sessionId: string): Promise<boolean> {
  const row = await metaDb(env).prepare(
    "SELECT 1 ok FROM commercial_live_outages WHERE commercial_session_id=?1 LIMIT 1",
  ).bind(sessionId).first<{ ok: number }>();
  return row != null;
}

async function processJob(env: Env, job: SettlementJob): Promise<void> {
  const authority = await loadAuthority(env, job);
  if (!authority) return await markReview(env, job.settlement_job_id, "missing immutable settlement authority");
  const invalid = authorityError(authority);
  if (invalid) return await markReview(env, job.settlement_job_id, invalid);

  // [SETTLE-CHECKIN-1] Live events keep the two-party GetStream-overlap decision
  // (`deliveryError`) untouched — RULEBOOK-PAID-SESSIONS.md §4 is a separate lane
  // (WP8). Consults use the check-in decision instead: RULEBOOK §2 has exactly two
  // outcomes, no evidence-quality branching, no policy.min_connected_ms/
  // auto_release_on_provider_end gate — those belong to deliveryError's world, not
  // this one.
  let checkIn: { rule: "creator_checked_in"; checkedInAt: number } | null = null;
  if (authority.kind === "consult_1to1") {
    const evidence = await consultCheckInDecision(env, job.commercial_session_id, authority.booking_id, authority.scheduled_at, authority.creator_id);
    if (!evidence.checkedIn) {
      const outcome = await refundCreatorNoShow(env, job, authority);
      if (outcome === "refunded") await insertNoShowStrike(env, authority.creator_id, authority.order_id, job.commercial_session_id);
      return;
    }
    checkIn = { rule: "creator_checked_in", checkedInAt: evidence.checkedInAt as number };
  } else {
    // [LIVE-GRACE-1] RULEBOOK-PAID-SESSIONS.md v2 §4 L5: a live event that
    // ended because the host never returned within the grace window is its
    // own outcome, decided once (in lib/live_grace.ts, at end time) and
    // stamped on the session row — never re-derived from delivery evidence
    // here, and never routed through deliveryError()'s two-party overlap
    // test (that test answers "did the host deliver enough to be paid at
    // all", not "how much of the slot was actually delivered to THIS
    // ticket").
    if (authority.end_outcome === "host_no_return") {
      return await settleLiveHostNoReturn(env, job, authority);
    }
    // [SETTLE-CHECKIN-3] R11: the host DID return within grace -- a normal end -- but if
    // this session recorded any outage window, RULEBOOK-PAID-SESSIONS.md v2 §4 L4 still
    // owes every ticket a pro-rata refund for the outage minutes. Route to the partial
    // settlement instead of the full-price `deliveryError` path below.
    if (await hasRecordedOutage(env, job.commercial_session_id)) {
      return await settleLiveOutageRefund(env, job, authority);
    }
    const delivery = await deliveryError(env, job.commercial_session_id, authority);
    if (delivery) {
      // [COMM-NOSHOW-1] A delivery failure used to mean review_pending, always — which is
      // why `creator_no_show` was unreachable from anywhere in the product and money sat
      // frozen with no screen behind it. Ask WHO failed to deliver, and if it was the
      // creator, honour the snapshotted creator-cancellation policy automatically.
      //
      // Only evidence failures are re-classified. A bad policy snapshot or a config
      // problem is still a human's problem and still goes to review.
      const evidenceFailure = delivery.startsWith("insufficient signed")
        || delivery.startsWith("live event never reached");
      if (!evidenceFailure) return await markReview(env, job.settlement_job_id, delivery);

      let policy: Record<string, unknown> = {};
      try { policy = JSON.parse(authority.cancellation_policy_json) as Record<string, unknown>; } catch { /* handled below */ }
      const minimumMs = Number.isFinite(Number(policy.min_connected_ms))
        ? Math.trunc(Number(policy.min_connected_ms)) : 60_000;
      const creatorMs = await creatorConnectedMs(env, job.commercial_session_id, authority.kind);

      if (creatorMs >= minimumMs) {
        // The creator delivered; the other side did not turn up. `no_show_policy` is
        // `session_charged`, so this settles normally rather than refunding — the whole
        // point of that policy is that a creator who showed up gets paid.
        commercialEvent(env, "settlement", null, { outcome: "buyer_no_show", kind: authority.kind });
      } else {
        const pct = Number(policy.creator_cancel_refund_pct);
        // 100 is the only percentage the refund machinery can express (receipts are
        // written refunded_amount = gross, remaining = 0). Anything else is a human's call.
        if (pct !== 100) return await markReview(env, job.settlement_job_id, `creator_no_show:${delivery}`);
        const gross = Math.trunc(Number(authority.gross_amount));
        const gstAmount = Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
        const refundable = gross + gstAmount;
        const claimed = await claimCommercialMoney(env, {
          orderId: authority.order_id, claimType: "refund", claimId: `no-show:${job.settlement_job_id}`,
        });
        if (!claimed.owned) return await markReview(env, job.settlement_job_id, "money claim held elsewhere");
        const money = await executeCommercialRefund(env, {
          orderId: authority.order_id,
          buyerId: authority.buyer_id,
          amount: refundable,
          reason: "creator_no_show",
        });
        if (!money.ok) return await markReview(env, job.settlement_job_id, `creator_no_show_refund_failed:${money.error}`);
        await finalizeCommercialRefund(env, {
          orderId: authority.order_id,
          sessionId: job.commercial_session_id,
          listingId: authority.listing_id,
          bookingId: authority.booking_id,
          buyerId: authority.buyer_id,
          creatorId: authority.creator_id,
          kind: authority.kind,
          grossAmount: gross,
          refundedAmount: refundable,
          gstAmount,
          currency: authority.currency,
          policySnapshotId: authority.policy_snapshot_id,
          reason: "creator_no_show",
          actor: "system",
        });
        commercialEvent(env, "settlement", null, { outcome: "refunded", reason: "creator_no_show", kind: authority.kind });
        return;
      }
    }
  }

  // [TAX-GST-1] Escrow holds base + tax in one hold (see commercial_checkout.ts), so
  // the sufficiency check must cover BOTH. Checking only gross would pass on an escrow
  // short by exactly the tax, and the tax leg below would then fail after the creator had
  // already been paid.
  const escrowRequired = Number(authority.gross_amount) + Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
  if (!job.funds_verified_at && escrowRequired > 0) {
    const available = await escrowBalance(env, authority.order_id);
    if (available < escrowRequired) {
      return await markReview(env, job.settlement_job_id, "escrow balance below immutable gross");
    }
    const verifiedAt = Date.now();
    await metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET funds_verified_at=?2,updated_at=?2
       WHERE settlement_job_id=?1 AND funds_verified_at IS NULL`,
    ).bind(job.settlement_job_id, verifiedAt).run();
    job.funds_verified_at = verifiedAt;
  }
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id,
    claimType: "settlement",
    claimId: job.settlement_job_id,
  });
  if (!claim.owned) {
    const owner = claim.existing
      ? `${claim.existing.claim_type}:${claim.existing.claim_id}`
      : "unknown";
    return await markReview(env, job.settlement_job_id, `commercial money claim owned by ${owner}`);
  }
  await releaseSnapshot(env, authority);
  await finishSettlement(env, job, authority, checkIn);
}

async function refundCreatorNoShow(
  env: Env,
  job: SettlementJob,
  authority: SettlementAuthority,
): Promise<"refunded" | "review_pending"> {
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id,
    claimType: "refund",
    claimId: `no-show:${job.settlement_job_id}`,
  });
  if (!claim.owned) {
    const owner = claim.existing
      ? `${claim.existing.claim_type}:${claim.existing.claim_id}`
      : "unknown";
    await markReview(env, job.settlement_job_id, `commercial money claim owned by ${owner}`);
    return "review_pending";
  }
  const gross = Math.trunc(Number(authority.gross_amount));
  const gstAmount = Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
  const refundable = gross + gstAmount;
  const money = await executeCommercialRefund(env, {
    orderId: authority.order_id,
    buyerId: authority.buyer_id,
    amount: refundable,
    reason: "creator_no_show",
  });
  if (!money.ok) {
    await markReview(env, job.settlement_job_id, `creator_no_show_refund_failed:${money.error}`);
    return "review_pending";
  }
  await finalizeCommercialRefund(env, {
    orderId: authority.order_id,
    sessionId: job.commercial_session_id,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    buyerId: authority.buyer_id,
    creatorId: authority.creator_id,
    kind: authority.kind,
    grossAmount: gross,
    refundedAmount: refundable,
    gstAmount,
    currency: authority.currency,
    policySnapshotId: authority.policy_snapshot_id,
    reason: "creator_no_show",
    actor: "system",
  });
  await completeCommercialMoneyClaim(env, {
    orderId: authority.order_id,
    claimType: "refund",
    claimId: `no-show:${job.settlement_job_id}`,
  });
  commercialEvent(env, "settlement", null, { outcome: "refunded", reason: "creator_no_show", kind: authority.kind });
  return "refunded";
}

async function finalizeOverdueNoShow(
  env: Env,
  authority: OverdueNoShowAuthority,
  claimId: string,
): Promise<"refunded" | "review_pending" | "skipped"> {
  // [SETTLE-CHECKIN-2] fix 2: this sweep only sees sessions whose state machine never
  // reached 'ended' by the check-in deadline -- but the creator may still have actually
  // checked in (session_attendance / commercial_participant_intervals evidence) while
  // the DO/state transition stalled. Refunding him here would apply the C2 outcome to a
  // C1 fact pattern. Ask the same question consultCheckInDecision asks for the normal
  // settlement path, and if he checked in, leave the session alone: endDueConsultSessions
  // ends it once ends_at+grace passes, and the normal settlement path pays him in full.
  if (authority.kind === "consult_1to1") {
    const evidence = await consultCheckInDecision(
      env, authority.commercial_session_id, authority.booking_id, authority.scheduled_at, authority.creator_id,
    );
    if (evidence.checkedIn) {
      commercialEvent(env, "settlement", null, { outcome: "skipped_checked_in", kind: authority.kind });
      return "skipped";
    }
  }
  const policy = safeJson(authority.cancellation_policy_json);
  if (!policy) return "review_pending";
  const pct = Number(policy.creator_cancel_refund_pct);
  if (pct !== 100) {
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
       WHERE commercial_session_id=?1 AND settlement_state NOT IN ('settled','refunded')`,
    ).bind(authority.commercial_session_id, Date.now()).run();
    commercialEvent(env, "settlement", null, { outcome: "review_pending", reason: "creator_no_show" });
    return "review_pending";
  }
  const claim = await claimCommercialMoney(env, {
    orderId: authority.order_id,
    claimType: "refund",
    claimId,
  });
  if (!claim.owned) {
    await metaDb(env).prepare(
      `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
       WHERE commercial_session_id=?1 AND settlement_state NOT IN ('settled','refunded')`,
    ).bind(authority.commercial_session_id, Date.now()).run();
    return "review_pending";
  }
  const gross = Math.trunc(Number(authority.gross_amount));
  const gstAmount = Math.max(0, Math.trunc(Number(authority.gst_amount ?? 0)));
  const refundable = gross + gstAmount;
  const money = await executeCommercialRefund(env, {
    orderId: authority.order_id,
    buyerId: authority.buyer_id,
    amount: refundable,
    reason: "creator_no_show",
  });
  if (!money.ok) return "review_pending";
  const receiptId = await finalizeCommercialRefund(env, {
    orderId: authority.order_id,
    sessionId: authority.commercial_session_id,
    listingId: authority.listing_id,
    bookingId: authority.booking_id,
    buyerId: authority.buyer_id,
    creatorId: authority.creator_id,
    kind: authority.kind,
    grossAmount: gross,
    refundedAmount: refundable,
    gstAmount,
    currency: authority.currency,
    policySnapshotId: authority.policy_snapshot_id,
    reason: "creator_no_show",
    actor: "system",
  });
  await completeCommercialMoneyClaim(env, { orderId: authority.order_id, claimType: "refund", claimId });
  await metaDb(env).batch([
    metaDb(env).prepare(
      `UPDATE commercial_sessions SET state='cancelled',settlement_state='refunded',state_version=state_version+1,updated_at=?2
       WHERE commercial_session_id=?1 AND state IN ('scheduled','backstage')`,
    ).bind(authority.commercial_session_id, Date.now()),
    metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='refunded',last_error=?2,updated_at=?3
       WHERE commercial_session_id=?1 AND state IN ('pending','processing','review_pending')`,
    ).bind(authority.commercial_session_id, "creator_no_show", Date.now()),
    metaDb(env).prepare(
      `UPDATE orders SET status='refunded',cancelled_by='creator',cancelled_at=?2,updated_at=?2
       WHERE id=?1 AND status IN ('held','free')`,
    ).bind(authority.order_id, Date.now()),
    metaDb(env).prepare(
      `UPDATE commercial_entitlements SET state='refunded',updated_at=?2
       WHERE order_id=?1 AND state IN ('reserved','held','active','consumed')`,
    ).bind(authority.order_id, Date.now()),
  ]);
  // [SETTLE-CHECKIN-1] Same C2 outcome as processJob's check-in-decision branch, just
  // reached via the "never even got to 'ended'" sweep instead of a settlement job —
  // strike the creator the same way either path gets here.
  if (authority.kind === "consult_1to1") await insertNoShowStrike(env, authority.creator_id, authority.order_id, authority.commercial_session_id);
  commercialEvent(env, "settlement", null, { outcome: "refunded", reason: "creator_no_show", kind: authority.kind });
  void receiptId;
  return "refunded";
}

export async function runCommercialSettlements(
  env: Env,
  limit = 10,
): Promise<{ scanned: number; settled: number; reviewPending: number }> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const stale = Date.now() - 60_000;
  const rows = await metaDb(env).prepare(
    `SELECT settlement_job_id,commercial_session_id,order_id,state,attempts,funds_verified_at
     FROM commercial_settlement_jobs
     WHERE state='pending' OR (state='processing' AND updated_at<?1)
     ORDER BY created_at LIMIT ?2`,
  ).bind(stale, safeLimit).all<SettlementJob>();
  let settled = 0;
  let reviewPending = 0;
  for (const job of rows.results ?? []) {
    const claimed = await metaDb(env).prepare(
      `UPDATE commercial_settlement_jobs SET state='processing',updated_at=?2
       WHERE settlement_job_id=?1 AND (state='pending' OR (state='processing' AND updated_at<?3))`,
    ).bind(job.settlement_job_id, Date.now(), stale).run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    commercialEvent(env, "settlement", null, { outcome: "processing" });
    try {
      await processJob(env, job);
      const state = await metaDb(env).prepare(
        "SELECT state FROM commercial_settlement_jobs WHERE settlement_job_id=?1",
      ).bind(job.settlement_job_id).first<{ state: string }>();
      if (state?.state === "settled") settled++;
      if (state?.state === "review_pending") reviewPending++;
    } catch (error) {
      commercialEvent(env, "settlement", null, { outcome: "failed" });
      await metaDb(env).prepare(
        `UPDATE commercial_settlement_jobs SET last_error=?2,attempts=attempts+1,updated_at=?3
         WHERE settlement_job_id=?1 AND state='processing'`,
      ).bind(job.settlement_job_id, String(error).slice(0, 500), Date.now()).run();
    }
  }
  return { scanned: (rows.results ?? []).length, settled, reviewPending };
}

export async function runCommercialHostNoShowSweep(
  env: Env,
  limit = 10,
): Promise<{ scanned: number; refunded: number; reviewPending: number }> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await loadOverdueNoShowAuthorities(env, safeLimit);
  let refunded = 0;
  let reviewPending = 0;
  for (const authority of rows) {
    const claimId = `no-show:${authority.commercial_session_id}:${authority.order_id}`;
    try {
      const outcome = await finalizeOverdueNoShow(env, authority, claimId);
      if (outcome === "refunded") refunded++;
      else if (outcome === "review_pending") reviewPending++;
      // "skipped" (fix 2: creator actually checked in) touches neither tally --
      // it is neither a refund nor something waiting on a human.
    } catch (error) {
      await metaDb(env).prepare(
        `UPDATE commercial_sessions SET settlement_state='review_pending',updated_at=?2
         WHERE commercial_session_id=?1 AND settlement_state NOT IN ('settled','refunded')`,
      ).bind(authority.commercial_session_id, Date.now()).run();
      reviewPending++;
    }
  }
  return { scanned: rows.length, refunded, reviewPending };
}
