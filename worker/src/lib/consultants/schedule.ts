// [AUMFE-CONSULT-W1-1 2026-10-02] Read-side schedule loading shared by public.ts (slots/next-free) and bookings.ts
// (slot admission). Batched per call: one query each for rules, exceptions and busy for ALL requested consultants.
import type { Env } from "../../types";
import { metaDb } from "../../db/shard";
import { LIVE_STATUS_SQL } from "./booking_logic";
import { istDate, istMidnight, slotsFor, type AvailabilityException, type AvailabilityRule, type Busy } from "./slots";
import type { SlotDay } from "./types";

export interface Schedule { rules: AvailabilityRule[]; exceptions: AvailabilityException[]; busy: Busy[] }
const DAY = 86_400_000;

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/** Busy = live bookings (an unpaid hold past expiry no longer blocks -- cron frees it within 5 min). */
export async function loadSchedules(env: Env, ids: string[], fromMs: number, toMs: number, now = Date.now()): Promise<Map<string, Schedule>> {
  const out = new Map<string, Schedule>();
  for (const id of ids) out.set(id, { rules: [], exceptions: [], busy: [] });
  if (!ids.length) return out;
  const db = metaDb(env);
  const inList = marks(ids.length);
  const [avail, exc, busy] = await Promise.all([
    db.prepare(`SELECT consultant_id, weekday, start_hm, end_hm FROM consultant_availability WHERE consultant_id IN (${inList})`).bind(...ids)
      .all<{ consultant_id: string; weekday: number; start_hm: string; end_hm: string }>(),
    db.prepare(`SELECT consultant_id, date, off, start_hm, end_hm FROM consultant_exceptions WHERE consultant_id IN (${inList})`).bind(...ids)
      .all<{ consultant_id: string; date: string; off: number; start_hm: string | null; end_hm: string | null }>(),
    db.prepare(
      `SELECT consultant_id, slot_start_ms, slot_end_ms FROM consult_bookings
        WHERE consultant_id IN (${inList}) AND slot_start_ms>=?${ids.length + 1} AND slot_start_ms<?${ids.length + 2}
          AND status IN (${LIVE_STATUS_SQL})
          AND NOT (status='held' AND paid_claimed_at IS NULL AND expires_at<=?${ids.length + 3})`,
    ).bind(...ids, fromMs - DAY, toMs + DAY, now).all<{ consultant_id: string; slot_start_ms: number; slot_end_ms: number }>(),
  ]);
  for (const r of avail.results ?? []) out.get(r.consultant_id)?.rules.push({ weekday: r.weekday, start: r.start_hm, end: r.end_hm });
  for (const r of exc.results ?? []) out.get(r.consultant_id)?.exceptions.push({ date: r.date, off: Number(r.off) === 1, start: r.start_hm, end: r.end_hm });
  for (const r of busy.results ?? []) out.get(r.consultant_id)?.busy.push({ start_ms: r.slot_start_ms, end_ms: r.slot_end_ms });
  return out;
}

/** Slot days for [fromDate, fromDate + days) in IST. Days with no slots are kept (empty) so the calendar can grey them. */
export function slotDays(s: Schedule, fromDate: string, days: number, slotMinutes: number, bufferMinutes: number, now: number): SlotDay[] {
  const out: SlotDay[] = [];
  const base = istMidnight(fromDate);
  for (let i = 0; i < days; i++) {
    const date = istDate(base + i * DAY + 12 * 3600e3);
    out.push({ date, slots: slotsFor(date, s.rules, s.exceptions, s.busy, slotMinutes, bufferMinutes, now) });
  }
  return out;
}

/** First free slot start within the next `days` days, or null. */
export function nextFreeMs(s: Schedule, slotMinutes: number, bufferMinutes: number, now: number, days = 14): number | null {
  for (const d of slotDays(s, istDate(now), days + 1, slotMinutes, bufferMinutes, now)) {
    if (d.slots.length && d.slots[0].start_ms <= now + days * DAY) return d.slots[0].start_ms;
  }
  return null;
}
