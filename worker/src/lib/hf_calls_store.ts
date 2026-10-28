// [HF-CALLS-1] Shared plumbing for HF masked calls: row type, wallet helpers (whole rupees, 1 token = Rs 1),
// presence helpers, webhook URLs and the cron sweep. Contract: Specs/HF-CALLS-CONTRACT.md.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { getLaneAccess } from "./hf_lanes";
import { walletOp } from "../routes/wallet";
import { track, trackException } from "../hooks";
import { lineFlags } from "./hf_host_line_view"; // [HF-CALL-MODES-A]

export const HF_CALL_APP = BRAND.slug;
export const WALLET_APP = "hf_call";
export const ACTIVE_STATUSES = ["ringing_host", "ringing_caller", "connected", "ending", "finalizing"] as const;
export const PRESENCE_TTL_MS = 8 * 3600_000; // no heartbeat for 8 h -> offline

export interface HfCallRow {
  id: string; caller_uid: string; host_uid: string; rate_paise: number; status: string; lane: string | null;
  created_at: number; host_answered_at: number | null; connected_at: number | null; ended_at: number | null;
  billed_minutes: number; charged_paise: number; host_earning_paise: number; host_earned_tokens: number;
  billable_seconds: number | null; tokens_spent_micro: number | null;
  end_reason: string | null; host_leg_uuid: string | null; caller_leg_uuid: string | null; conference_name: string | null;
}

export const callReservationRef = (callId: string) => `hfcall:${callId}`;
export const callOpId = (callId: string, step: string) => `hfcall:${callId}:${step}`;

/** True when the telephony config needed to place a call is present. */
export function callsConfigured(env: Env): boolean {
  return !!(env.HF_CALL_DID && env.VOBIZ_AUTH_ID && env.VOBIZ_AUTH_TOKEN && env.VOBIZ_WEBHOOK_SECRET);
}

/** Base of every Vobiz webhook for these calls. The secret is a path segment (same scheme as routes/campaign_pstn.ts). */
export function webhookBase(env: Env): string {
  return `${BRAND.apiOrigin}/api/hf/vobiz/${encodeURIComponent(env.VOBIZ_WEBHOOK_SECRET || "")}`;
}

// ── wallet (paid balance only: test credits are a plain `credit`, so allow_free:false) ──────────────────────────────
export async function hfWalletBalance(env: Env, uid: string): Promise<number> {
  const r = await walletOp(env, uid, { op: "balance", uid });
  return r.status === 200 ? Math.max(0, Math.trunc(Number(r.body?.balance ?? 0))) : 0;
}

export async function hfReserve(env: Env, uid: string, rupees: number, callId: string, step: string): Promise<{ ok: boolean; status: number; available: number; reservedTotal: number }> {
  const r = await walletOp(env, uid, {
    op: "reserve", uid, amount: rupees, ref: callReservationRef(callId), allow_free: false, op_id: callOpId(callId, step), app_name: WALLET_APP,
  });
  return { ok: r.status === 200 && r.body?.ok === true, status: r.status, available: Math.max(0, Math.trunc(Number(r.body?.available ?? 0))), reservedTotal: Math.trunc(Number(r.body?.reservedTotal ?? 0)) };
}

export async function hfRelease(env: Env, uid: string, callId: string): Promise<boolean> {
  const r = await walletOp(env, uid, { op: "release_reservation", uid, ref: callReservationRef(callId), op_id: callOpId(callId, "release"), app_name: WALLET_APP });
  return r.status === 200 && r.body?.ok === true;
}

export async function hfConsume(env: Env, uid: string, rupees: number, callId: string, hostUid: string): Promise<{ ok: boolean; consumed: number }> {
  const r = await walletOp(env, uid, {
    op: "consume_reserved", uid, ref: callReservationRef(callId), amount: rupees, allow_free: false, op_id: callOpId(callId, "consume"),
    app_name: WALLET_APP, type: "hf_call", counterparty_uid: hostUid, category: "call", context: `${BRAND.name} call`,
  });
  return { ok: r.status === 200 && r.body?.ok === true, consumed: Math.trunc(Number(r.body?.consumed ?? 0)) };
}

/** Host share into the host's wallet with the standard earnings hold. */
export async function hfEarn(env: Env, hostUid: string, rupees: number, callId: string, callerUid: string, commission: number): Promise<boolean> {
  const r = await walletOp(env, hostUid, {
    op: "earn", uid: hostUid, amount: rupees, commission, app_name: WALLET_APP, counterparty_uid: callerUid, ref: `hfcall:${callId}`,
    op_id: callOpId(callId, "earn"), category: "call", context: `${BRAND.name} call`,
  });
  return r.status === 200 && r.body?.ok === true;
}

// ── presence ─────────────────────────────────────────────────────────────────
// [HF-CALL-MODES-A] Spec 2.1. hf_hosts.call_mode is what she CHOSE, presence_call_id is the line lock (a call id or 'q:<entryId>'), on_call_since is set only
// once both legs joined, and `presence` stays a DERIVED column for every existing reader + shipped app: busy if on_call_since, else online if call_mode='online',
// else offline. Every statement below that touches the mode or the line rewrites presence in the SAME statement. With hfCallModesEnabled OFF
// every function here runs today's statements unchanged.
const LIVE_CALL_STATUSES = "'ringing_host','ringing_caller','connected','ending','finalizing'";

/**
 * Take the host's line for a call. Flag OFF: online -> busy at call start (today). Flag ON: only the lock is taken here (she still shows Online while it rings);
 * a BOOKED claim works in any mode (fixes: a booked call could not start while she was Offline/Busy), an instant one needs call_mode='online' and nobody waiting.
 */
export async function claimHost(env: Env, hostUid: string, callId: string, opts: { booked?: boolean } = {}): Promise<boolean> {
  const f = await lineFlags(env);
  // [HF-INTRO-W2] call option A takes no instant call (HF-INTRO-20). Atomic with the claim; a booked claim never gets here. The column is W1's
  // migration: a DB without it has no option-A host, so a "no such column" error retries the exact old statement.
  if (f.option && !opts.booked) {
    const guard = " AND COALESCE(call_option,'B')<>'A'";
    try { return await claimHostCore(env, hostUid, callId, opts, f, guard); }
    catch (e) { if (!/no such column/i.test(String((e as Error)?.message ?? e))) throw e; }
  }
  return claimHostCore(env, hostUid, callId, opts, f, "");
}

async function claimHostCore(env: Env, hostUid: string, callId: string, opts: { booked?: boolean }, f: { modes: boolean; queue: boolean }, extra: string): Promise<boolean> {
  if (!f.modes) {
    if (opts.booked) { // [HF-CALL-MODES-INT] a BOOKED call rings in any presence (HF-REEL-16): take the line; an online host shows busy as today, an offline one stays offline
      const rb = await env.DB_META.prepare(
        "UPDATE hf_hosts SET presence=CASE WHEN presence='online' THEN 'busy' ELSE presence END, presence_at=?1, presence_call_id=?3 WHERE uid=?2 AND status='live' AND presence_call_id IS NULL AND presence<>'busy'",
      ).bind(Date.now(), hostUid, callId).run();
      return Number(rb.meta?.changes ?? 0) === 1;
    }
    const r = await env.DB_META.prepare("UPDATE hf_hosts SET presence='busy', presence_at=?1, presence_call_id=?3 WHERE uid=?2 AND presence='online' AND status='live'" + extra).bind(Date.now(), hostUid, callId).run();
    return Number(r.meta?.changes ?? 0) === 1;
  }
  const waiters = f.queue ? " AND NOT EXISTS (SELECT 1 FROM hf_call_queue q WHERE q.host_uid=hf_hosts.uid AND q.status='waiting')" : "";
  const gate = opts.booked ? "" : ` AND call_mode='online'${waiters}`;
  const r = await env.DB_META.prepare(`UPDATE hf_hosts SET presence_call_id=?3, presence_at=?1 WHERE uid=?2 AND status='live' AND presence_call_id IS NULL${gate}${extra}`).bind(Date.now(), hostUid, callId).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/** Release only the call that owns the lock; an old retry cannot clear a newer call. Flag ON also clears on_call_since and re-derives presence from call_mode. */
export async function releaseHost(env: Env, hostUid: string, callId: string): Promise<void> {
  const f = await lineFlags(env);
  if (!f.modes) {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence=CASE WHEN presence='busy' THEN 'online' ELSE presence END, presence_at=CASE WHEN presence='busy' THEN ?1 ELSE presence_at END, presence_call_id=NULL WHERE uid=?2 AND presence_call_id=?3").bind(Date.now(), hostUid, callId).run();
    return;
  }
  const was = await env.DB_META.prepare("SELECT on_call_since FROM hf_hosts WHERE uid=?1 AND presence_call_id=?2").bind(hostUid, callId).first<{ on_call_since: number | null }>().catch(() => null);
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET on_call_since=NULL, presence=CASE WHEN call_mode='online' THEN 'online' ELSE 'offline' END, presence_at=?1, presence_call_id=NULL WHERE uid=?2 AND presence_call_id=?3").bind(Date.now(), hostUid, callId).run();
  if (Number(r.meta?.changes ?? 0) === 1 && was?.on_call_since != null) void track(env, hostUid, "hf_host_on_call", HF_CALL_APP, { area: "hf_call", call_id: callId, on: false }).catch(() => undefined);
}

/**
 * Queue dispatch: swap the queue lock 'q:<entryId>' for the real call id, atomically. Returns true when the swap happened (the lock was still ours,
 * the host is live and still online). Only the queue (Lane B) calls it.
 */
export async function claimHostFromQueue(env: Env, hostUid: string, entryId: string, callId: string): Promise<boolean> {
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=?3, presence_at=?4 WHERE uid=?1 AND status='live' AND call_mode='online' AND presence_call_id=?2").bind(hostUid, `q:${entryId}`, callId, Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}
/** Queue break: lock an idle, online, unpaused line for 'q:<entryId>' (the 60 s break, then dispatch). True when we got it. */
export async function lockHostForQueue(env: Env, hostUid: string, entryId: string): Promise<boolean> {
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=?3, presence_at=?4 WHERE uid=?1 AND status='live' AND call_mode='online' AND queue_paused=0 AND presence_call_id IS NULL").bind(hostUid, `q:${entryId}`, `q:${entryId}`, Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}
/** Drop a 'q:<entryId>' lock (queue emptied / skipped / closed). Only the matching lock is cleared. */
export async function unlockQueueLock(env: Env, hostUid: string, entryId: string): Promise<boolean> {
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET presence_call_id=NULL, presence_at=?3 WHERE uid=?1 AND presence_call_id=?2").bind(hostUid, `q:${entryId}`, Date.now()).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/**
 * Called by HfCallDO.connect() once BOTH legs joined: sets on_call_since and the derived presence 'busy' in one statement, only for the lock owner.
 * No-op while hfCallModesEnabled is OFF (claimHost already marked her busy at call start then).
 */
export async function markOnCall(env: Env, hostUid: string, callId: string): Promise<void> {
  if (!(await lineFlags(env)).modes) return;
  const now = Date.now();
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET on_call_since=?1, presence='busy', presence_at=?1 WHERE uid=?2 AND presence_call_id=?3").bind(now, hostUid, callId).run();
  if (Number(r.meta?.changes ?? 0) === 1) void track(env, hostUid, "hf_host_on_call", HF_CALL_APP, { area: "hf_call", call_id: callId, on: true }).catch(() => undefined);
}

/** Calls use the same current Aadhaar/declaration/video authority as discovery. */
export async function hasLaneAccess(env: Env, uid: string, lane: "women" | "lgbtq"): Promise<boolean> {
  return (await getLaneAccess(env, uid))[lane];
}

export async function isBlockedEitherWay(env: Env, a: string, b: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1) LIMIT 1").bind(a, b).first();
    return !!r;
  } catch { return false; }
}

// ── cron (every 5 min, from scheduled()) ─────────────────────────────────────
/** Poke the DO of any call stuck in a ringing state; drop orphaned `busy`. */
export async function runHfCallsCron(env: Env): Promise<void> {
  const now = Date.now();
  try {
    // [HF-BOOK-APPROVE-QA-1] No more auto-offline after 8 h without a heartbeat: the owner's rule (HF-REEL-13, HF-BOOK-1) is that the
    // influencer's own switch decides, default Online. The app never sent a heartbeat, so this sweep silently took every influencer
    // offline 8 h after their last toggle (and undid the 2026-10-20 "everyone Online" change). PRESENCE_TTL_MS is kept for reference.
    // A host marked busy with no live call behind it (e.g. a lost DO) must not stay busy forever.
    if ((await lineFlags(env)).modes) {
      // [HF-CALL-MODES-A] orphan on_call_since / call locks: re-derive presence from call_mode (never force a Bookings-only host Online).
      await env.DB_META.prepare(
        `UPDATE hf_hosts SET on_call_since=NULL, presence_call_id=NULL, presence=CASE WHEN call_mode='online' THEN 'online' ELSE 'offline' END, presence_at=?1
           WHERE (on_call_since IS NOT NULL OR presence='busy' OR (presence_call_id IS NOT NULL AND presence_call_id NOT LIKE 'q:%')) AND presence_at < ?2
           AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.host_uid = hf_hosts.uid AND c.status IN (${LIVE_CALL_STATUSES}) AND c.created_at > ?3)`,
      ).bind(now, now - 10 * 60_000, now - 25 * 3600_000).run();
      try { // orphan 'q:<entry>' locks (lost alarm): only when no waiting/offered queue entry still owns it
        await env.DB_META.prepare(
          `UPDATE hf_hosts SET presence_call_id=NULL, presence_at=?1 WHERE presence_call_id LIKE 'q:%' AND on_call_since IS NULL AND presence_at < ?2
             AND NOT EXISTS (SELECT 1 FROM hf_call_queue q WHERE q.id = substr(hf_hosts.presence_call_id, 3) AND q.status IN ('waiting','offered'))`,
        ).bind(now, now - 10 * 60_000).run();
      } catch { /* hf_call_queue not applied yet */ }
    } else {
      await env.DB_META.prepare(
        `UPDATE hf_hosts SET presence='online', presence_at=?1, presence_call_id=NULL WHERE presence='busy' AND presence_at < ?2
           AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.host_uid = hf_hosts.uid AND c.status IN ('ringing_host','ringing_caller','connected','ending','finalizing') AND c.created_at > ?3)`,
      ).bind(now, now - 10 * 60_000, now - 25 * 3600_000).run(); // [HF-STD-PLAN-1] cover the explicit 24 h operational safety ceiling
    }
    const stuck = await env.DB_META.prepare(
      "SELECT id FROM hf_calls WHERE status IN ('ringing_host','ringing_caller','connected','ending','finalizing') AND created_at < ?1 AND created_at > ?2 LIMIT 20",
    ).bind(now - 3 * 60_000, now - 25 * 3600_000).all<{ id: string }>(); // [HF-STD-PLAN-1] watchdog covers calls up to the 24 h bound
    for (const r of stuck.results ?? []) {
      try { await env.HF_CALL.get(env.HF_CALL.idFromName(r.id)).fetch("https://hfcall/watchdog", { method: "POST", body: "{}" }); } catch { /* next tick */ }
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_calls.cron", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
  }
}
