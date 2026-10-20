// [HF-BOOK-APPROVE-BE] Booking approval (rulebook HF-BOOK-5 / HF-BOOK-6). Plan: Specs/PLAN-2026-10-20-HF-BOOKING-APPROVAL.md (§9a + §9b are binding).
//
//   A fan's booking can wait for the influencer: status 'pending_approval'. The money is held exactly as for a confirmed booking
//   (same reservation, same occupancy, so the slot stays blocked), but the call is not startable, not reminded and not auto-started.
//   The influencer accepts (-> 'confirmed'), declines (-> 'cancelled', full refund to the wallet) or does nothing: at the
//   approval deadline (the earlier of created + 24 h and start - 1 h) the cron cancels it and the hold goes back to the wallet.
//
//   Exactly-once: every outcome is ONE atomic statement guarded by `status='pending_approval'`; the refund goes through the existing
//   hold-release batch (releaseHeldBooking), whose ledger release op (hftrel:<callId>) is UNIQUE. Accept, decline, expiry and the fan's own
//   cancel can race: whichever statement lands first wins, the others change nothing and send nothing.
//
//   Everything here is dark behind hfBookingApprovalEnabled EXCEPT the expiry cron: a pending booking left behind when the flag is
//   switched off must still be refunded on time.
import type { Env } from "../types";
import { BRAND, brandUrl } from "./brand";
import { readConfig } from "../routes/config";
import { track, trackUser, trackException } from "../hooks";
import { callerHandle } from "./hf_call_math";
import { TOPICS } from "./hf_options";
import { releaseHeldBooking, type BookingCleanupRow } from "./hf_booking_store";
import { apptRemindersOn } from "./hf_booking_reminders";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { sendHfPush } from "./hf_push";
import { enqueueEmail } from "./email_outbox";
import { emailFor } from "./identity";
import { realEmailOrNull } from "./placeholder_email";

const APP = BRAND.slug;
const MIN = 60_000, HOUR = 3_600_000;
/** The caller waits at most this long (HF-BOOK-6). */
export const APPROVAL_WINDOW_MS = 24 * HOUR;
/** Manual-approval influencers need this much notice: a booking starting sooner is refused (409 too_soon_for_approval). */
export const APPROVAL_MIN_NOTICE_MS = 2 * HOUR;
/** The decision must land at least this long before the call starts. */
export const APPROVAL_BEFORE_START_MS = HOUR;
/** "Still waiting" nudge to the influencer this long before the deadline. */
export const NUDGE_BEFORE_DEADLINE_MS = 4 * HOUR;
/** The money monitor flags a pending booking this long after its deadline. */
export const MONITOR_GRACE_MS = 15 * MIN;
export const TOO_SOON_TEXT = "This influencer approves bookings by hand, so please book a time at least 2 hours from now.";
export const RULE_24H = "If it isn't accepted within 24 hours, it is cancelled and the caller is refunded.";

export type ApprovalMode = "manual" | "auto";
export type CancelReason = "declined" | "not_accepted_24h" | "fan" | "host";

export async function approvalOn(env: Env): Promise<boolean> {
  try { return ((await readConfig(env)) as unknown as Record<string, unknown>).hfBookingApprovalEnabled === true; } catch { return false; }
}

/** The earlier of "24 h after the request" and "1 h before the call". */
export function approvalDeadline(createdAt: number, startsAt: number): number {
  return Math.min(createdAt + APPROVAL_WINDOW_MS, startsAt - APPROVAL_BEFORE_START_MS);
}

export async function hostApprovalMode(env: Env, hostUid: string): Promise<ApprovalMode> {
  const r = await env.DB_META.prepare("SELECT booking_approval FROM hf_hosts WHERE uid=?1").bind(hostUid)
    .first<{ booking_approval: string | null }>().catch(() => null);
  return r?.booking_approval === "auto" ? "auto" : "manual";
}

export interface TopicRef { slug: string; label: string }
const LABELS = new Map(TOPICS.map((t) => [t.slug, t.label]));
export const topicRef = (slug: string | null | undefined): TopicRef | null => {
  if (!slug) return null;
  const label = LABELS.get(slug);
  return label ? { slug, label } : null;
};
/** The topics an influencer chose at onboarding (1-6 slugs of the fixed catalogue). */
export async function hostTopics(env: Env, hostUid: string): Promise<TopicRef[]> {
  const r = await env.DB_META.prepare("SELECT topics_json FROM hf_hosts WHERE uid=?1").bind(hostUid).first<{ topics_json: string | null }>().catch(() => null);
  return parseTopics(r?.topics_json);
}
export function parseTopics(json: string | null | undefined): TopicRef[] {
  let arr: unknown = [];
  try { arr = json ? JSON.parse(json) : []; } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  const out: TopicRef[] = [];
  for (const v of arr) { const t = typeof v === "string" ? topicRef(v) : null; if (t && !out.some((o) => o.slug === t.slug)) out.push(t); }
  return out;
}

/** null = fine. Manual-approval hosts need >= 2 h notice. */
export function tooSoonForApproval(mode: ApprovalMode, startsAt: number, now: number): boolean {
  return mode === "manual" && startsAt - now < APPROVAL_MIN_NOTICE_MS;
}

// ───────────────────────────── text ─────────────────────────────
const rupees = (paise: number) => `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
const istLabel = (ms: number) => new Date(ms).toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
});
/** "17 h", "3 h 20 min", "45 min" */
export function countdown(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r && h < 10 ? `${h} h ${r} min` : `${h + (r >= 30 && h >= 10 ? 1 : 0)} h`;
}

export interface BookingFacts {
  id: string; host_uid: string; customer_uid: string; starts_at: number; reserved_paise: number;
  topic_slug?: string | null; approval_deadline?: number | null; created_at?: number | null;
  host_name: string | null; fan_name: string | null;
}
/** [HF-BOOK-APPROVE-QA-1] Send messages after the response when the route has an ExecutionContext (the phone waited ~10 s otherwise). */
export type Defer = (p: Promise<unknown>) => void;
async function sendOrDefer(defer: Defer | undefined, p: Promise<unknown>): Promise<void> {
  if (defer) { defer(p.catch(() => undefined)); return; }
  await p;
}
export type MsgEvent = "request" | "accepted" | "declined" | "expired" | "nudge";

export function approvalText(hostName: string, holdPaise: number): string {
  return `Sent to ${hostName} for approval. If not accepted within 24 hours, ${rupees(holdPaise)} returns to your wallet.`;
}

/** Plain-English copy for one side of one event. `hidePeer` = a block exists: no names, the neutral "not available" wording (HF-WELL-3). */
export function messageFor(ev: MsgEvent, side: "fan" | "host", b: BookingFacts, opts: { hidePeer?: boolean } = {}): { push: { title: string; body: string }; text: string; subject: string } {
  const host = (b.host_name ?? "").trim() || "your influencer";
  const fan = callerHandle(b.fan_name);
  const when = istLabel(Number(b.starts_at));
  const hold = rupees(Number(b.reserved_paise));
  const topic = topicRef(b.topic_slug)?.label;
  const aboutTopic = topic ? ` about ${topic}` : "";
  const by = b.approval_deadline ? ` (by ${istLabel(Number(b.approval_deadline))} IST)` : "";
  const link = brandUrl(`/bookings/${encodeURIComponent(b.id)}`);
  const B = BRAND.name;
  const fanPeer = opts.hidePeer ? "the influencer" : host;
  switch (ev) {
    case "request":
      return side === "fan"
        ? { subject: `${B}: booking sent for approval`, push: { title: "Booking sent for approval", body: `${host} has 24 hours to accept. If not, ${hold} returns to your wallet.` },
            text: `${B}: your booking with ${host} for ${when} IST is sent for approval. ${host} has 24 hours to accept; if they don't, ${hold} goes back to your wallet. Open it here: ${link}` }
        : { subject: `${B}: ${fan} wants to book a call`, push: { title: "New booking request", body: `${fan}, ${when}${topic ? `, ${topic}` : ""}. Accept within 24 hours or it is cancelled and refunded.` },
            text: `${B}: ${fan} wants a 10-minute call with you on ${when} IST${aboutTopic}. Please accept within 24 hours${by}. If you don't, the booking is cancelled and ${fan} is refunded. Accept or decline here: ${link}` };
    case "accepted":
      return side === "fan"
        ? { subject: `${B}: your call is confirmed`, push: { title: "Your call is confirmed", body: `${fanPeer} will take your call on ${when} IST.` },
            text: `${B}: confirmed! Your call with ${fanPeer} is on ${when} IST. ${hold} is held; you pay only for the minutes you talk and the rest comes back. Cancel free until 1 hour before. Your number stays hidden. ${link}` }
        : { subject: `${B}: a call is confirmed`, push: { title: "Call confirmed", body: `${fan} calls you on ${when} IST${aboutTopic}.` },
            text: `${B}: confirmed. ${fan} will call you on ${when} IST${aboutTopic}. We will ring you first at that time. ${link}` };
    case "declined":
      return side === "fan"
        ? { subject: `${B}: booking not accepted`, push: { title: "Booking not accepted", body: `${fanPeer} couldn't take your booking. ${hold} is back in your wallet.` },
            text: `${B}: ${fanPeer} couldn't take your booking for ${when} IST. ${hold} is back in your wallet.` }
        : { subject: `${B}: you declined a booking`, push: { title: "Booking declined", body: `The booking for ${when} IST is cancelled and refunded.` },
            text: `${B}: you declined the booking for ${when} IST. The caller was refunded in full.` };
    case "expired":
      return side === "fan"
        ? { subject: `${B}: booking cancelled, money back`, push: { title: "Booking cancelled", body: `${fanPeer} didn't accept in time. ${hold} is back in your wallet.` },
            text: `${B}: ${fanPeer} didn't accept within 24 hours, so your booking for ${when} IST was cancelled. ${hold} is back in your wallet.` }
        : { subject: `${B}: a booking was cancelled`, push: { title: "Booking cancelled", body: `${fan}'s booking for ${when} IST wasn't accepted in time. The caller was refunded.` },
            text: `${B}: the booking from ${fan} for ${when} IST was cancelled because it wasn't accepted within 24 hours. The caller was refunded.` };
    case "nudge":
      return { subject: `${B}: a booking is waiting for you`, push: { title: "Still waiting for you", body: `${fan}'s booking for ${when} IST cancels in about 4 hours unless you accept.` },
        text: `${B}: still waiting. The booking from ${fan} for ${when} IST cancels in about 4 hours if you don't accept it (24-hour rule). Accept or decline here: ${link}` };
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function messageEmailHtml(title: string, line: string): string {
  const plum = "#46113E", mauve = "#785979", line_ = "#E8DCE7", cream = "#FFFDF7";
  const head = "font-family:Nunito,'Segoe UI',Roboto,Arial,sans-serif", body = "font-family:Comfortaa,'Segoe UI',Roboto,Arial,sans-serif";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${cream}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${cream}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${line_};border-radius:18px">
<tr><td style="padding:28px 28px 8px"><div style="${head};font-size:24px;font-weight:800;color:${plum}">${esc(BRAND.name)}</div></td></tr>
<tr><td style="padding:12px 28px 4px"><div style="${head};font-size:24px;font-weight:800;color:${plum}">${esc(title)}</div></td></tr>
<tr><td style="padding:8px 28px 28px"><div style="${body};font-size:16px;line-height:1.5;color:${mauve}">${esc(line)}</div>
<div style="${body};font-size:15px;color:${mauve};margin-top:16px">Questions? Write to <a href="mailto:${esc(BRAND.emails.support)}" style="color:${plum}">${esc(BRAND.emails.support)}</a>.</div></td></tr>
</table><div style="${body};font-size:14px;color:${mauve};padding:16px">${esc(BRAND.name)} · ${esc(BRAND.webOrigin)}</div></td></tr></table></body></html>`;
}

// ───────────────────────────── notify ─────────────────────────────
type Row = { id: string; host_uid: string; customer_uid: string; starts_at: number; reserved_paise: number; topic_slug: string | null; approval_deadline: number | null;
  created_at: number; host_name: string | null; fan_name: string | null; status: string };

export async function loadFacts(env: Env, id: string): Promise<Row | null> {
  return await env.DB_META.prepare(
    `SELECT b.id,b.host_uid,b.customer_uid,b.starts_at,b.reserved_paise,b.topic_slug,b.approval_deadline,b.created_at,b.status,
            h.display_name AS host_name, u.display_name AS fan_name
       FROM hf_bookings b LEFT JOIN hf_hosts h ON h.uid=b.host_uid LEFT JOIN users u ON u.uid=b.customer_uid WHERE b.id=?1`,
  ).bind(id).first<Row>().catch(() => null);
}

async function blocked(env: Env, a: string, b: string): Promise<boolean> {
  return !!(await env.DB_META.prepare("SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1)")
    .bind(a, b).first().catch(() => null));
}

/**
 * Push + WhatsApp (paced outbox) + email for one event to one or both people. Never throws. Honours: a block (host gets nothing, caller gets the neutral wording),
 * the "Appointment reminders" switch (hf_user_prefs.appt_reminders), verified WhatsApp only, a real email only. Each message is keyed so a retry never doubles it.
 */
export async function notifyBooking(env: Env, ev: MsgEvent, b: BookingFacts, sides: Array<"fan" | "host"> = ["fan", "host"]): Promise<void> {
  try {
    const isBlocked = await blocked(env, b.customer_uid, b.host_uid);
    for (const side of sides) {
      if (isBlocked && side === "host") continue;
      const uid = side === "fan" ? b.customer_uid : b.host_uid;
      if (!(await apptRemindersOn(env, uid))) { void track(env, uid, "hf_booking_msg_sent", APP, { event: ev, channel: "all", result: "switched_off", booking_id: b.id }).catch(() => undefined); continue; }
      const m = messageFor(ev, side, b, { hidePeer: isBlocked });
      const now = Date.now();
      // push
      let result = "skipped";
      try { result = (await sendHfPush(env, uid, { kind: ev === "request" ? "booking_request" : ev === "nudge" ? "booking_nudge" : "booking_update", title: m.push.title, body: m.push.body, path: `/bookings/${encodeURIComponent(b.id)}` })) ? "queued" : "skipped"; }
      catch { result = "failed"; }
      void track(env, uid, "hf_booking_msg_sent", APP, { event: ev, channel: "push", result, booking_id: b.id }).catch(() => undefined);
      // WhatsApp (paced outbox; UNIQUE(checkout_id, kind, url_hash) makes a retry a no-op)
      result = "skipped";
      try {
        const e164 = await verifiedWhatsAppNumber(env, uid);
        if (e164) {
          const r = await env.DB_META.prepare(
            `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)`,
          ).bind(`hfb:${b.id}:${uid}`, uid, b.id, `hf_booking_${ev}`, ev, e164, m.text, now).run();
          result = r.meta?.changes ? "queued" : "duplicate";
        } else result = "no_verified_whatsapp";
      } catch { result = "failed"; }
      void track(env, uid, "hf_booking_msg_sent", APP, { event: ev, channel: "whatsapp", result, booking_id: b.id }).catch(() => undefined);
      // email
      result = "skipped";
      try {
        const email = realEmailOrNull(await emailFor(env, uid).catch(() => null));
        if (email) {
          const q = await enqueueEmail(env, {
            to: email, subject: m.subject, html: messageEmailHtml(m.push.title, m.text),
            outboxKey: `hf-book:${b.id}:${ev}:${uid}`, kind: "hf_booking", orderId: b.id, recipientId: uid,
            replyTo: { email: BRAND.emails.support, name: BRAND.name },
          });
          result = q.status === "failed" || q.status === "bounced" || q.status === "unavailable" ? "failed" : q.queued ? "queued" : "duplicate";
        } else result = "no_email";
      } catch { result = "failed"; }
      void track(env, uid, "hf_booking_msg_sent", APP, { event: ev, channel: "email", result, booking_id: b.id }).catch(() => undefined);
    }
  } catch (e) {
    await trackException(env, e, { route: "hf_booking_approval.notify", handled: true, app_name: APP, extra: { area: "hf_booking_approval", event: ev, booking_id: b.id } }).catch(() => undefined);
  }
}

/** The outbox drain calls this just before sending a request / nudge: it is stale once the booking is no longer waiting. */
export async function revalidateApprovalMessage(env: Env, row: { listing_id: string }): Promise<"eligible" | "cancelled"> {
  const r = await env.DB_META.prepare("SELECT status FROM hf_bookings WHERE id=?1").bind(row.listing_id).first<{ status: string }>().catch(() => null);
  return r?.status === "pending_approval" ? "eligible" : "cancelled";
}

// ───────────────────────────── telemetry ─────────────────────────────
/** Two-sided events carry both people's uid and email (CLAUDE.md: assert the success value, not just arrival). */
export async function emitBookingEvent(env: Env, event: string, actorUid: string, hostUid: string, fanUid: string, props: Record<string, unknown>): Promise<void> {
  try {
    const [hostEmail, fanEmail] = await Promise.all([emailFor(env, hostUid).catch(() => null), emailFor(env, fanUid).catch(() => null)]);
    await trackUser(env, actorUid, actorUid === hostUid ? hostEmail : fanEmail, event, APP, { ...props, host_uid: hostUid, fan_uid: fanUid, host_email: hostEmail, fan_email: fanEmail });
  } catch (e) {
    await trackException(env, e, { route: "hf_booking_approval.emit", handled: true, app_name: APP, extra: { area: "hf_booking_approval", event } }).catch(() => undefined);
  }
}

// ───────────────────────────── decisions ─────────────────────────────
export type Outcome = { ok: true; row: Row } | { ok: false; reason: "not_found" | "not_pending" | "expired" | "hold_unavailable" };

async function cleanupRow(env: Env, id: string): Promise<BookingCleanupRow | null> {
  return await env.DB_META.prepare("SELECT id,call_id,customer_uid,host_uid,status,settlement_status FROM hf_bookings WHERE id=?1").bind(id).first<BookingCleanupRow>().catch(() => null);
}
const reasonOf = async (env: Env, id: string) =>
  await env.DB_META.prepare("SELECT status,cancel_reason,decided_by FROM hf_bookings WHERE id=?1").bind(id).first<{ status: string; cancel_reason: string | null; decided_by: string | null }>().catch(() => null);

/**
 * Cancel a pending booking and give the hold back to the wallet. `reason` is what gets recorded; true only when THIS call did it
 * (a racing accept / fan-cancel / second expiry leaves status or cancel_reason different and nothing is sent twice).
 */
export async function cancelPending(env: Env, id: string, reason: "declined" | "not_accepted_24h", decidedBy: string, eventOp: string, now: number, actorUid: string | null): Promise<"done" | "lost" | "hold_unavailable"> {
  const row = await cleanupRow(env, id);
  if (!row || row.status !== "pending_approval" || row.settlement_status !== "held" || !row.call_id) return "lost";
  let ok = false;
  try { ok = await releaseHeldBooking(env, row, now, "cancelled", reason, { cancelReason: reason, decidedBy, eventOp, actorUid }); }
  catch (e) { await trackException(env, e, { route: "hf_booking_approval.cancel", handled: true, app_name: APP, extra: { area: "hf_booking_approval", booking_id: id, reason } }).catch(() => undefined); return "hold_unavailable"; }
  if (!ok) {
    const after = await reasonOf(env, id);
    return after?.status === "pending_approval" ? "hold_unavailable" : "lost";
  }
  const after = await reasonOf(env, id);
  return after?.cancel_reason === reason && after.decided_by === decidedBy ? "done" : "lost";
}

export async function acceptPending(env: Env, id: string, hostUid: string, now = Date.now(), defer?: Defer): Promise<Outcome> {
  const cur = await loadFacts(env, id);
  if (!cur || cur.host_uid !== hostUid) return { ok: false, reason: "not_found" };
  if (cur.status !== "pending_approval") return { ok: false, reason: await wasExpired(env, id) ? "expired" : "not_pending" };
  if (cur.approval_deadline != null && Number(cur.approval_deadline) <= now) {
    await expireOne(env, id, now); // lazy: the caller is refunded right now instead of waiting for the next cron tick
    return { ok: false, reason: "expired" };
  }
  const res = await env.DB_META.batch([
    env.DB_META.prepare("UPDATE hf_bookings SET status='confirmed',approved_at=?1,decided_by=?2,updated_at=?1 WHERE id=?3 AND host_uid=?2 AND status='pending_approval' AND settlement_status='held' AND (approval_deadline IS NULL OR approval_deadline>?1)")
      .bind(now, hostUid, id),
    env.DB_META.prepare("INSERT OR IGNORE INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) SELECT ?1,?2,?3,?4,'pending_approval','confirmed',?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='confirmed' AND approved_at=?6 AND decided_by=?4)")
      .bind(crypto.randomUUID(), id, "hfbook-accept:" + id, hostUid, JSON.stringify({ by: "host" }), now),
  ]);
  if (Number(res[0]?.meta?.changes ?? 0) !== 1) {
    const after = await loadFacts(env, id);
    return { ok: false, reason: after && after.status === "cancelled" && await wasExpired(env, id) ? "expired" : "not_pending" };
  }
  const row = (await loadFacts(env, id))!;
  void emitBookingEvent(env, "hf_booking_accepted", hostUid, row.host_uid, row.customer_uid, {
    booking_id: id, latency_min: Math.max(0, Math.round((now - Number(row.created_at)) / MIN)), amount_paise: Number(row.reserved_paise),
  });
  await sendOrDefer(defer, notifyBooking(env, "accepted", row));
  return { ok: true, row };
}

async function wasExpired(env: Env, id: string): Promise<boolean> {
  return (await reasonOf(env, id))?.cancel_reason === "not_accepted_24h";
}

export async function declinePending(env: Env, id: string, hostUid: string, now = Date.now(), defer?: Defer): Promise<Outcome & { already?: boolean }> {
  const cur = await loadFacts(env, id);
  if (!cur || cur.host_uid !== hostUid) return { ok: false, reason: "not_found" };
  if (cur.status !== "pending_approval") {
    const r = await reasonOf(env, id);
    if (r?.status === "cancelled" && r.cancel_reason === "declined" && r.decided_by === hostUid) return { ok: true, row: cur, already: true };
    return { ok: false, reason: r?.cancel_reason === "not_accepted_24h" ? "expired" : "not_pending" };
  }
  const out = await cancelPending(env, id, "declined", hostUid, "hfbook-decline:" + id, now, hostUid);
  if (out === "hold_unavailable") return { ok: false, reason: "hold_unavailable" };
  if (out === "lost") {
    const r = await reasonOf(env, id);
    return { ok: false, reason: r?.cancel_reason === "not_accepted_24h" ? "expired" : "not_pending" };
  }
  const row = (await loadFacts(env, id))!;
  void emitBookingEvent(env, "hf_booking_declined", hostUid, row.host_uid, row.customer_uid, { booking_id: id, refund_paise: Number(row.reserved_paise) });
  await sendOrDefer(defer, notifyBooking(env, "declined", row));
  return { ok: true, row };
}

async function expireOne(env: Env, id: string, now: number): Promise<boolean> {
  const out = await cancelPending(env, id, "not_accepted_24h", "system", "hfbook-expire:" + id, now, null);
  if (out !== "done") return false;
  const row = await loadFacts(env, id);
  if (row) {
    void emitBookingEvent(env, "hf_booking_expired_refunded", "system", row.host_uid, row.customer_uid, { booking_id: id, amount_paise: Number(row.reserved_paise) });
    await notifyBooking(env, "expired", row);
  }
  return true;
}
/** Used by the money monitor to put a stuck pending booking right (same exactly-once path as the cron). */
export const expirePendingBooking = (env: Env, id: string, now = Date.now()) => expireOne(env, id, now);

// ───────────────────────────── crons ─────────────────────────────
const noColumn = (e: unknown) => /no such (column|table)/i.test(String((e as Error)?.message ?? e));

export interface ExpiryResult { scanned: number; expired: number; blocked: number; nudged: number }

/** Every cron tick. NOT behind the flag: a pending booking must be refunded on time even if the flag was switched off. Never throws. */
export async function runHfBookingApprovalExpiry(env: Env, now = Date.now()): Promise<ExpiryResult> {
  const out: ExpiryResult = { scanned: 0, expired: 0, blocked: 0, nudged: 0 };
  try {
    const due = (await env.DB_META.prepare(
      "SELECT id FROM hf_bookings WHERE status='pending_approval' AND settlement_status='held' AND approval_deadline IS NOT NULL AND approval_deadline<=?1 ORDER BY approval_deadline LIMIT 50",
    ).bind(now).all<{ id: string }>()).results ?? [];
    for (const d of due) {
      out.scanned++;
      try { if (await expireOne(env, d.id, now)) out.expired++; else out.blocked++; }
      catch (e) { out.blocked++; await trackException(env, e, { route: "hf_booking_approval.expiry", handled: true, app_name: APP, extra: { area: "hf_booking_approval", booking_id: d.id } }).catch(() => undefined); }
    }
    // "Still waiting" nudge to the influencer ~4 h before the deadline (only when the window was long enough that it is not redundant).
    const soon = (await env.DB_META.prepare(
      "SELECT id FROM hf_bookings WHERE status='pending_approval' AND approval_deadline>?1 AND approval_deadline<=?2 AND approval_deadline-created_at>=?3 ORDER BY approval_deadline LIMIT 50",
    ).bind(now, now + NUDGE_BEFORE_DEADLINE_MS, NUDGE_BEFORE_DEADLINE_MS + HOUR).all<{ id: string }>()).results ?? [];
    for (const s of soon) {
      const claim = await env.DB_META.prepare(
        "INSERT OR IGNORE INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) SELECT ?1,?2,?3,NULL,'pending_approval','pending_approval',?4,?5 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status='pending_approval')",
      ).bind(crypto.randomUUID(), s.id, "hfbook-nudge:" + s.id, JSON.stringify({ nudge: "t-4h" }), now).run();
      if (!claim.meta?.changes) continue;
      const row = await loadFacts(env, s.id);
      if (row) { await notifyBooking(env, "nudge", row, ["host"]); out.nudged++; }
    }
  } catch (e) {
    if (!noColumn(e)) await trackException(env, e, { route: "hf_booking_approval.expiry", handled: true, app_name: APP, extra: { area: "hf_booking_approval" } }).catch(() => undefined);
  }
  return out;
}

/** Cancel-reason for a fan/host cancel of a pending (or confirmed) booking, used by cancelRoute. */
export const cancelReasonFor = (role: "host" | "customer"): CancelReason => (role === "host" ? "host" : "fan");
