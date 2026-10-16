// [HF-APPT-REMIND-1] Appointment reminders for Hello Fraands bookings (rulebook HF-BOOK-REMIND-1).
//   runHfBookingReminders(env, now?)   cron (every 5 min, index.ts scheduled()): queues reminders into the paced whatsapp_outbox
//   revalidateBookingReminder(env, row) the drain calls this just before sending: the booking must still be on and in the future
// Two reminders per person per booking, to BOTH the customer and the influencer: about 1 hour before and about 10 minutes before.
// Idempotent through whatsapp_outbox UNIQUE(checkout_id, kind, url_hash): checkout_id = "hfb:<bookingId>:<uid>", url_hash = "t60" | "t10".
// Gates (silent skips): flag hfBookingRemindersEnabled, the person's "Appointment reminders" switch (hf_user_prefs.appt_reminders),
// a verified WhatsApp number, no block between the two people. Push to the Android app goes out with the WhatsApp when push is on.
// Never sends a phone number; the other person is named by display name (influencer) or handle (customer).
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND, brandUrl } from "./brand";
import { readConfig } from "../routes/config";
import { verifiedWhatsAppNumber } from "./whatsapp_notify";
import { callerHandle } from "./hf_call_math";
import { sendHfPush } from "./hf_push";

const APP = BRAND.slug;
export const REMIND_KIND = "hf_booking_reminder";
const MIN = 60_000;
/** Each window: send when the booking starts within (from, to] minutes from now. Cron runs every 5 min, so windows are 15 min wide. */
export const WINDOWS = [{ tag: "t60", from: 50, to: 65 }, { tag: "t10", from: 0, to: 15 }] as const;
const LIVE = "('confirmed','starting')";

export const istClock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export function reminderText(role: "customer" | "host", other: string, startsAt: number, tag: string, bookingId: string): string {
  const when = tag === "t60" ? "in about 1 hour" : "in about 10 minutes";
  const link = brandUrl(`/bookings/${encodeURIComponent(bookingId)}`);
  return role === "customer"
    ? `${BRAND.name}: your call with ${other} starts at ${istClock(startsAt)} IST (${when}). Open it here: ${link} · Your number stays hidden.`
    : `${BRAND.name}: your booked call with ${other} starts at ${istClock(startsAt)} IST (${when}). Please be online a few minutes early: ${link}`;
}

export async function remindersOn(env: Env): Promise<boolean> {
  try { return ((await readConfig(env)) as unknown as Record<string, unknown>).hfBookingRemindersEnabled !== false; } catch { return false; }
}
/** The person's "Appointment reminders" switch. Default on; a missing table, column or row counts as on. */
export async function apptRemindersOn(env: Env, uid: string): Promise<boolean> {
  const r = await env.DB_META.prepare("SELECT appt_reminders FROM hf_user_prefs WHERE uid=?1").bind(uid).first<{ appt_reminders: number }>().catch(() => null);
  return r ? Number(r.appt_reminders) !== 0 : true;
}

type Row = { id: string; host_uid: string; customer_uid: string; starts_at: number; host_name: string | null; customer_name: string | null };

export async function runHfBookingReminders(env: Env, now = Date.now()): Promise<{ scanned: number; queued: number; skipped: number }> {
  const out = { scanned: 0, queued: 0, skipped: 0 };
  if (!(await remindersOn(env))) return out;
  for (const w of WINDOWS) {
    const rows = (await env.DB_META.prepare(
      `SELECT b.id, b.host_uid, b.customer_uid, b.starts_at,
              (SELECT display_name FROM hf_hosts h WHERE h.uid=b.host_uid) AS host_name,
              (SELECT display_name FROM users u WHERE u.uid=b.customer_uid) AS customer_name
         FROM hf_bookings b WHERE b.status IN ${LIVE} AND b.cancelled_at IS NULL AND b.starts_at>?1 AND b.starts_at<=?2
        ORDER BY b.starts_at LIMIT 200`,
    ).bind(now + w.from * MIN, now + w.to * MIN).all<Row>().catch(() => null))?.results ?? [];
    for (const b of rows) {
      out.scanned++;
      try {
        const blocked = await env.DB_META.prepare("SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1)")
          .bind(b.customer_uid, b.host_uid).first();
        if (blocked) { out.skipped += 2; continue; }
        const parties: ["customer" | "host", string, string][] = [
          ["customer", b.customer_uid, (b.host_name ?? "").trim() || "your influencer"],
          ["host", b.host_uid, callerHandle(b.customer_name)],
        ];
        for (const [role, uid, other] of parties) {
          if (!(await apptRemindersOn(env, uid))) { out.skipped++; continue; }
          const e164 = await verifiedWhatsAppNumber(env, uid);
          if (!e164) { out.skipped++; continue; }
          const msg = reminderText(role, other, Number(b.starts_at), w.tag, b.id);
          const r = await env.DB_META.prepare(
            `INSERT OR IGNORE INTO whatsapp_outbox (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)`,
          ).bind(`hfb:${b.id}:${uid}`, uid, b.id, REMIND_KIND, w.tag, e164, msg, now).run();
          if (r.meta?.changes) {
            out.queued++;
            void track(env, uid, "hf_booking_reminder_queued", APP, { booking_id: b.id, role, window: w.tag, channel: "whatsapp" });
            void sendHfPush(env, uid, { kind: "booking_reminder", title: w.tag === "t60" ? "Your call is in 1 hour" : "Your call starts soon", body: `With ${other} at ${istClock(Number(b.starts_at))} IST.`, path: `/bookings/${encodeURIComponent(b.id)}` });
          }
        }
      } catch (e) {
        await trackException(env, e, { route: "hf_booking_reminders", handled: true, app_name: APP, extra: { area: "hf_booking_reminders", booking_id: b.id, window: w.tag } }).catch(() => undefined);
      }
    }
  }
  return out;
}

/** Called by the outbox drain right before sending a reminder: cancelled, moved, already started, blocked or switched off = do not send. */
export async function revalidateBookingReminder(env: Env, row: { uid: string; listing_id: string; e164: string }, now = Date.now()): Promise<"eligible" | "cancelled"> {
  if (!(await remindersOn(env))) return "cancelled";
  const b = await env.DB_META.prepare(`SELECT host_uid, customer_uid, starts_at FROM hf_bookings WHERE id=?1 AND status IN ${LIVE} AND cancelled_at IS NULL`)
    .bind(row.listing_id).first<{ host_uid: string; customer_uid: string; starts_at: number }>().catch(() => null);
  if (!b || Number(b.starts_at) <= now - 5 * MIN) return "cancelled";
  const blocked = await env.DB_META.prepare("SELECT 1 AS x FROM hf_blocks WHERE (blocker_uid=?1 AND blocked_uid=?2) OR (blocker_uid=?2 AND blocked_uid=?1)").bind(b.customer_uid, b.host_uid).first();
  if (blocked || !(await apptRemindersOn(env, row.uid))) return "cancelled";
  const e164 = await verifiedWhatsAppNumber(env, row.uid);
  return e164 && e164 === row.e164 ? "eligible" : "cancelled";
}
