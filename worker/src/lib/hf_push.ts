// [HF-APP-4] HF push notifications to the Android app.
//   sendHfPush(env, uid, {kind, title, body, path}, ctx?)   never throws; no-op unless flag hfPushEnabled is on
//   notifyLowBalance(env, uid, ctx?)                         hook for the billing code: call after a call ends when the balance is low
//   push*(...)                                               one tiny helper per push, called next to the existing WhatsApp sends
// Delivery goes through the existing push queue to consumers/src/fcm.ts (kind "hf_push"), which reads hf_push_tokens,
// sends the FCM message and prunes dead tokens. WhatsApp stays as it is; push is added on top.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";
import { readConfig } from "../routes/config";
import { buildHfPushJob, hfPushCopy, type HfPushKind } from "./hf_push_pure";

const APP = BRAND.slug;

export async function hfPushOn(env: Env): Promise<boolean> {
  try { return ((await readConfig(env)) as unknown as Record<string, unknown>).hfPushEnabled === true; } catch { return false; }
}

export interface HfPushInput { kind: HfPushKind | string; title: string; body: string; path: string }

/** Returns true when a job was queued. Skips quietly when the flag is off, the user has no registered device, or the input is unsafe. */
export async function sendHfPush(env: Env, uid: string, m: HfPushInput, ctx?: ExecutionContext): Promise<boolean> {
  const work = (async (): Promise<boolean> => {
    try {
      if (!(await hfPushOn(env))) return false;
      const job = buildHfPushJob(uid, m);
      if (!job) return false;
      const has = await env.DB_META.prepare("SELECT 1 AS x FROM hf_push_tokens WHERE user_id=?1 LIMIT 1").bind(uid).first().catch(() => null);
      if (!has) return false;
      if (!env.Q_PUSH) return false;
      await env.Q_PUSH.send(job);
      void track(env, uid, "hf_push_sent", APP, { kind: job.hfKind });
      return true;
    } catch (e) {
      await trackException(env, e, { route: "hf_push.sendHfPush", handled: true, app_name: APP, extra: { area: "hf_push", kind: m.kind } });
      return false;
    }
  })();
  if (ctx) { ctx.waitUntil(work); return false; }
  return work;
}

const firstName = (n: string | null | undefined) => (n || "").trim().split(/\s+/)[0] || "";

/** (1) Notify-me: the host the caller asked about is online. */
export const pushNotifyMe = (env: Env, ctx: ExecutionContext | undefined, callerUid: string, host: { display_name: string | null; slug: string }) =>
  sendHfPush(env, callerUid, hfPushCopy("notify_me", BRAND.name, { name: firstName(host.display_name), slug: host.slug }), ctx);

/** (2) Profile decision: approved, or needs changes (reject or pause). */
export const pushHostDecision = (env: Env, ctx: ExecutionContext | undefined, hostUid: string, decision: "approve" | "reject" | "pause") =>
  sendHfPush(env, hostUid, hfPushCopy(decision === "approve" ? "host_approved" : "host_changes", BRAND.name), ctx);

/** (3) Withdrawal approved or paid. */
export const pushWithdrawal = (env: Env, ctx: ExecutionContext | undefined, hostUid: string, stage: "approved" | "paid", rupees: number) =>
  sendHfPush(env, hostUid, hfPushCopy(stage === "paid" ? "withdrawal_paid" : "withdrawal_approved", BRAND.name, { rupees }), ctx);

/**
 * (4) Caller low balance after a call. TODO(billing agent): call this once from the call-settle code when the caller's balance
 * after the call is below the 2-minute start rule. It only sends; it never reads or changes any money.
 */
export const notifyLowBalance = (env: Env, uid: string, ctx?: ExecutionContext) =>
  sendHfPush(env, uid, hfPushCopy("low_balance", BRAND.name), ctx);

/** (5) After a call: ask for a review. */
export const pushReviewRequest = (env: Env, ctx: ExecutionContext | undefined, callerUid: string, hostName: string | null | undefined, token: string) =>
  sendHfPush(env, callerUid, hfPushCopy("review_request", BRAND.name, { name: firstName(hostName), token }), ctx);
