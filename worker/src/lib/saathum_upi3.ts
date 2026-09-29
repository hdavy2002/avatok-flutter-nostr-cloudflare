// [SAATHUM-UPI-3LAYER 2026-09-29] Helpers for the 3-layer UPI confirmation
// (Specs/PLAN-SAATHUM-UPI-3LAYER.md): unique-amount reservation, ingest-source health,
// and the cron sweeps (persist review_pending, admin/stale-source WhatsApp alerts).
// I/O lives here so lib/saathum_checkout_logic.ts stays pure.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { track, trackException } from "../hooks";
import { sendWhatsAppText } from "./whatsapp_send";
import {
  AMOUNT_COOLDOWN_MS, MAX_ROUNDING_DISCOUNT_PAISE, PAID_CLAIM_REVIEW_MS, REVIEW_ALERT_AFTER_MS,
} from "./saathum_checkout_logic";

const APP = "saathum";

// ---------------------------------------------------------------------------
// Unique-amount reservation
// ---------------------------------------------------------------------------
export type Reservation = { amountPaise: number; roundingDiscountPaise: number };

/**
 * Reserve total*100 - k paise (k in 1..199) for `checkoutId`, unique per receiving account
 * among open checkouts and for AMOUNT_COOLDOWN_MS after they expire/cancel. The PRIMARY KEY on
 * saathum_amount_reservations is the enforcement; a taken slot is re-used only by a single
 * guarded upsert (reserved_until passed AND the previous holder is not in the review queue).
 * Returns null when every slot is taken (caller answers 503 amount_pool_exhausted).
 * `rand` is injectable for tests.
 */
export async function reserveUniqueAmount(
  env: Env,
  a: { account: string; totalRupees: number; checkoutId: string; now: number; expiresAt: number },
  rand: () => number = Math.random,
): Promise<Reservation | null> {
  const db = metaDb(env);
  const totalPaise = a.totalRupees * 100;
  const kMax = Math.min(MAX_ROUNDING_DISCOUNT_PAISE, totalPaise - 1);
  if (kMax < 1) return null;
  const reservedUntil = a.expiresAt + AMOUNT_COOLDOWN_MS;
  // Slots that are definitely free right now (one read); the upsert below re-checks atomically.
  const taken = await db.prepare(
    `SELECT r.amount_paise FROM saathum_amount_reservations r
      WHERE r.receiving_account_key=?1 AND r.amount_paise BETWEEN ?2 AND ?3
        AND (r.reserved_until >= ?4 OR EXISTS (SELECT 1 FROM saathum_checkouts c WHERE c.checkout_id=r.checkout_id AND c.status='review_pending'))`,
  ).bind(a.account, totalPaise - kMax, totalPaise - 1, a.now).all<{ amount_paise: number }>();
  const takenSet = new Set((taken.results ?? []).map((r) => Number(r.amount_paise)));
  const free: number[] = [];
  for (let k = 1; k <= kMax; k++) if (!takenSet.has(totalPaise - k)) free.push(k);
  for (let attempt = 0; attempt < 25 && free.length; attempt++) {
    const i = Math.min(free.length - 1, Math.floor(rand() * free.length));
    const k = free.splice(i, 1)[0];
    const amount = totalPaise - k;
    const res = await db.prepare(
      `INSERT INTO saathum_amount_reservations (receiving_account_key,amount_paise,checkout_id,reserved_until,created_at)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(receiving_account_key,amount_paise) DO UPDATE SET
         checkout_id=excluded.checkout_id, reserved_until=excluded.reserved_until, created_at=excluded.created_at
       WHERE saathum_amount_reservations.reserved_until < ?5
         AND NOT EXISTS (SELECT 1 FROM saathum_checkouts c WHERE c.checkout_id=saathum_amount_reservations.checkout_id AND c.status='review_pending')`,
    ).bind(a.account, amount, a.checkoutId, reservedUntil, a.now).run();
    if (Number((res as any).meta?.changes ?? 0) === 1) return { amountPaise: amount, roundingDiscountPaise: k };
    // lost a race for this slot -> try another
  }
  await track(env, "system", "saathum_amount_pool_exhausted", APP, { total_rupees: a.totalRupees });
  return null;
}

/** Give a slot back immediately (checkout insert failed, or the payment was confirmed). */
export async function releaseAmount(env: Env, checkoutId: string, now = Date.now(), cooldownMs = 0): Promise<void> {
  try {
    await metaDb(env).prepare(`UPDATE saathum_amount_reservations SET reserved_until=?2 WHERE checkout_id=?1`).bind(checkoutId, now + cooldownMs - 1).run();
  } catch { /* best-effort */ }
}

/** Drop a reservation row entirely (the checkout row was never created). */
export async function dropReservation(env: Env, checkoutId: string): Promise<void> {
  try { await metaDb(env).prepare(`DELETE FROM saathum_amount_reservations WHERE checkout_id=?1`).bind(checkoutId).run(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Ingest-source health (companion app / Google Messages watcher)
// ---------------------------------------------------------------------------
export type SmsSource = "companion" | "watcher";

/** Which configured device (if any) this device_id is, and its shared secret. */
export function resolveSmsDevice(env: Env, deviceId: string): { source: SmsSource; secret: string } | null {
  if (env.HDFC_SMS_DEVICE_ID && deviceId === env.HDFC_SMS_DEVICE_ID && env.HDFC_SMS_DEVICE_SECRET) {
    return { source: "companion", secret: env.HDFC_SMS_DEVICE_SECRET };
  }
  if (env.HDFC_SMS_WATCHER_DEVICE_ID && deviceId === env.HDFC_SMS_WATCHER_DEVICE_ID && env.HDFC_SMS_WATCHER_DEVICE_SECRET) {
    return { source: "watcher", secret: env.HDFC_SMS_WATCHER_DEVICE_SECRET };
  }
  return null;
}

/** Best-effort upsert; never breaks the SMS ack (table may not be migrated yet). */
export async function touchSourceHealth(
  env: Env, deviceId: string, source: SmsSource, kind: "heartbeat" | "sms", now = Date.now(), error: string | null = null,
): Promise<void> {
  try {
    await metaDb(env).prepare(
      `INSERT INTO sms_source_health (device_id,source,last_heartbeat_at,last_sms_at,last_error,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(device_id) DO UPDATE SET
         source=excluded.source,
         last_heartbeat_at=CASE WHEN ?7='heartbeat' THEN excluded.last_heartbeat_at ELSE sms_source_health.last_heartbeat_at END,
         last_sms_at=CASE WHEN ?7='sms' THEN excluded.last_sms_at ELSE sms_source_health.last_sms_at END,
         last_error=?5, updated_at=excluded.updated_at`,
    ).bind(deviceId, source, kind === "heartbeat" ? now : null, kind === "sms" ? now : null, error, now, kind).run();
  } catch (err) {
    await trackException(env, err, { route: "sms_source_health", handled: true, app_name: APP });
  }
}

export const SOURCE_STALE_MS = 15 * 60_000;
export const SOURCE_REALERT_MS = 60 * 60_000;

export type SourceHealthRow = {
  device_id: string; source: string; last_heartbeat_at: number | null; last_sms_at: number | null;
  last_error: string | null; alerted_at: number | null; stale_alert_open: number;
};
/** A source is alive if it heartbeated OR delivered an SMS recently. */
export const sourceLastSeen = (r: Pick<SourceHealthRow, "last_heartbeat_at" | "last_sms_at">): number =>
  Math.max(Number(r.last_heartbeat_at ?? 0), Number(r.last_sms_at ?? 0));

// ---------------------------------------------------------------------------
// Cron sweeps
// ---------------------------------------------------------------------------
/** ADMIN_ALERT_WHATSAPP: E.164 digits (with or without +). null when not configured. */
export function adminAlertNumber(env: Env): string | null {
  const raw = String(env.ADMIN_ALERT_WHATSAPP ?? "").replace(/[^\d]/g, "");
  return raw.length >= 10 ? raw : null;
}

async function alert(env: Env, text: string): Promise<boolean> {
  const to = adminAlertNumber(env);
  if (!to) return false;
  const r = await sendWhatsAppText(env, to, text);
  if (!r.ok) await trackException(env, new Error(`admin_alert_failed:${r.reason}`), { route: "saathum_upi3.alert", handled: true, app_name: APP });
  return r.ok;
}

/** Persist the buyer-facing 3-minute rule so the DB (admin queue, cron) agrees with what reads compute. */
export async function persistAwaitingBank(env: Env, now = Date.now()): Promise<number> {
  const r = await metaDb(env).prepare(
    `UPDATE saathum_checkouts SET status='review_pending', reason_code='awaiting_bank', updated_at=?1
      WHERE status='awaiting_payment' AND paid_claimed_at IS NOT NULL AND paid_claimed_at <= ?2 AND confirmed_at IS NULL`,
  ).bind(now, now - PAID_CLAIM_REVIEW_MS).run();
  return Number((r as any).meta?.changes ?? 0);
}

const paise = (n: number) => `Rs. ${(n / 100).toFixed(2)}`;

/** One WhatsApp per review_pending item older than 10 min (claimed atomically before sending). */
export async function alertStaleReviews(env: Env, now = Date.now()): Promise<number> {
  if (!adminAlertNumber(env)) return 0;
  const db = metaDb(env);
  const rows = await db.prepare(
    `SELECT c.checkout_id, c.amount_paise, c.reason_code, l.title
       FROM saathum_checkouts c LEFT JOIN listings l ON l.id=c.listing_id
      WHERE c.status='review_pending' AND c.review_alerted_at IS NULL AND c.confirmed_at IS NULL
        AND (CASE WHEN c.reason_code='awaiting_bank' AND c.paid_claimed_at IS NOT NULL THEN c.paid_claimed_at + ?2 ELSE c.updated_at END) <= ?1
      ORDER BY c.updated_at ASC LIMIT 10`,
  ).bind(now - REVIEW_ALERT_AFTER_MS, PAID_CLAIM_REVIEW_MS).all<{ checkout_id: string; amount_paise: number; reason_code: string | null; title: string | null }>();
  let sent = 0;
  for (const row of rows.results ?? []) {
    const claim = await db.prepare(`UPDATE saathum_checkouts SET review_alerted_at=?2 WHERE checkout_id=?1 AND review_alerted_at IS NULL`).bind(row.checkout_id, now).run();
    if (Number((claim as any).meta?.changes ?? 0) !== 1) continue;
    const ok = await alert(env,
      `Saathum payment needs manual review\n${row.title ?? "Booking"} - ${paise(row.amount_paise)}\nReason: ${row.reason_code ?? "awaiting_bank"}\nRef: ${row.checkout_id.slice(0, 8)}\nOpen the admin payments review queue.`);
    if (ok) sent++;
    else await db.prepare(`UPDATE saathum_checkouts SET review_alerted_at=NULL WHERE checkout_id=?1`).bind(row.checkout_id).run();
  }
  return sent;
}

/** Stale-source alert (>15 min silent), hourly re-alert, and a "recovered" message. */
export async function checkSourceHealth(env: Env, now = Date.now()): Promise<{ stale: number; recovered: number }> {
  const db = metaDb(env);
  const configured = new Map<string, SmsSource>();
  if (env.HDFC_SMS_DEVICE_ID && env.HDFC_SMS_DEVICE_SECRET) configured.set(env.HDFC_SMS_DEVICE_ID, "companion");
  if (env.HDFC_SMS_WATCHER_DEVICE_ID && env.HDFC_SMS_WATCHER_DEVICE_SECRET) configured.set(env.HDFC_SMS_WATCHER_DEVICE_ID, "watcher");
  // A configured source that has never called in gets a 15-minute grace, then alerts.
  for (const [id, source] of configured) {
    await db.prepare(`INSERT OR IGNORE INTO sms_source_health (device_id,source,last_heartbeat_at,updated_at) VALUES (?1,?2,?3,?3)`).bind(id, source, now).run();
  }
  const rows = await db.prepare(`SELECT device_id,source,last_heartbeat_at,last_sms_at,last_error,alerted_at,stale_alert_open FROM sms_source_health`).all<SourceHealthRow>();
  let stale = 0, recovered = 0;
  for (const r of rows.results ?? []) {
    if (!configured.has(r.device_id)) continue; // retired device: ignore
    const seen = sourceLastSeen(r);
    const silentMs = now - seen;
    const name = r.source === "watcher" ? "Google Messages watcher" : "SMS companion app";
    if (silentMs > SOURCE_STALE_MS) {
      const due = !r.stale_alert_open || now - Number(r.alerted_at ?? 0) >= SOURCE_REALERT_MS;
      if (!due) continue;
      const ok = await alert(env, `Saathum UPI alert: the ${name} has been silent for ${Math.floor(silentMs / 60_000)} min. Payments may need manual review until it is back.`);
      if (ok) {
        await db.prepare(`UPDATE sms_source_health SET alerted_at=?2, stale_alert_open=1 WHERE device_id=?1`).bind(r.device_id, now).run();
        stale++;
      }
    } else if (r.stale_alert_open) {
      const ok = await alert(env, `Saathum UPI: the ${name} is back online.`);
      if (ok) {
        await db.prepare(`UPDATE sms_source_health SET stale_alert_open=0, alerted_at=NULL WHERE device_id=?1`).bind(r.device_id).run();
        recovered++;
      }
    }
  }
  return { stale, recovered };
}

/** Wired into index.ts scheduled(). Never throws. */
export async function runSaathumPaymentSweeps(env: Env, now = Date.now()) {
  const out = { pending: 0, review_alerts: 0, stale: 0, recovered: 0 };
  try { out.pending = await persistAwaitingBank(env, now); } catch (e) { await trackException(env, e, { route: "saathum_upi3.persist", handled: true, app_name: APP }); }
  try { out.review_alerts = await alertStaleReviews(env, now); } catch (e) { await trackException(env, e, { route: "saathum_upi3.review_alerts", handled: true, app_name: APP }); }
  try { const h = await checkSourceHealth(env, now); out.stale = h.stale; out.recovered = h.recovered; } catch (e) { await trackException(env, e, { route: "saathum_upi3.health", handled: true, app_name: APP }); }
  return out;
}
