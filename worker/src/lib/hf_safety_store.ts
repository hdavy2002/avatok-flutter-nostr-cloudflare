// [HF-CALL-SAFETY-BE] Account standing, enforcement gates, strikes, pause / ban / restore, appeals and the notice queue.
// Enforcement (hfModStatus) reads one row of hf_mod_state and FAILS OPEN when the table is missing (migration not applied yet).
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { trackUser, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { readConfig } from "../routes/config";
import { emailFor } from "./identity";
import { forceHostOffline } from "./hf_exit";
import {
  safetyCfg, strikeExpiresAt, activeStrikeCount, shouldPause, isWarningStrike, nextSendTime, REASON_TEXT, PAUSE_REVIEW_HOURS, HOUR_MS,
  type SafetyCfg, type StrikeReason, type SpeakerRole,
} from "./hf_safety_rules";
import { cancelBookingsFor, executeBanMoney } from "./hf_safety_money";

export const SAFETY_APP = BRAND.slug;
export const APPEAL_BY_REPLY = false; // flip when an inbound WhatsApp webhook exists (none today); until then messages point to the Appeal button

export async function loadSafetyCfg(env: Env): Promise<SafetyCfg> {
  try { return safetyCfg((await readConfig(env)) as unknown as Record<string, unknown>); } catch { return safetyCfg(null); }
}

/** PostHog event with the person's email (CLAUDE.md two-sided telemetry). Never throws. */
export async function stTrack(env: Env, uid: string, event: string, props: Record<string, unknown> = {}): Promise<void> {
  try {
    const email = uid && uid !== "system" ? await emailFor(env, uid).catch(() => null) : null;
    await trackUser(env, uid || "system", email, event, SAFETY_APP, { area: "hf_call_safety", ...props });
  } catch { /* telemetry is best effort */ }
}
export async function stFail(env: Env, e: unknown, step: string, extra: Record<string, unknown> = {}): Promise<void> {
  try { await trackException(env, e, { route: `hf_call_safety:${step}`, handled: true, app_name: SAFETY_APP, extra: { area: "hf_call_safety", step, ...extra } }); } catch { /* ignore */ }
}

// ── standing + gates ─────────────────────────────────────────────────────────────────────────────────────────────
export type ModStatus = "active" | "paused" | "banned";
export interface ModView { status: ModStatus; reason: string | null; reviewDueAt: number | null }

export async function hfModStatus(env: Env, uid: string): Promise<ModView> {
  try {
    const r = await env.DB_META.prepare("SELECT status, reason, review_due_at FROM hf_mod_state WHERE uid=?1").bind(uid).first<{ status: string; reason: string | null; review_due_at: number | null }>();
    if (r && (r.status === "paused" || r.status === "banned")) return { status: r.status, reason: r.reason, reviewDueAt: r.review_due_at == null ? null : Number(r.review_due_at) };
  } catch { /* table missing: nobody is paused */ }
  return { status: "active", reason: null, reviewDueAt: null };
}

export const PAUSED_MESSAGE = "Your account is paused. You can still log in and withdraw your money. Open Safety to see why.";
export const accountPaused = (): Response => json({ error: "account_paused", message: PAUSED_MESSAGE }, 403);
export const callRulesRequired = (version: number): Response => json({ error: "call_rules_required", message: "Please accept the call rules to go online.", rulesVersion: version }, 403);

/** 403 account_paused when the person is paused or banned; null when fine. `where` is only for telemetry. */
export async function modBlock(env: Env, uid: string, where: "online" | "call" | "queue" | "booking" | "payout"): Promise<Response | null> {
  const m = await hfModStatus(env, uid);
  if (m.status === "active") return null;
  void stTrack(env, uid, "hf_safety_blocked", { where, status: m.status }).catch(() => undefined);
  return accountPaused();
}

/** An influencer must have accepted the current rules to go Online (only while recording is on). */
export async function callRulesBlock(env: Env, uid: string): Promise<Response | null> {
  const cfg = await loadSafetyCfg(env);
  if (!cfg.recordingEnabled) return null;
  try {
    const r = await env.DB_META.prepare("SELECT version FROM hf_call_rules_accept WHERE uid=?1").bind(uid).first<{ version: number }>();
    if (r && Number(r.version) >= cfg.rulesVersion) return null;
  } catch { return null; } // table missing: do not lock influencers out
  void stTrack(env, uid, "hf_safety_blocked", { where: "online", status: "rules_not_accepted" }).catch(() => undefined);
  return callRulesRequired(cfg.rulesVersion);
}

export async function isBannedNumber(env: Env, phoneHash: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_banned_numbers WHERE phone_hash=?1").bind(phoneHash).first()); } catch { return false; }
}

// ── notices (queued; the cron sends them, holding quiet hours) ───────────────────────────────────────────────────
export async function queueNotice(env: Env, a: { uid: string; event: string; key: string; title: string; body: string; path?: string; urgent?: boolean }): Promise<boolean> {
  try {
    const now = Date.now();
    const r = await env.DB_META.prepare(
      "INSERT OR IGNORE INTO hf_safety_notices (id, notice_key, uid, event, title, body, path, send_after, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
    ).bind(crypto.randomUUID(), a.key, a.uid, a.event, a.title.slice(0, 120), a.body.slice(0, 900), a.path ?? "/dashboard/safety", a.urgent ? now : nextSendTime(now), now).run();
    return Number(r.meta?.changes ?? 0) > 0;
  } catch (e) { await stFail(env, e, "queue_notice", { event: a.event }); return false; }
}

const appealHow = (): string => (APPEAL_BY_REPLY ? "Reply APPEAL here, or tap Appeal in the app." : "Tap Appeal in the app or on the website.");
export const noticeText = {
  strike(reason: StrikeReason, active: number, limit: number, days: number): { title: string; body: string } {
    return { title: "A strike was added to your account", body: `${REASON_TEXT[reason]} on a recent call. You have ${active} of ${limit} strikes; each lasts ${days} days. Think this is a mistake? ${appealHow()}` };
  },
  warning(limit: number): { title: string; body: string } {
    return { title: "One more strike pauses your account", body: `You are one strike away from a pause (${limit} strikes pause an account). Please keep calls respectful, and keep payments and contact details inside ${BRAND.name}.` };
  },
  paused(due: number | null, isHost: boolean): { title: string; body: string } {
    const when = due ? ` A team member will review it by ${new Date(due + 5.5 * HOUR_MS).toISOString().slice(0, 10)}.` : "";
    return { title: "Your account is paused", body: `Calls and new bookings are off${isHost ? ", your profile is hidden and your earnings are held until the review ends" : ""}. You can still log in and withdraw your wallet money.${when}` };
  },
  appealReceived: { title: "We got your appeal", body: "A team member will look at it and tell you the result." },
  appealAccepted: { title: "Your appeal was accepted", body: "The strike has been removed from your account." },
  appealRejected: { title: "Your appeal was not accepted", body: "The strike stays on your account until it expires." },
  restored: { title: "Your account is active again", body: "Calls and bookings are back on." },
  banned: { title: "Your account was closed", body: `Your ${BRAND.name} account has been closed for breaking the call rules. Any earnings that remain after refunds are paid to your UPI.` },
  fanRefunded(paise: number): { title: "Money back in your wallet"; body: string } {
    return { title: "Money back in your wallet", body: `A call you took part in was reviewed and Rs ${(paise / 100).toFixed(2).replace(/\.00$/, "")} has been returned to your wallet.` };
  },
  bookingCancelled: { title: "A booking was cancelled", body: "A booking you made was cancelled and the money is back in your wallet in full." },
};

// ── strikes ─────────────────────────────────────────────────────────────────────────────────────────────────────
export async function activeStrikes(env: Env, uid: string, now = Date.now()): Promise<number> {
  try {
    const r = await env.DB_META.prepare("SELECT COUNT(*) AS n FROM hf_strikes WHERE uid=?1 AND removed_at IS NULL AND expires_at>?2").bind(uid, now).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

export interface GiveStrike { uid: string; role: SpeakerRole; callId: string; reviewId: string | null; reason: StrikeReason; quote: string | null; auto: boolean; byUid: string | null }
export async function giveStrike(env: Env, a: GiveStrike, cfg?: SafetyCfg): Promise<{ created: boolean; strikeId: string; active: number; paused: boolean }> {
  const c = cfg ?? (await loadSafetyCfg(env));
  const now = Date.now();
  const id = crypto.randomUUID();
  const ins = await env.DB_META.prepare(
    "INSERT OR IGNORE INTO hf_strikes (id, uid, role, call_id, review_id, reason, quote, auto, by_uid, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
  ).bind(id, a.uid, a.role, a.callId, a.reviewId, a.reason, a.quote ? a.quote.slice(0, 400) : null, a.auto ? 1 : 0, a.byUid, now, strikeExpiresAt(now, c.expiryDays)).run();
  const created = Number(ins.meta?.changes ?? 0) > 0;
  const strikeId = created ? id : ((await env.DB_META.prepare("SELECT id FROM hf_strikes WHERE call_id=?1 AND uid=?2").bind(a.callId, a.uid).first<{ id: string }>())?.id ?? id);
  const active = await activeStrikes(env, a.uid, now);
  if (!created) return { created: false, strikeId, active, paused: false };
  const n = noticeText.strike(a.reason, active, c.strikesToPause, c.expiryDays);
  await queueNotice(env, { uid: a.uid, event: "strike", key: `strike:${strikeId}`, ...n });
  if (isWarningStrike(active, c.strikesToPause)) {
    const w = noticeText.warning(c.strikesToPause);
    await queueNotice(env, { uid: a.uid, event: "strike_warning", key: `warn:${strikeId}`, ...w });
  }
  await stTrack(env, a.uid, "hf_strike_given", { strike_id: strikeId, reason: a.reason, auto: a.auto, role: a.role, active_strikes: active, call_id: a.callId, review_id: a.reviewId, by_uid: a.byUid });
  let paused = false;
  if (shouldPause(active, c.strikesToPause)) { paused = (await pauseAccount(env, a.uid, "strikes", a.byUid, c)).changed; }
  return { created: true, strikeId, active, paused };
}

// ── pause / ban / restore ───────────────────────────────────────────────────────────────────────────────────────
async function isHostRow(env: Env, uid: string): Promise<boolean> {
  try { return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_hosts WHERE uid=?1 AND status IN ('live','paused')").bind(uid).first()); } catch { return false; }
}
/** Hide the profile (reels, search and listings only show approved / live), take the line offline and close the queue. */
async function hideHost(env: Env, uid: string): Promise<string | null> {
  const before = await env.DB_META.prepare("SELECT status FROM hf_hosts WHERE uid=?1").bind(uid).first<{ status: string }>().catch(() => null);
  if (!before) return null;
  await forceHostOffline(env, uid).catch(() => undefined);
  if (before.status === "live") { // [HF-INFLUENCER-GATE-1] 'approved' is retired
    await env.DB_META.prepare("UPDATE hf_hosts SET status='paused', presence='offline', presence_at=?2, updated_at=?2 WHERE uid=?1 AND status='live'").bind(uid, Date.now()).run();
    return before.status;
  }
  return null;
}

export async function pauseAccount(env: Env, uid: string, why: "strikes" | "danger" | "admin", byUid: string | null, cfg?: SafetyCfg): Promise<{ changed: boolean }> {
  const cur = await env.DB_META.prepare("SELECT status, prior_host_status FROM hf_mod_state WHERE uid=?1").bind(uid).first<{ status: string; prior_host_status: string | null }>().catch(() => null);
  if (cur && (cur.status === "paused" || cur.status === "banned")) return { changed: false };
  const now = Date.now();
  const due = now + PAUSE_REVIEW_HOURS * HOUR_MS;
  const host = await isHostRow(env, uid);
  const prior = host ? await hideHost(env, uid) : null;
  await env.DB_META.prepare(
    `INSERT INTO hf_mod_state (uid, status, reason, review_due_at, prior_host_status, updated_at, by_uid) VALUES (?1,'paused',?2,?3,?4,?5,?6)
     ON CONFLICT(uid) DO UPDATE SET status='paused', reason=excluded.reason, review_due_at=excluded.review_due_at, prior_host_status=COALESCE(excluded.prior_host_status, hf_mod_state.prior_host_status), updated_at=excluded.updated_at, by_uid=excluded.by_uid`,
  ).bind(uid, why, due, prior, now, byUid).run();
  const bookings = await cancelBookingsFor(env, uid).catch(() => ({ cancelled: 0, fanUids: [] as string[], blocked: 1 }));
  const n = noticeText.paused(due, host);
  await queueNotice(env, { uid, event: "paused", key: `paused:${uid}:${now}`, ...n });
  for (const fan of bookings.fanUids) await queueNotice(env, { uid: fan, event: "booking_cancelled", key: `bkc:${uid}:${fan}:${now}`, ...noticeText.bookingCancelled, path: "/bookings" });
  await stTrack(env, uid, "hf_account_paused", { reason: why, by_uid: byUid, bookings_cancelled: bookings.cancelled, bookings_blocked: bookings.blocked, is_host: host, active_strikes: await activeStrikes(env, uid) });
  void cfg;
  return { changed: true };
}

export async function banAccount(env: Env, uid: string, reason: string, byUid: string, refundFans: boolean): Promise<{ ok: true; refunded: Array<{ fanUid: string; paise: number }>; refundTotalPaise: number; payout: string; failedCalls: string[] }> {
  const now = Date.now();
  const host = await isHostRow(env, uid);
  const prior = host ? await hideHost(env, uid) : null;
  await env.DB_META.prepare(
    `INSERT INTO hf_mod_state (uid, status, reason, review_due_at, prior_host_status, payout_pending, updated_at, by_uid) VALUES (?1,'banned',?2,NULL,?3,?4,?5,?6)
     ON CONFLICT(uid) DO UPDATE SET status='banned', reason=excluded.reason, review_due_at=NULL, prior_host_status=COALESCE(excluded.prior_host_status, hf_mod_state.prior_host_status), payout_pending=excluded.payout_pending, updated_at=excluded.updated_at, by_uid=excluded.by_uid`,
  ).bind(uid, ("ban:" + reason).slice(0, 200), prior, host ? 1 : 0, now, byUid).run();
  // The WhatsApp number can never sign up again.
  try {
    const cv = await env.DB_META.prepare("SELECT phone_hash FROM contact_verification WHERE uid=?1").bind(uid).first<{ phone_hash: string | null }>();
    if (cv?.phone_hash) await env.DB_META.prepare("INSERT OR REPLACE INTO hf_banned_numbers (phone_hash, uid, reason, banned_at, by_uid) VALUES (?1,?2,?3,?4,?5)").bind(cv.phone_hash, uid, reason.slice(0, 200), now, byUid).run();
  } catch (e) { await stFail(env, e, "ban_number", { uid }); }
  const bookings = await cancelBookingsFor(env, uid).catch(() => ({ cancelled: 0, fanUids: [] as string[], blocked: 1 }));
  for (const fan of bookings.fanUids) await queueNotice(env, { uid: fan, event: "booking_cancelled", key: `bkc:${uid}:${fan}:${now}`, ...noticeText.bookingCancelled, path: "/bookings" });
  let money: Awaited<ReturnType<typeof executeBanMoney>> = { refunded: [], refundTotalPaise: 0, failedCalls: [], payout: "none" };
  if (host) money = await executeBanMoney(env, uid, byUid, refundFans).catch((e) => { void stFail(env, e, "ban_money", { uid }); return money; }); // no refunds asked: the earnings are still paid out as for a closed account
  for (const r of money.refunded) await queueNotice(env, { uid: r.fanUid, event: "fan_refunded", key: `refund:${uid}:${r.fanUid}`, ...noticeText.fanRefunded(r.paise), path: "/wallet" });
  await queueNotice(env, { uid, event: "banned", key: `banned:${uid}`, ...noticeText.banned });
  await stTrack(env, uid, "hf_account_banned", { by_uid: byUid, is_host: host, refund_total_paise: money.refundTotalPaise, fans_refunded: money.refunded.length, payout: money.payout, failed_calls: money.failedCalls.length, bookings_cancelled: bookings.cancelled });
  return { ok: true, refunded: money.refunded, refundTotalPaise: money.refundTotalPaise, payout: money.payout, failedCalls: money.failedCalls };
}

export async function restoreAccount(env: Env, uid: string, removeStrikeIds: string[], byUid: string): Promise<{ ok: true; removed: number }> {
  const now = Date.now();
  let removed = 0;
  for (const id of removeStrikeIds.slice(0, 50)) {
    const r = await env.DB_META.prepare("UPDATE hf_strikes SET removed_at=?3, removed_why=?4 WHERE id=?1 AND uid=?2 AND removed_at IS NULL").bind(id, uid, now, `restored by employee`).run();
    removed += Number(r.meta?.changes ?? 0);
  }
  const cur = await env.DB_META.prepare("SELECT status, prior_host_status FROM hf_mod_state WHERE uid=?1").bind(uid).first<{ status: string; prior_host_status: string | null }>().catch(() => null);
  await env.DB_META.prepare("UPDATE hf_mod_state SET status='active', reason=NULL, review_due_at=NULL, payout_pending=0, prior_host_status=NULL, updated_at=?2, by_uid=?3 WHERE uid=?1").bind(uid, now, byUid).run().catch(() => undefined);
  if (cur?.prior_host_status) await env.DB_META.prepare("UPDATE hf_hosts SET status=?2, updated_at=?3 WHERE uid=?1 AND status='paused'").bind(uid, cur.prior_host_status, now).run().catch(() => undefined);
  await env.DB_META.prepare("DELETE FROM hf_banned_numbers WHERE uid=?1").bind(uid).run().catch(() => undefined);
  if (cur && cur.status !== "active") await queueNotice(env, { uid, event: "restored", key: `restored:${uid}:${now}`, ...noticeText.restored });
  await stTrack(env, uid, "hf_account_restored", { by_uid: byUid, strikes_removed: removed, from: cur?.status ?? "active" });
  return { ok: true, removed };
}

// ── appeals ─────────────────────────────────────────────────────────────────────────────────────────────────────
export async function openAppeal(env: Env, uid: string, strikeId: string, message: string, via: "app" | "whatsapp"): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const now = Date.now();
  const s = await env.DB_META.prepare("SELECT id, removed_at, expires_at FROM hf_strikes WHERE id=?1 AND uid=?2").bind(strikeId, uid).first<{ id: string; removed_at: number | null; expires_at: number }>().catch(() => null);
  if (!s) return { ok: false, status: 404, error: "not_found" };
  if (s.removed_at != null || Number(s.expires_at) <= now) return { ok: false, status: 409, error: "not_active" };
  const r = await env.DB_META.prepare("INSERT OR IGNORE INTO hf_appeals (id, strike_id, uid, message, via, status, created_at) VALUES (?1,?2,?3,?4,?5,'open',?6)").bind(crypto.randomUUID(), strikeId, uid, message.slice(0, 1000), via, now).run();
  if (!Number(r.meta?.changes ?? 0)) return { ok: false, status: 409, error: "already_appealed" };
  await queueNotice(env, { uid, event: "appeal_received", key: `appeal:${strikeId}`, ...noticeText.appealReceived });
  await stTrack(env, uid, "hf_appeal_opened", { strike_id: strikeId, via });
  return { ok: true };
}

/** An employee decides an appeal. Accepting removes the strike, and lifts a pause that came from strikes when the count drops under the limit. */
export async function decideAppeal(env: Env, appealId: string, decision: "accept" | "reject", note: string | null, adminUid: string): Promise<{ ok: true; uid: string; restored: boolean } | { ok: false; status: number; error: string }> {
  const now = Date.now();
  const a = await env.DB_META.prepare("SELECT id, strike_id, uid, status FROM hf_appeals WHERE id=?1").bind(appealId).first<{ id: string; strike_id: string; uid: string; status: string }>().catch(() => null);
  if (!a) return { ok: false, status: 404, error: "not_found" };
  const claim = await env.DB_META.prepare("UPDATE hf_appeals SET status=?2, decided_at=?3, decided_by=?4, decision_note=?5 WHERE id=?1 AND status='open'").bind(appealId, decision === "accept" ? "accepted" : "rejected", now, adminUid, note ? note.slice(0, 500) : null).run();
  if (!Number(claim.meta?.changes ?? 0)) return { ok: false, status: 409, error: "already_decided" };
  let restored = false;
  if (decision === "accept") {
    await env.DB_META.prepare("UPDATE hf_strikes SET removed_at=?2, removed_why='appeal accepted' WHERE id=?1 AND removed_at IS NULL").bind(a.strike_id, now).run();
    const cfg = await loadSafetyCfg(env);
    const m = await env.DB_META.prepare("SELECT status, reason FROM hf_mod_state WHERE uid=?1").bind(a.uid).first<{ status: string; reason: string | null }>().catch(() => null);
    if (m?.status === "paused" && m.reason === "strikes" && !shouldPause(await activeStrikes(env, a.uid, now), cfg.strikesToPause)) {
      await restoreAccount(env, a.uid, [], adminUid); restored = true;
    }
  }
  await queueNotice(env, { uid: a.uid, event: "review_decided", key: `appeal_done:${appealId}`, ...(decision === "accept" ? noticeText.appealAccepted : noticeText.appealRejected) });
  await stTrack(env, adminUid, "hf_appeal_decided", { appeal_id: appealId, strike_id: a.strike_id, decision, target_uid: a.uid, restored });
  return { ok: true, uid: a.uid, restored };
}

/** Inbound WhatsApp "APPEAL" -> appeal on the person's latest active strike with no appeal yet. NOT wired: no inbound WasenderAPI webhook exists today. */
export async function appealByWhatsApp(env: Env, e164: string): Promise<"opened" | "no_strike" | "unknown_number"> {
  const hash = await sha256Hex(e164);
  const cv = await env.DB_META.prepare("SELECT uid FROM contact_verification WHERE phone_hash=?1 AND phone_verified=1").bind(hash).first<{ uid: string }>().catch(() => null);
  if (!cv) return "unknown_number";
  const s = await env.DB_META.prepare(
    "SELECT s.id FROM hf_strikes s WHERE s.uid=?1 AND s.removed_at IS NULL AND s.expires_at>?2 AND NOT EXISTS (SELECT 1 FROM hf_appeals a WHERE a.strike_id=s.id) ORDER BY s.created_at DESC LIMIT 1",
  ).bind(cv.uid, Date.now()).first<{ id: string }>().catch(() => null);
  if (!s) return "no_strike";
  const r = await openAppeal(env, cv.uid, s.id, "Appeal by WhatsApp reply", "whatsapp");
  return r.ok ? "opened" : "no_strike";
}

export { activeStrikeCount, brandUrl };
