import type { Env } from "../types";
import { buildReleaseStatements, getReservation, relOpId } from "./hf_token_ledger";
import {
  validateHfBookingSchedule,
  type HfBookingSchedule,
  type HfBusyInterval,
} from "./hf_booking_availability";

type ScheduleRow = {
  host_uid: string;
  timezone: string;
  version: number;
  durations_json: string;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_min: number;
  horizon_days: number;
  rules_json: string;
  exceptions_json: string;
  updated_at: number;
};

export const DEFAULT_HF_BOOKING_TIMEZONE = "Asia/Kolkata";

export function emptyHfBookingSchedule(timezone = DEFAULT_HF_BOOKING_TIMEZONE): HfBookingSchedule {
  return {
    timezone,
    version: 0,
    durationsMinutes: [15, 30, 45, 60],
    slotIntervalMinutes: 15,
    bufferMinutes: 10,
    minNoticeMinutes: 120,
    horizonDays: 60,
    rules: [],
    exceptions: [],
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid persisted HF booking ${label}`);
  }
}

function fromRow(row: ScheduleRow): HfBookingSchedule {
  const schedule: HfBookingSchedule = {
    timezone: row.timezone,
    version: Number(row.version),
    durationsMinutes: parseJson<number[]>(row.durations_json, "durations"),
    slotIntervalMinutes: Number(row.slot_interval_min),
    bufferMinutes: Number(row.buffer_min),
    minNoticeMinutes: Number(row.min_notice_min),
    horizonDays: Number(row.horizon_days),
    rules: parseJson<HfBookingSchedule["rules"]>(row.rules_json, "rules"),
    exceptions: parseJson<HfBookingSchedule["exceptions"]>(row.exceptions_json, "exceptions"),
  };
  const errors = validateHfBookingSchedule(schedule);
  if (errors.length) throw new Error(`Invalid persisted HF booking schedule: ${errors.join("; ")}`);
  return schedule;
}

export async function getHfBookingSchedule(env: Env, hostUid: string): Promise<HfBookingSchedule> {
  const row = await env.DB_META.prepare(
    "SELECT host_uid,timezone,version,durations_json,slot_interval_min,buffer_min,min_notice_min,horizon_days,rules_json,exceptions_json,updated_at FROM hf_availability_schedules WHERE host_uid=?1",
  ).bind(hostUid).first<ScheduleRow>();
  return row ? fromRow(row) : emptyHfBookingSchedule();
}

/** A schedule writer lease serializes the impact check with later booking
 * confirmation. Confirmation must reject an unexpired lease in its own gate. */
export async function acquireHfScheduleWriteLock(
  env: Env,
  hostUid: string,
  expectedVersion: number,
  now = Date.now(),
  leaseMs = 120_000,
): Promise<string | null> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error("invalid schedule write lock request");
  }
  const token = crypto.randomUUID();
  const row = await env.DB_META.prepare(`
    INSERT INTO hf_booking_schedule_locks(host_uid,token,expires_at)
    SELECT ?1,?2,?3
    WHERE COALESCE((SELECT version FROM hf_availability_schedules WHERE host_uid=?1),0)=?4
    ON CONFLICT(host_uid) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
    WHERE hf_booking_schedule_locks.expires_at<=?5
    RETURNING token
  `).bind(hostUid, token, now + leaseMs, expectedVersion, now).first<{ token: string }>();
  return row?.token ?? null;
}

export async function releaseHfScheduleWriteLock(env: Env, hostUid: string, token: string): Promise<void> {
  await env.DB_META.prepare("DELETE FROM hf_booking_schedule_locks WHERE host_uid=?1 AND token=?2")
    .bind(hostUid, token).run();
}

/** Compare-and-save. Must be called while holding the matching write lease. */
export async function saveHfBookingSchedule(
  env: Env,
  hostUid: string,
  expectedVersion: number,
  lockToken: string,
  schedule: HfBookingSchedule,
  now = Date.now(),
): Promise<number | null> {
  const errors = validateHfBookingSchedule({ ...schedule, version: expectedVersion });
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || errors.length) {
    throw new Error(errors.length ? errors.join("; ") : "expectedVersion must be non-negative");
  }
  const row = await env.DB_META.prepare(`
    INSERT INTO hf_availability_schedules
      (host_uid,timezone,version,durations_json,slot_interval_min,buffer_min,min_notice_min,horizon_days,rules_json,exceptions_json,updated_at)
    SELECT ?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10
    WHERE ?11=0 AND EXISTS (
      SELECT 1 FROM hf_booking_schedule_locks WHERE host_uid=?1 AND token=?12 AND expires_at>?10
    )
    ON CONFLICT(host_uid) DO UPDATE SET
      timezone=excluded.timezone,
      version=hf_availability_schedules.version+1,
      durations_json=excluded.durations_json,
      slot_interval_min=excluded.slot_interval_min,
      buffer_min=excluded.buffer_min,
      min_notice_min=excluded.min_notice_min,
      horizon_days=excluded.horizon_days,
      rules_json=excluded.rules_json,
      exceptions_json=excluded.exceptions_json,
      updated_at=excluded.updated_at
    WHERE hf_availability_schedules.version=?11 AND EXISTS (
      SELECT 1 FROM hf_booking_schedule_locks WHERE host_uid=?1 AND token=?12 AND expires_at>?10
    )
    RETURNING version
  `).bind(
    hostUid, schedule.timezone, JSON.stringify(schedule.durationsMinutes), schedule.slotIntervalMinutes,
    schedule.bufferMinutes, schedule.minNoticeMinutes, schedule.horizonDays,
    JSON.stringify(schedule.rules), JSON.stringify(schedule.exceptions), now, expectedVersion, lockToken,
  ).first<{ version: number }>();
  return row ? Number(row.version) : null;
}

export async function listHfBusyIntervals(
  env: Env,
  userId: string,
  fromUtc: number,
  toUtc: number,
): Promise<HfBusyInterval[]> {
  if (!Number.isSafeInteger(fromUtc) || !Number.isSafeInteger(toUtc) || toUtc <= fromUtc) {
    throw new Error("invalid busy interval range");
  }
  const rows = await env.DB_META.prepare(`
    SELECT starts_at,end_at FROM (
      SELECT starts_at,ends_at AS end_at FROM calendar_blocks
      WHERE user_id=?1 AND status IN ('busy','tentative') AND starts_at<?3 AND ends_at>?2
      UNION ALL
      SELECT starts_at,ends_at AS end_at FROM hf_booking_occupancy
      WHERE user_id=?1 AND status='busy' AND starts_at<?3 AND ends_at>?2
    )
  `).bind(userId, fromUtc, toUtc).all<{ starts_at: number; end_at: number }>();
  return (rows.results ?? []).map((row) => ({
    startAt: Number(row.starts_at),
    endAt: Number(row.end_at),
  }));
}

type BookingCleanupRow = { id: string; call_id: string; customer_uid: string; host_uid: string; status: string; settlement_status: string };
type BookingCleanupResult = { processed: number; blocked: number; more: boolean };

async function releaseHeldBooking(
  env: Env,
  row: BookingCleanupRow,
  now: number,
  toStatus: "cancelled" | "failed",
  reason: string,
): Promise<boolean> {
  const reservation = await getReservation(env, row.call_id);
  if (!reservation || reservation.lots.length === 0) return false;
  const nonce = crypto.randomUUID(), gate = relOpId(row.call_id);
  const release = buildReleaseStatements(env, {
    uid: row.customer_uid, callId: row.call_id, lots: reservation.lots, now, nonce,
    gatePredicate: (first) => ({
      sql: "EXISTS (SELECT 1 FROM hf_bookings WHERE id=?" + first + " AND call_id=?" + (first + 1) + " AND status='confirmed' AND settlement_status='held')",
      values: [row.id, row.call_id],
    }),
  });
  await env.DB_META.batch([
    release[0],
    env.DB_META.prepare("UPDATE hf_bookings SET status=?1,settlement_status='released',cancelled_at=?2,updated_at=?2 WHERE id=?3 AND call_id=?4 AND status='confirmed' AND settlement_status='held' AND EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id=?5 AND note=?6)")
      .bind(toStatus, now, row.id, row.call_id, gate, nonce),
    ...release.slice(1, -1),
    env.DB_META.prepare("UPDATE hf_booking_occupancy SET status='cancelled',updated_at=?1 WHERE booking_id=?2 AND EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status=?3)")
      .bind(now, row.id, toStatus),
    env.DB_META.prepare("UPDATE calendar_blocks SET status='cancelled' WHERE source_app='hf_booking' AND source_ref=?1 AND EXISTS (SELECT 1 FROM hf_bookings WHERE id=?1 AND status=?2)")
      .bind(row.id, toStatus),
    env.DB_META.prepare("INSERT OR IGNORE INTO hf_booking_events(id,booking_id,operation_id,actor_uid,from_status,to_status,details_json,created_at) SELECT ?1,?2,?3,NULL,'confirmed',?4,?5,?6 WHERE EXISTS (SELECT 1 FROM hf_bookings WHERE id=?2 AND status=?4)")
      .bind(crypto.randomUUID(), row.id, "system:" + reason + ":" + row.id, toStatus, JSON.stringify({ reason }), now),
    release[release.length - 1],
  ]);
  const saved = await env.DB_META.prepare("SELECT status,settlement_status FROM hf_bookings WHERE id=?1")
    .bind(row.id).first<{ status: string; settlement_status: string }>();
  return saved?.status === toStatus && saved.settlement_status === "released";
}

/** Bounded cleanup for one scheduled-cron invocation. Active calls are deliberately left to their DO finalizer. */
export async function runHfBookingsCron(env: Env, now = Date.now()): Promise<{ expiredQuotes: number; noShows: BookingCleanupResult; recovery: BookingCleanupResult }> {
  const expired = await env.DB_META.prepare(
    "UPDATE hf_booking_quotes SET status='expired' WHERE id IN (SELECT id FROM hf_booking_quotes WHERE status='open' AND expires_at<=?1 ORDER BY expires_at LIMIT 100)",
  ).bind(now).run();
  await env.DB_META.prepare("DELETE FROM hf_booking_schedule_locks WHERE expires_at<=?1").bind(now).run();
  const rows = (await env.DB_META.prepare(
    "SELECT b.id,b.call_id,b.customer_uid,b.host_uid,b.status,b.settlement_status FROM hf_bookings b " +
    "WHERE b.status='confirmed' AND b.settlement_status='held' AND b.ends_at<=?1 " +
    "AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.booking_id=b.id) ORDER BY b.ends_at,b.id LIMIT 101",
  ).bind(now).all<BookingCleanupRow>()).results ?? [];
  const page = rows.slice(0, 100);
  let processed = 0, blocked = 0;
  for (const row of page) {
    if (await releaseHeldBooking(env, row, now, "failed", "no_show")) processed++;
    else blocked++;
  }
  const stuck = (await env.DB_META.prepare(
    "SELECT id,call_id,customer_uid,host_uid,status,settlement_status FROM hf_bookings " +
    "WHERE status IN ('starting','active','settling') AND call_id IS NOT NULL ORDER BY updated_at,id LIMIT 51",
  ).all<BookingCleanupRow>()).results ?? [];
  let recovered = 0, recoveryBlocked = 0;
  for (const row of stuck.slice(0, 50)) {
    const response = await env.HF_CALL.get(env.HF_CALL.idFromName(row.call_id))
      .fetch("https://hfcall/recover", { method: "POST", body: "{}" }).catch(() => null);
    if (response?.ok) recovered++;
    else recoveryBlocked++;
  }
  return {
    expiredQuotes: Number(expired.meta?.changes ?? 0),
    noShows: { processed, blocked, more: rows.length > 100 },
    recovery: { processed: recovered, blocked: recoveryBlocked, more: stuck.length > 50 },
  };
}

/** Called by account exit/suspension flows. Repeated calls drain 100 confirmed reservations at a time. */
export async function releaseHfBookingsForUser(
  env: Env,
  uid: string,
  reason: "account_exit" | "suspension",
  now = Date.now(),
): Promise<BookingCleanupResult> {
  const rows = (await env.DB_META.prepare(
    "SELECT id,call_id,customer_uid,host_uid,status,settlement_status FROM hf_bookings " +
    "WHERE status='confirmed' AND settlement_status='held' AND (customer_uid=?1 OR host_uid=?1) " +
    "AND NOT EXISTS (SELECT 1 FROM hf_calls c WHERE c.booking_id=hf_bookings.id) ORDER BY starts_at,id LIMIT 101",
  ).bind(uid).all<BookingCleanupRow>()).results ?? [];
  let processed = 0, blocked = 0;
  for (const row of rows.slice(0, 100)) {
    if (await releaseHeldBooking(env, row, now, "cancelled", reason)) processed++;
    else blocked++;
  }
  return { processed, blocked, more: rows.length > 100 };
}

/** Drain account holds before closure/suspension. Linked calls remain DO-owned; any held row after bounded batches blocks the caller. */
export async function drainHfBookingHolds(
  env: Env,
  uid: string,
  reason: "account_exit" | "suspension",
  maxBatches = 100,
): Promise<boolean> {
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) return false;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await releaseHfBookingsForUser(env, uid, reason).catch(() => null);
    if (!result || result.blocked > 0) return false;
    if (!result.more) break;
    if (batch === maxBatches - 1) return false;
  }
  const remaining = await env.DB_META.prepare(
    "SELECT COUNT(*) AS n FROM hf_bookings WHERE (customer_uid=?1 OR host_uid=?1) " +
    "AND settlement_status='held' AND status IN ('confirming','confirmed','starting','active','settling')",
  ).bind(uid).first<{ n: number }>().catch(() => null);
  return remaining != null && Number(remaining.n) === 0;
}
