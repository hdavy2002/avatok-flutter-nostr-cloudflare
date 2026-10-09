// [HF-CALLS-1] Shared plumbing for HF masked calls: row type, wallet helpers (whole rupees, 1 token = Rs 1),
// presence helpers, webhook URLs and the cron sweep. Contract: Specs/HF-CALLS-CONTRACT.md.
import type { Env } from "../types";
import { BRAND } from "./brand";
import { walletOp } from "../routes/wallet";
import { trackException } from "../hooks";

export const HF_CALL_APP = BRAND.slug;
export const WALLET_APP = "hf_call";
export const ACTIVE_STATUSES = ["ringing_host", "ringing_caller", "connected"] as const;
export const PRESENCE_TTL_MS = 8 * 3600_000; // no heartbeat for 8 h -> offline

export interface HfCallRow {
  id: string; caller_uid: string; host_uid: string; rate_paise: number; status: string; lane: string | null;
  created_at: number; host_answered_at: number | null; connected_at: number | null; ended_at: number | null;
  billed_minutes: number; charged_paise: number; host_earning_paise: number; host_earned_tokens: number;
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
/** online -> busy, atomically. False when someone else got the host first or the host is not online. */
export async function claimHost(env: Env, hostUid: string): Promise<boolean> {
  const r = await env.DB_META.prepare("UPDATE hf_hosts SET presence='busy', presence_at=?1 WHERE uid=?2 AND presence='online' AND status='live'").bind(Date.now(), hostUid).run();
  return Number(r.meta?.changes ?? 0) === 1;
}
/** busy -> online (a host who went offline during the call stays offline). */
export async function releaseHost(env: Env, hostUid: string): Promise<void> {
  await env.DB_META.prepare("UPDATE hf_hosts SET presence='online', presence_at=?1 WHERE uid=?2 AND presence='busy'").bind(Date.now(), hostUid).run();
}

/** Tolerant lane lookup: hf_lane_access belongs to another worktree and may not exist yet -> no access. */
export async function hasLaneAccess(env: Env, uid: string, lane: "women" | "lgbtq"): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT 1 AS ok FROM hf_lane_access WHERE uid=?1 AND lane=?2 LIMIT 1").bind(uid, lane).first();
    return !!r;
  } catch { return false; }
}

export async function isBlockedEitherWay(env: Env, a: string, b: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1) LIMIT 1").bind(a, b).first();
    return !!r;
  } catch { return false; }
}

// ── cron (every 5 min, from scheduled()) ─────────────────────────────────────
/** Auto-offline after 8 h without a heartbeat; poke the DO of any call stuck in a ringing state; drop orphaned `busy`. */
export async function runHfCallsCron(env: Env): Promise<void> {
  const now = Date.now();
  try {
    await env.DB_META.prepare("UPDATE hf_hosts SET presence='offline', presence_at=?1 WHERE presence='online' AND (presence_at IS NULL OR presence_at < ?2)").bind(now, now - PRESENCE_TTL_MS).run();
    // A host marked busy with no live call behind it (e.g. a lost DO) must not stay busy forever.
    await env.DB_META.prepare(
      `UPDATE hf_hosts SET presence='online', presence_at=?1 WHERE presence='busy' AND presence_at < ?2
         AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.host_uid = hf_hosts.uid AND c.status IN ('ringing_host','ringing_caller','connected') AND c.created_at > ?3)`,
    ).bind(now, now - 10 * 60_000, now - 4 * 3600_000).run();
    const stuck = await env.DB_META.prepare(
      "SELECT id FROM hf_calls WHERE status IN ('ringing_host','ringing_caller','connected') AND created_at < ?1 AND created_at > ?2 LIMIT 20",
    ).bind(now - 3 * 60_000, now - 6 * 3600_000).all<{ id: string }>();
    for (const r of stuck.results ?? []) {
      try { await env.HF_CALL.get(env.HF_CALL.idFromName(r.id)).fetch("https://hfcall/watchdog", { method: "POST", body: "{}" }); } catch { /* next tick */ }
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_calls.cron", handled: true, app_name: HF_CALL_APP, extra: { area: "hf_calls" } });
  }
}
