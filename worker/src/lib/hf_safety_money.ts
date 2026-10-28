// [HF-CALL-SAFETY-BE] Money side of a pause or a ban. Uses ONLY the existing helpers (no raw balance maths):
//   bookings   -> releaseHfBookingsForUser (full refund to the fan's wallet, same helper account closure uses)
//   refunds    -> correctCallCharge (credits the fan's wallet once per call, reverses the influencer's earning)
//   payout     -> createExitPayout (same payout as a closed account: reserved, an employee approves and pays the UPI)
import type { Env } from "../types";
import { releaseHfBookingsForUser } from "./hf_booking_store";
import { correctCallCharge } from "./hf_call_corrections";
import { createExitPayout } from "./hf_exit";
import { hostSummary } from "./hf_host_ledger";

export interface BanCall { callId: string; fanUid: string; chargePaise: number; at: number }
export interface BanAllocation { callId: string; fanUid: string; paise: number }

/** Pure. Refund the flagged calls newest first from the held money; the last one may be partial; nothing beyond what is held. */
export function allocateBanRefunds(calls: BanCall[], heldPaise: number): { allocs: BanAllocation[]; byFan: Array<{ fanUid: string; paise: number }>; total: number } {
  let left = Math.max(0, Math.trunc(heldPaise));
  const allocs: BanAllocation[] = [];
  for (const c of [...calls].sort((a, b) => b.at - a.at)) {
    if (left <= 0) break;
    const charge = Math.max(0, Math.trunc(c.chargePaise));
    const take = Math.min(charge, left);
    if (take <= 0) continue;
    allocs.push({ callId: c.callId, fanUid: c.fanUid, paise: take });
    left -= take;
  }
  const map = new Map<string, number>();
  for (const a of allocs) map.set(a.fanUid, (map.get(a.fanUid) ?? 0) + a.paise);
  const byFan = [...map.entries()].map(([fanUid, paise]) => ({ fanUid, paise }));
  return { allocs, byFan, total: allocs.reduce((t, a) => t + a.paise, 0) };
}

/** Held money of an influencer = everything earned and not yet paid out (waiting + withdrawable), in paise. */
export async function heldEarningsPaise(env: Env, hostUid: string): Promise<number> {
  try {
    const s = await hostSummary(env, hostUid);
    return Math.max(0, s.availablePaise + s.pendingPaise);
  } catch { return 0; }
}

/** The influencer's flagged calls that still carry a strike (not removed): the calls whose fans get refunded on a ban. */
export async function flaggedCallsOf(env: Env, hostUid: string): Promise<BanCall[]> {
  const rows = (await env.DB_META.prepare(
    `SELECT c.id AS call_id, c.caller_uid AS fan_uid, COALESCE(c.consumed_value_paise,0) AS charge, COALESCE(c.connected_at, c.created_at) AS at
       FROM hf_strikes s JOIN hf_calls c ON c.id=s.call_id
      WHERE s.uid=?1 AND s.role='influencer' AND s.removed_at IS NULL AND c.host_uid=?1 ORDER BY at DESC LIMIT 200`,
  ).bind(hostUid).all<{ call_id: string; fan_uid: string; charge: number; at: number }>().catch(() => ({ results: [] }))).results ?? [];
  return rows.map((r) => ({ callId: r.call_id, fanUid: r.fan_uid, chargePaise: Number(r.charge), at: Number(r.at) }));
}

export async function banMoneyPreview(env: Env, hostUid: string): Promise<{ heldPaise: number; refunds: Array<{ fanUid: string; paise: number }>; refundTotalPaise: number; payoutPaise: number; allocs: BanAllocation[] }> {
  const [held, calls] = await Promise.all([heldEarningsPaise(env, hostUid), flaggedCallsOf(env, hostUid)]);
  const a = allocateBanRefunds(calls, held);
  return { heldPaise: held, refunds: a.byFan, refundTotalPaise: a.total, payoutPaise: Math.max(0, held - a.total), allocs: a.allocs };
}

/**
 * Refund the fans of the flagged calls (the influencer's earning for each is taken back even after the 7-day hold: this is the held money),
 * then queue a payout of what is left. Safe to run again: a call is corrected once, a payout is created once.
 */
export async function executeBanMoney(env: Env, hostUid: string, adminUid: string, refund = true): Promise<{ refunded: Array<{ fanUid: string; paise: number }>; refundTotalPaise: number; failedCalls: string[]; payout: "created" | "exists" | "none" | "failed" }> {
  const pre = await banMoneyPreview(env, hostUid);
  const failed: string[] = [];
  const done = new Map<string, number>();
  for (const a of refund ? pre.allocs : []) {
    const r = await correctCallCharge(env, { callId: a.callId, amountPaise: a.paise, adminUid, note: "call_safety_ban", reverseHost: true }).catch(() => null);
    if (r && r.ok) done.set(a.fanUid, (done.get(a.fanUid) ?? 0) + r.correctedPaise);
    else failed.push(a.callId);
  }
  let payout: "created" | "exists" | "none" | "failed" = "none";
  try {
    const open = await env.DB_META.prepare("SELECT 1 AS x FROM hf_payout_requests WHERE host_uid=?1 AND exit=1 AND status IN ('requested','approved') LIMIT 1").bind(hostUid).first();
    if (open) payout = "exists";
    else {
      const p = await createExitPayout(env, hostUid);
      payout = p.ok ? "created" : p.error === "nothing_withdrawable" ? "none" : "failed";
    }
  } catch { payout = "failed"; }
  const refunded = [...done.entries()].map(([fanUid, paise]) => ({ fanUid, paise }));
  return { refunded, refundTotalPaise: refunded.reduce((t, r) => t + r.paise, 0), failedCalls: failed, payout };
}

/** Cancel every booking of a person (as fan or as influencer) with a full refund; returns the fans who were affected (for the notice). */
export async function cancelBookingsFor(env: Env, uid: string): Promise<{ cancelled: number; fanUids: string[]; blocked: number }> {
  const fans = (await env.DB_META.prepare(
    "SELECT DISTINCT customer_uid FROM hf_bookings WHERE host_uid=?1 AND status IN ('confirmed','pending_approval') AND settlement_status='held'",
  ).bind(uid).all<{ customer_uid: string }>().catch(() => ({ results: [] }))).results ?? [];
  let cancelled = 0, blocked = 0;
  for (let i = 0; i < 20; i++) {
    const r = await releaseHfBookingsForUser(env, uid, "suspension").catch(() => null);
    if (!r) { blocked++; break; }
    cancelled += r.processed; blocked += r.blocked;
    if (!r.more) break;
  }
  return { cancelled, fanUids: fans.map((f) => f.customer_uid), blocked };
}
