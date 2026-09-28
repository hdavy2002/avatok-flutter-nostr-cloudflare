// [WA-NOTIFY-1 2026-09-28] Owner decision: buyers get a WhatsApp message (in
// addition to the existing emails, which keep going unchanged) when the admin
// enters/changes an event's live-stream link or its video-download link.
// Only confirmed buyers of that specific listing (saathum_checkouts.status='confirmed')
// ever get either message, and only if they have a WhatsApp-verified number
// (routes/phone_otp.ts) — buyers with no verified number are skipped and counted,
// never blocked or emailed instead.
//
// PACING: WasenderAPI is an unofficial WhatsApp gateway riding a real linked
// number (see lib/whatsapp_send.ts) — a burst of sends risks a ban. So this file
// splits the work in two:
//   1. sendSaathumLiveLinkWhatsApp / sendSaathumVideoReadyWhatsApp (called from the
//      admin save path, same place the existing emails fire) only WRITE queued rows
//      to `whatsapp_outbox` — cheap D1 inserts, no WhatsApp API calls, so they are
//      safe to await inline and can never make an admin save fail or hang.
//   2. runWhatsAppOutboxDrain does the actual sending, paced at ~1 message / 2s,
//      capped at `limit` per call. It is wired into the existing 5-minute cron
//      (index.ts scheduled()) rather than a new Cloudflare Queue: the cron already
//      runs every tick, a capped+paced pass comfortably finishes inside one tick,
//      and it keeps sends out of the request path entirely (no ctx.waitUntil bomb
//      on the admin's save request). A queue consumer would work too, but would
//      need its own concurrency=1 + explicit delay configuration to get the same
//      pacing guarantee — the cron gives it for free.
//
// Dedupe: whatsapp_outbox has UNIQUE(checkout_id, kind, url_hash). Re-saving the
// same link is a no-op (INSERT OR IGNORE matches the existing row); a corrected
// link hashes differently and queues a fresh message — same shape as the email
// outbox key in sendSaathumVideoReadyEmails (routes/saathum_checkout.ts).
import type { Env } from "../types";
import { sha256Hex } from "../util";
import { track, trackException } from "../hooks";
import { sendWhatsAppText } from "./whatsapp_send";

const APP = "saathum";
const MAX_SEND_ATTEMPTS = 6;

export type NotifyKind = "live_link" | "video_ready";

export type NotifyResult = { recipients: number; sent: number; skipped_no_phone: number; failed: number };

/** "Sun, 4 Oct 2026 at 7:00 PM IST" */
export function formatIst(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(ms).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string, string>);
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} IST`;
}

/** Mirrors phoneOtpStatus's lookup (routes/phone_otp.ts) without importing a route module. */
async function verifiedWhatsAppNumber(env: Env, uid: string): Promise<string | null> {
  const db = env.DB_META;
  const cv = await db.prepare("SELECT phone_verified, phone_hash FROM contact_verification WHERE uid=?1")
    .bind(uid).first<{ phone_verified: number; phone_hash: string | null }>().catch(() => null);
  if (!cv || Number(cv.phone_verified) !== 1 || !cv.phone_hash) return null;
  const row = await db.prepare(
    "SELECT e164 FROM phone_otp WHERE uid=?1 AND phone_hash=?2 AND status='verified' ORDER BY verified_at DESC LIMIT 1",
  ).bind(uid, cv.phone_hash).first<{ e164: string }>().catch(() => null);
  return row?.e164 ?? null;
}

async function enqueueWhatsAppNotifications(
  env: Env, listingId: string, kind: NotifyKind, url: string,
  buildText: (title: string, startsAtMs: number | null) => string,
): Promise<NotifyResult> {
  const db = env.DB_META;
  const listing = await db.prepare("SELECT title, starts_at FROM listings WHERE id=?1")
    .bind(listingId).first<{ title: string; starts_at: number | null }>().catch(() => null);
  const text = buildText(listing?.title ?? "Saa Thum booking", listing?.starts_at ?? null);
  const rows = await db.prepare(
    `SELECT checkout_id, uid FROM saathum_checkouts WHERE listing_id=?1 AND status='confirmed' LIMIT 2000`,
  ).bind(listingId).all<{ checkout_id: string; uid: string }>();
  const buyers = rows.results ?? [];
  const urlHash = (await sha256Hex(url)).slice(0, 16);
  const now = Date.now();
  let sent = 0, skipped = 0, failed = 0;
  for (const row of buyers) {
    try {
      const e164 = await verifiedWhatsAppNumber(env, row.uid);
      if (!e164) { skipped++; continue; }
      const res = await db.prepare(
        `INSERT OR IGNORE INTO whatsapp_outbox
          (checkout_id, uid, listing_id, kind, url_hash, e164, message, status, attempts, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)`,
      ).bind(row.checkout_id, row.uid, listingId, kind, urlHash, e164, text, now).run();
      if (res.meta?.changes) sent++;
    } catch (err) {
      failed++;
      await trackException(env, err, {
        uid: row.uid, route: "whatsapp_notify:enqueue", handled: true, app_name: APP,
        extra: { kind, listing_id: listingId },
      });
    }
  }
  // Never log full phone numbers here — recipients/sent/skipped/failed are counts only.
  await track(env, "system", "whatsapp_event_notify", APP, {
    kind, listing_id: listingId, recipients: buyers.length, sent, skipped_no_phone: skipped, failed,
  });
  return { recipients: buyers.length, sent, skipped_no_phone: skipped, failed };
}

/** Owner decision 2026-09-28: admin sets/changes the live-stream link -> every confirmed buyer. */
export function sendSaathumLiveLinkWhatsApp(env: Env, listingId: string, url: string): Promise<NotifyResult> {
  return enqueueWhatsAppNotifications(env, listingId, "live_link", url, (title, startsAtMs) => {
    const when = startsAtMs ? formatIst(startsAtMs) : "soon — check the event page for the exact time";
    return `🙏 ${title}\nThe live stream starts ${when}.\nWatch here: ${url}\n\nThis link is only for your booking — please don't share it.\n— Saa Thum`;
  });
}

/** Owner decision 2026-09-28: admin sets/changes the video-download link -> every confirmed buyer. */
export function sendSaathumVideoReadyWhatsApp(env: Env, listingId: string, url: string): Promise<NotifyResult> {
  return enqueueWhatsAppNotifications(env, listingId, "video_ready", url, (title) => {
    return `🙏 ${title}\nYour video is ready. Download it here: ${url}\n\nIt also stays under My events on saathum.com.\n— Saa Thum`;
  });
}

/**
 * Cron drain (index.ts scheduled()): sends up to `limit` queued messages, at
 * ~1 / 2s, and returns. Never throws. A `rate_limited` failure is retried (up
 * to MAX_SEND_ATTEMPTS) on a later tick; every other failure — including
 * `not_on_whatsapp`, which can't succeed on retry — is terminal.
 */
export async function runWhatsAppOutboxDrain(env: Env, limit = 25): Promise<{ scanned: number; sent: number; failed: number }> {
  if (!(env.WASENDER_API_KEY ?? "").trim()) return { scanned: 0, sent: 0, failed: 0 };
  const db = env.DB_META;
  const rows = await db.prepare(
    `SELECT id, uid, e164, message, kind, listing_id, attempts FROM whatsapp_outbox
      WHERE status='queued' ORDER BY created_at ASC LIMIT ?1`,
  ).bind(Math.max(1, Math.min(100, limit))).all<{
    id: number; uid: string; e164: string; message: string; kind: string; listing_id: string; attempts: number;
  }>().catch(() => null);
  const list = rows?.results ?? [];
  let sent = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const now = Date.now();
    try {
      const res = await sendWhatsAppText(env, row.e164, row.message);
      if (res.ok) {
        await db.prepare("UPDATE whatsapp_outbox SET status='sent', sent_at=?2, updated_at=?2, attempts=attempts+1 WHERE id=?1")
          .bind(row.id, now).run();
        sent++;
      } else {
        failed++;
        const attempts = row.attempts + 1;
        const retryable = res.reason === "rate_limited" && attempts < MAX_SEND_ATTEMPTS;
        await db.prepare("UPDATE whatsapp_outbox SET status=?2, error=?3, attempts=?4, updated_at=?5 WHERE id=?1")
          .bind(row.id, retryable ? "queued" : "failed", res.detail.slice(0, 300), attempts, now).run();
        await trackException(env, new Error(`whatsapp_send_failed:${res.reason}`), {
          uid: row.uid, route: "whatsapp_outbox_drain", handled: true, app_name: APP,
          extra: { kind: row.kind, listing_id: row.listing_id, reason: res.reason, retryable },
        });
      }
    } catch (err) {
      failed++;
      await trackException(env, err, { uid: row.uid, route: "whatsapp_outbox_drain", handled: true, app_name: APP });
    }
    // ~1 message / 2s — see the pacing note at the top of this file.
    if (i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { scanned: list.length, sent, failed };
}
