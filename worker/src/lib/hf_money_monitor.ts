// [HF-WIRE-13] Call money monitor (HF-REEL-36 rule 9). Runs from the scheduled handler every tick.
//   1. Looks at recently ended calls and past bookings.
//   2. Recomputes what should have been charged / returned under the owner's rules (hf_money_rules.judgeCall).
//   3. Puts SAFE mistakes right: a refund goes to the caller's WALLET (correctCallCharge, one correction per call, idempotent) or a stuck
//      booking hold is released (releaseHeldBooking, gated on the booking still being 'held'). Never the card/UPI.
//   4. Writes everything it cannot or must not fix to hf_money_audit for an admin (admin GET /api/admin/hf/money-audit).
// Never double-credits: the correction and the release both key on the call / booking, and a call that already has a correction is skipped.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { trackException } from "../hooks";
import { chargePaise, validTariff, type Price, type Tariff } from "./hf_token_math";
import { judgeCall, readMoneyRules, type CallFacts } from "./hf_money_rules";
import { correctCallCharge, corrOpId } from "./hf_call_corrections";
import { releaseHeldBooking, type BookingCleanupRow } from "./hf_booking_store";

export const MONEY_MONITOR_ACTOR = "system:money-monitor";
const LOOKBACK_MS = 48 * 3600 * 1000;
const SETTLE_GRACE_MS = 2 * 60 * 1000;
const BOOKING_GRACE_MS = 15 * 60 * 1000;
const CALL_BATCH = 100;
const BOOKING_BATCH = 50;
export const RULE_BOOKING_HOLD_STUCK = "booking_hold_not_released";
export const RULE_BOOKING_NO_SHOW_RELEASED = "booking_no_show_hold";

export interface MonitorResult { scannedCalls: number; scannedBookings: number; fixed: number; flagged: number; skipped: number }

interface CallRow {
  id: string; caller_uid: string; host_uid: string; status: string; rate_paise: number;
  connected_at: number | null; ended_at: number | null; charged_paise: number | null; consumed_value_paise: number | null;
  host_earning_paise: number | null; billable_seconds: number | null; tokens_spent_micro: number | null; pricing_snapshot: string | null;
}

/** The frozen per-second price of a call, or null when the snapshot is not one we can recompute from. */
function priceOfRow(r: CallRow): Price | null {
  if (r.tokens_spent_micro == null || r.billable_seconds == null) return null; // legacy per-started-minute calls: not recomputed here
  if (r.pricing_snapshot) {
    try {
      const snap = JSON.parse(r.pricing_snapshot) as { tariff?: Tariff };
      return snap.tariff && validTariff(snap.tariff) ? snap.tariff : null;
    } catch { return null; }
  }
  return r.rate_paise > 0 ? r.rate_paise : null;
}

export function factsOf(r: CallRow): CallFacts {
  const price = priceOfRow(r);
  const joined = r.connected_at != null && r.ended_at != null;
  const settled = r.ended_at != null && (r.tokens_spent_micro != null || r.consumed_value_paise != null || r.charged_paise != null);
  return {
    status: r.status, connectedAt: r.connected_at, endedAt: r.ended_at,
    chargedPaise: Number(r.consumed_value_paise ?? r.charged_paise ?? 0),
    normalChargePaise: price != null && r.billable_seconds != null ? chargePaise(price, Math.max(0, Math.trunc(r.billable_seconds))) : null,
    hostEarningPaise: Number(r.host_earning_paise ?? 0),
    joinedSeconds: joined ? Math.max(0, Math.floor((Number(r.ended_at) - Number(r.connected_at)) / 1000)) : 0,
    settled,
  };
}

async function upsertAudit(env: Env, a: {
  kind: string; subjectId: string; rule: string; status: "open" | "fixed"; uid: string | null; hostUid: string | null;
  expected: number | null; actual: number | null; detail: Record<string, unknown>; fixOpId?: string | null; now: number;
}): Promise<void> {
  await env.DB_META.prepare(
    `INSERT INTO hf_money_audit (id,kind,subject_type,subject_id,rule,status,uid,host_uid,expected_paise,actual_paise,detail,fix_op_id,created_at,updated_at)
     VALUES (?1,?2,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
     ON CONFLICT(subject_type,subject_id,rule) DO UPDATE SET
       status=CASE WHEN hf_money_audit.status='resolved' THEN 'resolved' ELSE excluded.status END,
       expected_paise=excluded.expected_paise, actual_paise=excluded.actual_paise, detail=excluded.detail,
       fix_op_id=COALESCE(excluded.fix_op_id, hf_money_audit.fix_op_id), updated_at=excluded.updated_at`,
  ).bind(crypto.randomUUID(), a.kind, a.subjectId, a.rule, a.status, a.uid, a.hostUid, a.expected, a.actual, JSON.stringify(a.detail), a.fixOpId ?? null, a.now).run();
}

async function scanCalls(env: Env, now: number, autoFix: boolean, dropChargePaise: number, out: MonitorResult): Promise<void> {
  const rows = (await env.DB_META.prepare(
    `SELECT c.id,c.caller_uid,c.host_uid,c.status,c.rate_paise,c.connected_at,c.ended_at,c.charged_paise,c.consumed_value_paise,
            c.host_earning_paise,c.billable_seconds,c.tokens_spent_micro,c.pricing_snapshot
       FROM hf_calls c
      WHERE c.ended_at IS NOT NULL AND c.ended_at>=?1 AND c.ended_at<=?2
        AND NOT EXISTS (SELECT 1 FROM hf_token_ledger l WHERE l.op_id='hfcorr:'||c.id)
        AND NOT EXISTS (SELECT 1 FROM hf_money_audit a WHERE a.subject_type='call' AND a.subject_id=c.id AND a.status IN ('fixed','resolved'))
      ORDER BY c.ended_at DESC LIMIT ?3`,
  ).bind(now - LOOKBACK_MS, now - SETTLE_GRACE_MS, CALL_BATCH).all<CallRow>()).results ?? [];
  for (const r of rows) {
    out.scannedCalls++;
    const v = judgeCall(factsOf(r), { dropChargePaise });
    if (v.kind === "ok") { out.skipped++; continue; }
    const actual = Number(r.consumed_value_paise ?? r.charged_paise ?? 0);
    const base = { kind: "call", subjectId: r.id, rule: v.rule, uid: r.caller_uid, hostUid: r.host_uid, expected: v.expectedPaise, actual, now };
    if (v.kind === "flag") {
      await upsertAudit(env, { ...base, status: "open", detail: { reason: v.reason, status: r.status } });
      out.flagged++;
      continue;
    }
    // A refund the monitor may make itself: wallet only, once per call. Only the token path can be corrected (it has the lots to credit).
    if (!autoFix || r.tokens_spent_micro == null) {
      await upsertAudit(env, { ...base, status: "open", detail: { reason: v.reason, refundPaise: v.refundPaise, auto: false } });
      out.flagged++;
      continue;
    }
    const res = await correctCallCharge(env, { callId: r.id, amountPaise: v.refundPaise, adminUid: MONEY_MONITOR_ACTOR, note: v.rule });
    if (res.ok) {
      await upsertAudit(env, { ...base, status: "fixed", fixOpId: corrOpId(r.id), detail: { reason: v.reason, refundedPaise: res.correctedPaise, to: "wallet" } });
      out.fixed++;
    } else {
      await upsertAudit(env, { ...base, status: "open", detail: { reason: v.reason, refundPaise: v.refundPaise, fixError: res.error } });
      out.flagged++;
    }
  }
}

async function scanBookings(env: Env, now: number, autoFix: boolean, out: MonitorResult): Promise<void> {
  // A booked slot that passed with no call at all: the whole hold goes back to the wallet (rule 5). The bookings cron does this first;
  // this catches what it left behind.
  const stale = (await env.DB_META.prepare(
    `SELECT b.id,b.call_id,b.customer_uid,b.host_uid,b.status,b.settlement_status,b.reserved_paise FROM hf_bookings b
      WHERE b.status='confirmed' AND b.settlement_status='held' AND b.ends_at<=?1 AND b.ends_at>=?2
        AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.booking_id=b.id)
      ORDER BY b.ends_at LIMIT ?3`,
  ).bind(now - BOOKING_GRACE_MS, now - LOOKBACK_MS, BOOKING_BATCH).all<BookingCleanupRow & { reserved_paise: number }>()).results ?? [];
  for (const b of stale) {
    out.scannedBookings++;
    const base = { kind: "booking", subjectId: b.id, rule: RULE_BOOKING_NO_SHOW_RELEASED, uid: b.customer_uid, hostUid: b.host_uid, expected: 0, actual: Number(b.reserved_paise), now };
    if (autoFix && await releaseHeldBooking(env, b, now, "failed", "no_show").catch(() => false)) {
      await upsertAudit(env, { ...base, status: "fixed", fixOpId: "hfrel:" + b.call_id, detail: { reason: "Booked slot passed with no call: hold returned to the wallet" } });
      out.fixed++;
    } else {
      await upsertAudit(env, { ...base, status: "open", detail: { reason: "Booked slot passed with no call and the hold could not be released" } });
      out.flagged++;
    }
  }
  // A booking that finished (or failed) but still shows its money as held: an admin has to look, nothing is changed automatically.
  const hung = (await env.DB_META.prepare(
    `SELECT b.id,b.customer_uid,b.host_uid,b.status,b.reserved_paise FROM hf_bookings b
      WHERE b.status IN ('completed','failed','cancelled') AND b.settlement_status='held' AND b.updated_at<=?1 AND b.updated_at>=?2
      ORDER BY b.updated_at LIMIT ?3`,
  ).bind(now - 30 * 60 * 1000, now - LOOKBACK_MS, BOOKING_BATCH).all<{ id: string; customer_uid: string; host_uid: string; status: string; reserved_paise: number }>()).results ?? [];
  for (const b of hung) {
    out.scannedBookings++;
    await upsertAudit(env, { kind: "booking", subjectId: b.id, rule: RULE_BOOKING_HOLD_STUCK, status: "open", uid: b.customer_uid, hostUid: b.host_uid, expected: 0, actual: Number(b.reserved_paise), detail: { reason: "Booking is " + b.status + " but its money is still held", status: b.status }, now });
    out.flagged++;
  }
}

/** One monitor pass. Safe to run any number of times: a second run finds nothing new to fix. */
export async function runHfMoneyMonitor(env: Env, now = Date.now()): Promise<MonitorResult> {
  const out: MonitorResult = { scannedCalls: 0, scannedBookings: 0, fixed: 0, flagged: 0, skipped: 0 };
  const cfg = (await readConfig(env)) as unknown as Record<string, unknown>;
  if (cfg.hfCallsEnabled !== true || cfg.hfMoneyMonitorEnabled === false) return out;
  const autoFix = cfg.hfMoneyMonitorAutoFix !== false;
  const rules = await readMoneyRules(env);
  try { await scanCalls(env, now, autoFix, rules.dropChargePaise, out); }
  catch (e) { await trackException(env, e, { route: "scheduled", handled: true, extra: { area: "hf_money_monitor", step: "calls" } }); }
  if (cfg.hfBookingsEnabled === true) {
    try { await scanBookings(env, now, autoFix, out); }
    catch (e) { await trackException(env, e, { route: "scheduled", handled: true, extra: { area: "hf_money_monitor", step: "bookings" } }); }
  }
  return out;
}
