/* [CAL-AUDIT-2026-09-15] Pure scheduling logic for the creator calendar.
 *
 * WHY THIS FILE EXISTS: the fixes this audit asks for — a full-day interval that
 * round-trips as 1440 (never "00:00"), a day editor that can hold SEVERAL
 * independent exceptions, a bounded holiday range, one card per booking,
 * Google readiness derived from the OLDEST selected calendar, and an accurate
 * policy summary — are all decisions about data, not about React. They live
 * here, with no imports at runtime (type-only imports are erased), so
 * web/test/calendar_core.test.ts can exercise them under node:test without a
 * DOM or a bundler.
 *
 * Read this together with the server contract:
 *   worker/src/routes/calendar_availability.ts — exception/interval validation,
 *     the date+start+end duplicate key, reservations for `reserved` and for
 *     creator-wide `unavailable` (a listing's own `unavailable` just closes it).
 *   worker/src/cal/gcal_availability.ts — readiness is the OLDEST successful
 *     sync among SELECTED calendars, 30 minutes max age, any selected error
 *     or never-synced calendar is not ready.
 *   worker/src/cal/engine.ts — effective notice is
 *     max(calendar min_notice_min, listing attrs.commercial_booking_notice_hours
 *     or 24h), and the buffer expands the requested window on BOTH sides.
 */
import type {
  AvailabilityException, AvailabilityRule, CalendarBlock, CalendarEvent, CreatorSchedule,
  ConflictAlternative, ConflictItem, ExceptionStatus, GoogleCalendar, GoogleCalendarStatus,
} from './availability';

/** Minute 1440 is the END of the day. It is NOT midnight and must never be
 *  read back as minute 0 — that is the full-day round-trip bug this audit
 *  found on web (app writes 0..1440, web turned it into "00:00"→0 and refused
 *  to save). */
export const ALL_DAY_START_MIN = 0;
export const ALL_DAY_END_MIN = 1440;
/** The schedule PUT validates exceptions against these same bounds. */
export const MAX_EXCEPTIONS = 100;
export const MAX_HORIZON_DAYS = 62;
export const DAY_MINUTES = 24 * 60;
/** gcalAvailabilityReady() refuses a booking once the OLDEST selected calendar
 *  is older than this; a status older than 30 minutes is never "Ready". */
export const GOOGLE_SYNC_STALE_MS = 30 * 60_000;

// ── time ───────────────────────────────────────────────────────────────────
export function isAllDayInterval(startMin: number, endMin: number): boolean {
  return startMin <= ALL_DAY_START_MIN && endMin >= ALL_DAY_END_MIN;
}

/** 1440 → "24:00", both round-trip safe through clockToMinutes. */
export function minutesToClock(value: number): string {
  const total = Math.max(0, Math.min(ALL_DAY_END_MIN, Math.round(Number.isFinite(value) ? value : 0)));
  if (total === ALL_DAY_END_MIN) return '24:00';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** "24:00" and "00:00" are both accepted; anything else invalid is null so the
 *  caller can show a message instead of writing a wrong interval.
 *
 *  [CAL-AUDIT-2026-09-15 · #2] Exactly two digits are required for the hour.
 *  A browser `<input type="time">` only ever produces "HH:MM" (or "" when the
 *  value is not a legal time), so a one-digit hour means the caller built the
 *  string by hand — and ACCEPTING it would quietly write a window the creator
 *  never saw in the field. Refusing it makes the caller explain instead. */
export function clockToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total <= ALL_DAY_END_MIN ? total : null;
}

export function intervalLabel(startMin: number, endMin: number): string {
  return isAllDayInterval(startMin, endMin) ? 'All day' : `${minutesToClock(startMin)}–${minutesToClock(endMin)}`;
}

/* ── editor clock fields (#2) ───────────────────────────────────────────────
 * AN <input type="time"> CANNOT HOLD "24:00". A partial interval that ends at
 * minute 1440 (18:00..24:00) is a legal saved window — the server validates
 * `end <= 1440` — but feeding `minutesToClock(1440) === "24:00"` into the
 * browser input leaves it BLANK, so re-saving the window silently rewrote the
 * end to something else. Minute 1440 is therefore carried by an explicit
 * `endOfDay` flag, and the input only ever receives a value it accepts. */
/** 23:59 — the last minute an `<input type="time">` accepts. It is only ever a
 *  placeholder for the field; `endOfDay` is what decides the saved minute. */
export const LAST_CLOCK_MIN = ALL_DAY_END_MIN - 1;

export interface ClockIntervalFields {
  /** Always a valid `<input type="time">` value ("HH:MM"), never "24:00". */
  start: string;
  end: string;
  /** start 00:00 and end 24:00 — the whole day. */
  allDay: boolean;
  /** A partial window whose end is minute 1440 (e.g. 18:00..24:00). */
  endOfDay: boolean;
}

/** True for a PARTIAL window that runs to the end of the day. All-day is a
 *  different control (`isAllDayInterval`) and must not be reported here. */
export function isEndOfDayInterval(startMin: number, endMin: number): boolean {
  return !isAllDayInterval(startMin, endMin) && endMin >= ALL_DAY_END_MIN;
}

function clampClockMinute(value: number, fallback = 0): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(LAST_CLOCK_MIN, n));
}

/** Saved interval → the editor's fields, WITHOUT loss: an 18:00..24:00 window
 *  comes back as start 18:00, end 23:59 and endOfDay true, which
 *  `clockFieldsToInterval` turns back into 18:00..1440. */
export function intervalToClockFields(startMin: number, endMin: number): ClockIntervalFields {
  const allDay = isAllDayInterval(startMin, endMin);
  const endOfDay = isEndOfDayInterval(startMin, endMin);
  const start = clampClockMinute(startMin);
  const end = endOfDay ? LAST_CLOCK_MIN : Math.max(start, clampClockMinute(endMin, start));
  return { start: minutesToClock(start), end: minutesToClock(end), allDay, endOfDay };
}

/** Editor fields → a savable interval, or null when the input is impossible.
 *  Never returns end 1440 for a partial window unless endOfDay was chosen. */
export function clockFieldsToInterval(fields: ClockIntervalFields): { start_min: number; end_min: number } | null {
  if (fields.allDay) return { start_min: ALL_DAY_START_MIN, end_min: ALL_DAY_END_MIN };
  const start = clockToMinutes(fields.start);
  if (start === null || start >= ALL_DAY_END_MIN) return null;
  if (fields.endOfDay) return { start_min: start, end_min: ALL_DAY_END_MIN };
  const end = clockToMinutes(fields.end);
  if (end === null || end <= start) return null;
  return { start_min: start, end_min: end };
}

/** "12 hours", "90 minutes", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours === 1) parts.push('1 hour');
  else if (hours > 1) parts.push(`${hours} hours`);
  if (rest === 1) parts.push('1 minute');
  else if (rest > 1) parts.push(`${rest} minutes`);
  return parts.length ? parts.join(' ') : '0 minutes';
}

// ── date keys (deliberately duplicated from lib/availability so this module ──
//    keeps ZERO runtime imports and can be unit-tested in plain node) ─────────
export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(key: string, amount: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const next = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
}

export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key ?? ''))) return false;
  const [year, month, day] = key.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * [CAL-AUDIT-2026-09-15 · #1/#4] The civil date of an instant in a NAMED zone.
 *
 * "Today" is the schedule's civil date, not the device's. A creator in
 * Asia/Kolkata planning a calendar that runs on America/Los_Angeles is already
 * on the next date for part of every day, so opening the day editor on the
 * device's date shows the wrong day — and a "block today" click would land on
 * yesterday's window. The schedule already states its zone and the booking
 * engine works in it, so the editor opens on the same date the server would.
 *
 * Returns null for a missing or unknown zone so the caller falls back to
 * something it can explain rather than guessing a date.
 */
export function civilDateKey(epochMs: number, timezone: string | null | undefined): string | null {
  if (!timezone || typeof timezone !== 'string') return null;
  const instant = Number(epochMs);
  if (!Number.isFinite(instant)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instant));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    const key = `${part('year')}-${part('month')}-${part('day')}`;
    return isValidDateKey(key) ? key : null;
  } catch {
    // An unknown IANA zone throws a RangeError; a caller must not get a date it
    // cannot trust out of that.
    return null;
  }
}

// ── exceptions: several per day, edited individually ───────────────────────
export function intervalsForDate(schedule: CreatorSchedule | null | undefined, date: string): AvailabilityException[] {
  const rows = (schedule?.exceptions ?? []).filter((item) => item.date === date);
  return [...rows].sort((a, b) => a.start_min - b.start_min || a.end_min - b.end_min);
}

export function scopeLabel(exception: AvailabilityException, listings: { id: string; title: string }[]): string {
  if (!exception.listing_id) return 'All listings';
  return listings.find((listing) => listing.id === exception.listing_id)?.title ?? 'One listing';
}

/** Exceptions that a save must not touch. Used to keep the 100-exception
 *  budget honest and to prove unrelated intervals are never dropped. */
export function exceptionsOutsideDates(schedule: CreatorSchedule, dates: string[]): AvailabilityException[] {
  const inRange = new Set(dates);
  return schedule.exceptions.filter((item) => !inRange.has(item.date));
}

export function exceptionBudget(schedule: CreatorSchedule, datesToReplace: string[] = []): number {
  return Math.max(0, MAX_EXCEPTIONS - exceptionsOutsideDates(schedule, datesToReplace).length);
}

export interface IntervalTarget {
  /** Set when editing an existing interval; omit to add a new one. */
  id?: string;
  date: string;
  start_min: number;
  end_min: number;
  status: ExceptionStatus;
  listing_id?: string;
}

export interface IntervalPlan {
  /** The full exception list to PUT — unrelated exceptions are preserved. */
  next: AvailabilityException[];
  /** Intervals removed because the new one fully covers them. */
  removed: AvailabilityException[];
  /** Existing interval with the same date+start+end that this replaces. */
  replaced: AvailabilityException | null;
  /** Human-readable reasons the save must NOT proceed. */
  conflicts: string[];
  /** Whether the plan deletes anything at all. */
  changed: boolean;
}

/**
 * Plan one add/edit without ever dropping an unrelated interval.
 *
 * The server rejects a duplicate `date:start:end` key and refuses reservations
 * that overlap each other, so this mirrors that shape client-side:
 *   • same date+start+end        → replace (any status; the key is what collides)
 *   • reserved interval covered  → REFUSE (a reserved window can hold a
 *                                  confirmed commitment; never silently drop it)
 *   • hard interval covered      → remove (redundant: the new window covers it)
 *   • hard/hard partial overlap  → REFUSE with the time to edit instead
 * "Hard" is status `reserved`, plus `unavailable` when the target schedule is
 * the CREATOR-WIDE one — only those create reservations server-side.
 */
export function planIntervalUpsert(
  schedule: CreatorSchedule,
  target: IntervalTarget,
  opts: { newId: string; creatorWide: boolean },
): IntervalPlan {
  // [CAL-AUDIT-2026-09-15] Takes the STATUS, not a whole exception: the caller
  // asks the same question about a saved `AvailabilityException` and about the
  // `IntervalTarget` being written (whose `id` is optional), and the two must
  // never be forced into each other's shape just to share this predicate.
  const isHard = (status: ExceptionStatus) =>
    status === 'reserved' || (opts.creatorWide && status === 'unavailable');
  const others = schedule.exceptions.filter((item) => item.id !== target.id);
  const kept: AvailabilityException[] = [];
  const removed: AvailabilityException[] = [];
  const conflicts: string[] = [];
  let replaced: AvailabilityException | null = null;

  for (const existing of others) {
    if (existing.date !== target.date) { kept.push(existing); continue; }
    const identical = existing.start_min === target.start_min && existing.end_min === target.end_min;
    if (identical) { replaced = existing; continue; }
    const overlaps = existing.start_min < target.end_min && existing.end_min > target.start_min;
    if (!overlaps) { kept.push(existing); continue; }
    const covered = existing.start_min >= target.start_min && existing.end_min <= target.end_min;
    if (existing.status === 'reserved') {
      // Never drop a window that can hold a confirmed commitment. A refused
      // plan also KEEPS every interval it refused to change, so a caller that
      // ignored `conflicts` still could not delete creator data.
      conflicts.push(`There is already a reserved window ${intervalLabel(existing.start_min, existing.end_min)} on this date that overlaps. Remove or edit that window first.`);
      kept.push(existing);
      continue;
    }
    if (covered && isHard(target.status)) { removed.push(existing); continue; }
    if (isHard(existing.status) && isHard(target.status)) {
      conflicts.push(`This overlaps an existing blocked window ${intervalLabel(existing.start_min, existing.end_min)} on this date. Edit that window instead of adding a second one.`);
      kept.push(existing);
      continue;
    }
    kept.push(existing);
  }

  const next = [...kept, {
    id: target.id ?? opts.newId,
    date: target.date,
    start_min: target.start_min,
    end_min: target.end_min,
    status: target.status,
    ...(target.listing_id ? { listing_id: target.listing_id } : {}),
  }].sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min || a.end_min - b.end_min);

  return { next, removed, replaced, conflicts, changed: conflicts.length === 0 };
}

/** Remove one interval by id; every other interval survives. */
export function removeInterval(schedule: CreatorSchedule, id: string): AvailabilityException[] {
  return schedule.exceptions.filter((item) => item.id !== id);
}

export interface MultiDateIntervalPlan {
  /** The full exception list to PUT — unrelated exceptions are preserved. */
  next: AvailabilityException[];
  /** Human-readable reasons the save must NOT proceed. */
  conflicts: string[];
  /** Existing windows the save would delete because the new one fully covers them. */
  removed: AvailabilityException[];
  /** Existing windows whose date+start+end key the save re-writes. */
  replaced: AvailabilityException[];
  /** Whether this save touches a window that already existed. */
  changesExisting: boolean;
}

/**
 * [CAL-AUDIT-2026-09-15 · #5] Plan an add/edit over one OR SEVERAL dates.
 *
 * The date-range ("block several days") save used to run this loop inline in
 * the panel, so the "N covered windows were replaced" line only appeared AFTER
 * the write. Doing it here means the same computation drives the confirmation
 * the creator sees BEFORE anything is saved, and a unit test can prove that
 * unrelated windows and days survive.
 *
 * `newId` is injected (the panel passes `crypto.randomUUID`) so this stays a
 * pure function with no runtime imports.
 */
export function planIntervalUpserts(
  schedule: CreatorSchedule,
  template: IntervalTarget,
  dates: string[],
  opts: { newId: () => string; creatorWide: boolean; labelForDate?: (date: string) => string },
): MultiDateIntervalPlan {
  let exceptions = schedule.exceptions;
  const conflicts: string[] = [];
  const removed: AvailabilityException[] = [];
  const replaced: AvailabilityException[] = [];
  for (const date of dates) {
    const plan = planIntervalUpsert(
      { ...schedule, exceptions },
      { ...template, date, id: dates.length === 1 ? template.id : undefined },
      { newId: opts.newId(), creatorWide: opts.creatorWide },
    );
    if (plan.conflicts.length) {
      const prefix = dates.length > 1 && opts.labelForDate ? `${opts.labelForDate(date)}: ` : '';
      conflicts.push(`${prefix}${plan.conflicts[0]}`);
      continue;
    }
    exceptions = plan.next;
    if (plan.replaced) replaced.push(plan.replaced);
    removed.push(...plan.removed);
  }
  if (conflicts.length) {
    return { next: schedule.exceptions, conflicts, removed: [], replaced: [], changesExisting: false };
  }
  return { next: exceptions, conflicts, removed, replaced, changesExisting: removed.length > 0 || replaced.length > 0 };
}

/**
 * [CAL-AUDIT-2026-09-15 · #3] Should the cosmetic server conflict preview run?
 *
 * POST /api/calendar/conflicts/preview takes no "ignore this window" argument,
 * so it reports the creator's own saved window as a conflict when that window
 * is the one being changed — and it would refuse an edit of a block because the
 * block overlaps itself. It is therefore only a COSMETIC pre-check for a save
 * that cannot touch an existing window. An edit, a range, or a save that
 * replaces/covers a window relies on the PUT, which is atomic and already
 * excludes this schedule's own prior reservation mirrors
 * (worker/src/routes/calendar_availability.ts: `r.source_ref LIKE
 * 'schedule:<id>:%'`). Actual commitment checks are NOT weakened: the PUT still
 * refuses a confirmed booking or another schedule's reservation.
 */
export function shouldRunConflictPreview(input: {
  mode: 'add' | 'edit';
  dates: number;
  conflicts: string[];
  removed: AvailabilityException[];
  replaced: AvailabilityException[];
}): boolean {
  if (input.mode !== 'add') return false;
  if (input.conflicts.length > 0) return false;
  if (input.dates !== 1) return false;
  if (input.removed.length > 0 || input.replaced.length > 0) return false;
  return true;
}

/**
 * [CAL-AUDIT-2026-09-15 · #5] Identity of one save PLAN, so a confirmation can
 * only ever be reused for the plan it described.
 *
 * The confirm button and the plan are computed in different renders. Without an
 * identity, changing the window after "Confirm: replace 2 windows" appeared —
 * a different end time, another suggested slot, another scope — left the OLD
 * confirmation armed, and the next click wrote a replace-set the creator never
 * saw. Two different plans therefore produce different signatures, and only an
 * identical signature may skip the confirmation and write.
 */
export function planSignature(input: {
  mode: 'add' | 'edit';
  dates: string[];
  startMin: number;
  endMin: number;
  status: string;
  listingId?: string | null;
  /** ids of the existing windows this plan would remove or re-write. */
  affectedIds: string[];
}): string {
  return [
    input.mode,
    input.dates.join(','),
    `${input.startMin}-${input.endMin}`,
    input.status,
    input.listingId ?? '',
    input.affectedIds.join(','),
  ].join('|');
}

export interface RangeOptions {
  from: string;
  to: string;
  /** The schedule's own policy horizon. Preserved, clamped to the server's 62. */
  horizonDays: number;
  /** Exceptions the save will keep (see exceptionsOutsideDates). */
  existingCount: number;
  maxDays?: number;
  maxExceptions?: number;
}

export interface RangePlan {
  dates: string[];
  days: number;
  truncated: 'none' | 'invalid' | 'reversed' | 'horizon' | 'length' | 'budget';
  /** Plain-English explanations for the creator; empty when nothing was cut. */
  messages: string[];
}

/**
 * Bound a holiday/vacation range the way BOTH the server and the product
 * promise require: never past the policy horizon (max 62 days), never past the
 * 100-exception limit, and never shortened silently — every cut is reported.
 */
export function planDateRange(options: RangeOptions): RangePlan {
  const { from, to } = options;
  const maxDays = Math.max(1, Math.min(options.maxDays ?? MAX_HORIZON_DAYS, MAX_HORIZON_DAYS));
  const maxExceptions = Math.max(0, Math.min(options.maxExceptions ?? MAX_EXCEPTIONS, MAX_EXCEPTIONS));
  const horizon = clampHorizonDays(options.horizonDays);
  if (!isValidDateKey(from) || !isValidDateKey(to)) {
    return { dates: [], days: 0, truncated: 'invalid', messages: ['Choose a valid start and end date.'] };
  }
  const span = daysBetween(from, to);
  if (span < 0) return { dates: [], days: 0, truncated: 'reversed', messages: ['The end date is before the start date.'] };

  const budget = Math.max(0, maxExceptions - Math.max(0, options.existingCount));
  const limit = Math.min(span + 1, maxDays, horizon, budget);
  const dates: string[] = [];
  for (let index = 0; index < limit; index += 1) dates.push(addDays(from, index));

  const messages: string[] = [];
  let truncated: RangePlan['truncated'] = 'none';
  if (span + 1 > limit) {
    if (budget === 0) {
      truncated = 'budget';
      messages.push(`This schedule already holds the maximum of ${maxExceptions} date exceptions. Remove one before adding a range.`);
    } else if (budget <= span && budget < maxDays && budget < horizon) {
      truncated = 'budget';
      messages.push(`Only the first ${dates.length} day${dates.length === 1 ? '' : 's'} can be added: one schedule holds at most ${maxExceptions} date exceptions.`);
    } else if (horizon <= span && horizon < maxDays) {
      truncated = 'horizon';
      messages.push(`Only the first ${dates.length} day${dates.length === 1 ? '' : 's'} are inside your ${horizon}-day booking horizon. Change the horizon in Working hours to go further.`);
    } else {
      truncated = 'length';
      messages.push(`Only the first ${dates.length} day${dates.length === 1 ? '' : 's'} are included; a range can cover at most ${maxDays} days.`);
    }
  }
  return { dates, days: dates.length, truncated, messages };
}

/** Same 1..62 clamp the worker enforces on PUT /api/calendar/schedule. The
 *  wizard used to force 62 and silently overwrite a creator's own horizon. */
export function clampHorizonDays(value: number | null | undefined, fallback = 60): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_HORIZON_DAYS, Math.max(1, n));
}

/** Weekly repetition dates for one interval, bounded by the horizon and the
 *  remaining exception budget (the first date is the interval itself). */
export function weeklyRepeatDates(date: string, horizonDays: number, availableSlots: number): string[] {
  const horizon = clampHorizonDays(horizonDays);
  const maxByHorizon = Math.floor((horizon - 1) / 7) + 1;
  const weeks = Math.max(1, Math.min(maxByHorizon, Math.max(1, availableSlots)));
  const dates: string[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const next = addDays(date, index * 7);
    if (daysBetween(date, next) >= horizon) break;
    dates.push(next);
  }
  return dates.length ? dates : [date];
}

// ── Google readiness (selected calendars only, never overstated) ───────────
export type GoogleReadinessState = 'unknown' | 'not_connected' | 'syncing' | 'ready' | 'attention';

export interface GoogleSource {
  id: string;
  summary: string;
  selected: boolean;
  timezone: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  state: GoogleReadinessState;
  detail: string;
}

export interface GoogleReadiness {
  state: GoogleReadinessState;
  label: string;
  detail: string;
  /** Server reason when present: pending | stale | error | disconnected | no_selected_calendars */
  reason: string | null;
  /** True only when the verdict came from server data rather than a guess. */
  verified: boolean;
  /** OLDEST successful sync among selected calendars — never the newest. */
  lastSuccessAt: number | null;
  selectedCount: number;
  sources: GoogleSource[];
}

/** The reason a locally-derived verdict must report when the server did not
 *  supply one: an explicit error beats a pending first sync, which beats stale. */
function localReason(sources: GoogleSource[]): 'error' | 'pending' | 'stale' | null {
  const selected = sources.filter((source) => source.selected);
  if (selected.some((source) => source.lastError)) return 'error';
  if (selected.some((source) => !source.lastSuccessAt)) return 'pending';
  if (selected.some((source) => source.state === 'attention')) return 'stale';
  return null;
}

function sourceState(calendar: GoogleCalendar, now: number, maxAgeMs: number): GoogleReadinessState {
  if (!calendar.selected) return 'unknown';
  if (calendar.last_error) return 'attention';
  if (!calendar.last_success_at) return 'syncing';
  return now - calendar.last_success_at > maxAgeMs ? 'attention' : 'ready';
}

/**
 * ONE readiness verdict for the whole account, derived the same way the booking
 * engine derives it: the oldest selected success decides, any selected error or
 * never-synced calendar blocks, and "Connected" alone is never "Ready".
 * An older deployed backend without `ready`/`reason`/`last_success_at` yields
 * `unknown` ("not verified") rather than a false healthy badge.
 */
export function deriveGoogleReadiness(
  status: GoogleCalendarStatus | null,
  now: number,
  maxAgeMs: number = GOOGLE_SYNC_STALE_MS,
): GoogleReadiness {
  if (!status) {
    return { state: 'unknown', label: 'Checking…', detail: 'Checking your Google connection.', reason: null, verified: false, lastSuccessAt: null, selectedCount: 0, sources: [] };
  }
  const calendars = status.calendars ?? [];
  const sources: GoogleSource[] = calendars.map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary || 'Google Calendar',
    selected: !!calendar.selected,
    timezone: calendar.timezone ?? null,
    lastSuccessAt: calendar.last_success_at ?? null,
    lastError: calendar.last_error ?? null,
    state: sourceState(calendar, now, maxAgeMs),
    detail: calendar.last_error
      ? calendar.last_error
      : calendar.selected
        ? (calendar.last_success_at ? `Last busy-time sync ${minutesAgo(now - calendar.last_success_at)}` : 'Waiting for the first sync')
        : 'Not used for busy time',
  }));
  const selected = sources.filter((source) => source.selected);
  const selectedSuccesses = selected.map((source) => source.lastSuccessAt).filter((value): value is number => typeof value === 'number' && value > 0);
  const oldest = selectedSuccesses.length ? Math.min(...selectedSuccesses) : null;
  const serverLastSuccess = typeof status.last_success_at === 'number' && status.last_success_at > 0 ? status.last_success_at : null;
  const lastSuccessAt = oldest ?? serverLastSuccess;
  const accountError = status.last_error ?? status.error ?? null;

  const base = { verified: true, lastSuccessAt, selectedCount: selected.length, sources } as const;
  if (!status.connected) {
    return { ...base, state: 'not_connected', label: 'Not connected', detail: 'No Google Calendar is connected. Busy time from Google is not included.', reason: 'disconnected' };
  }
  // Server verdict wins when it exists — it is computed from the same rows the
  // booking engine reads. A local contradiction (a selected calendar that is
  // failing) still downgrades, so a stale `ready: true` cannot hide a problem.
  const localProblem = selected.some((source) => source.state === 'attention');
  const localPending = selected.some((source) => source.state === 'syncing');
  if (status.ready === true && !localProblem && !localPending) {
    return { ...base, state: 'ready', label: 'Ready', detail: 'Busy time from every selected calendar is up to date.', reason: null };
  }
  if (status.ready === true && localPending) {
    return { ...base, state: 'syncing', label: 'Syncing', detail: 'A selected calendar has not finished its first sync yet.', reason: 'pending' };
  }
  if (status.ready === false || localProblem || localPending) {
    const reason = status.reason ?? localReason(sources);
    if (reason === 'disconnected') return { ...base, state: 'not_connected', label: 'Not connected', detail: 'No Google Calendar is connected.', reason };
    if (reason === 'pending') return { ...base, state: 'syncing', label: 'Syncing', detail: 'A selected calendar has not finished its first sync yet. New bookings are refused until it does.', reason };
    if (reason === 'stale') {
      return { ...base, state: 'attention', label: 'Needs attention', detail: `The last successful sync was ${minutesAgo(now - (lastSuccessAt ?? now))} ago. New Google events may not block bookings yet.`, reason };
    }
    if (reason === 'no_selected_calendars') {
      return { ...base, state: 'attention', label: 'Needs attention', detail: 'No calendar is selected, so bookings are refused until at least one source is chosen.', reason };
    }
    const failing = selected.find((source) => source.lastError);
    return { ...base, state: 'attention', label: 'Needs attention', detail: accountError ?? failing?.lastError ?? 'At least one selected calendar could not be read.', reason: reason ?? 'error' };
  }
  // Older backend: no `ready` flag. Derive from rows we can see, and never claim
  // healthy when there is nothing to verify.
  if (!calendars.length) {
    return { ...base, verified: false, state: 'unknown', label: 'Connected — not verified', detail: 'This server version does not report per-calendar sync state. Reconnect or check again before relying on Google busy time.', reason: null };
  }
  if (!selected.length) {
    return { ...base, state: 'attention', label: 'Needs attention', detail: 'No calendar is selected, so bookings are refused until at least one source is chosen.', reason: 'no_selected_calendars' };
  }
  if (localProblem) {
    return { ...base, state: 'attention', label: 'Needs attention', detail: accountError ?? selected.find((source) => source.lastError)?.lastError ?? 'At least one selected calendar could not be read.', reason: localReason(sources) ?? 'error' };
  }
  if (localPending) return { ...base, state: 'syncing', label: 'Syncing', detail: 'A selected calendar has not finished its first sync yet. New bookings are refused until it does.', reason: 'pending' };
  if (oldest !== null && now - oldest > maxAgeMs) {
    return { ...base, state: 'attention', label: 'Needs attention', detail: `The oldest selected calendar last synced ${minutesAgo(now - oldest)} ago.`, reason: 'stale' };
  }
  if (oldest !== null) return { ...base, state: 'ready', label: 'Ready', detail: 'Busy time from every selected calendar is up to date.', reason: null };
  return { ...base, verified: false, state: 'unknown', label: 'Connected — not verified', detail: 'Sync state could not be verified from this server response.', reason: null };
}

export function minutesAgo(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 1) return 'just now';
  if (total < 60) return `${total} min`;
  const hours = Math.round(total / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// ── one card per booking ───────────────────────────────────────────────────
/** [CAL-AUDIT-2026-09-15 · #6] The backend states the booking role explicitly
 *  (`creator` | `customer` | null). It is NEVER inferred from a title or from
 *  an overlapping interval. */
export type BookingRole = 'creator' | 'customer' | null;

/** Read the role the server supplied. `booking_role` wins; the older `role`
 *  column is normalised (host→creator, attendee→customer) instead of guessed. */
export function bookingRoleOf(event: { booking_role?: string | null; role?: string | null }): BookingRole {
  const stated = String(event.booking_role ?? '').trim().toLowerCase();
  const legacy = String(event.role ?? '').trim().toLowerCase();
  const value = stated || legacy;
  if (value === 'creator' || value === 'host') return 'creator';
  if (value === 'customer' || value === 'attendee' || value === 'buyer') return 'customer';
  return null;
}

/** Plain-English label for a stated role; null when the server did not say. */
export function bookingRoleLabel(role: BookingRole): string | null {
  if (role === 'creator') return 'you host';
  if (role === 'customer') return 'you booked';
  return null;
}

export interface DayItem {
  key: string;
  kind: 'booking' | 'busy';
  title: string;
  start: number;
  end: number;
  status: string;
  tone: string;
  listingId: string | null;
  bookingId: string | null;
  /** Stated by the server (`booking_role`), never derived from title/interval. */
  bookingRole: BookingRole;
  /** Busy blocks folded into this card instead of being shown again. */
  internalBlockIds: string[];
}

function overlaps(start: number, end: number, from: number, to: number): boolean {
  return start < to && end > from;
}

/**
 * One appointment card per booking.
 *
 * A confirmed consultation writes BOTH a calendar event and a busy
 * reservation/block; the old day view concatenated them, so one booking showed
 * up as "Blocked time" AND "Booked" and inflated the busy count. With the new
 * `/api/calendar/blocks` fields (`booking_id`) the match is exact, and ONLY a
 * canonical id may fold a block into a booking card.
 *
 * [CAL-AUDIT-2026-09-15 · #6] Two things are deliberately NOT used as identity:
 *   • `slot_id` — a group slot can hold several bookings, so collapsing on it
 *     would hide an unrelated session;
 *   • an identical interval — two different commitments can share a timespan,
 *     and folding/merging on that would attribute one booking's busy block to
 *     the other. Without the canonical id the block stays visible as its own
 *     card: an honest duplicate is better than a wrong link.
 * Google blocks are never folded: they are external busy time, not bookings.
 */
export function dayItemsForRange(blocks: CalendarBlock[], events: CalendarEvent[], from: number, to: number): DayItem[] {
  const bookings: DayItem[] = [];
  const seenBookings = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!overlaps(event.start_at, event.end_at, from, to)) continue;
    const bookingId = event.booking_id ?? null;
    if (bookingId) {
      if (seenBookings.has(bookingId)) continue;
      seenBookings.add(bookingId);
    }
    bookings.push({
      key: bookingId ? `booking:${bookingId}` : `booking:event:${index}:${event.start_at}`,
      kind: 'booking',
      title: event.title || 'Booked session',
      start: event.start_at,
      end: event.end_at,
      status: 'Booked',
      tone: 'calendar-event-booked',
      listingId: event.listing_id ?? null,
      bookingId,
      bookingRole: bookingRoleOf(event),
      internalBlockIds: [],
    });
  }
  const bookingIds = new Set(bookings.map((item) => item.bookingId).filter((value): value is string => !!value));
  const items: DayItem[] = [...bookings];
  for (const block of blocks) {
    if (!overlaps(block.starts_at, block.ends_at, from, to)) continue;
    const source = String(block.source_app ?? '').toLowerCase();
    const external = source === 'gcal';
    const ownedByBooking = !external && !!block.booking_id && bookingIds.has(block.booking_id);
    if (ownedByBooking) {
      const owner = items.find((item) => item.bookingId && block.booking_id === item.bookingId);
      if (owner) owner.internalBlockIds.push(block.id);
      continue;
    }
    items.push({
      key: `busy:${block.id}`,
      kind: 'busy',
      title: external ? 'Google Calendar' : (block.title || 'Blocked time'),
      start: block.starts_at,
      end: block.ends_at,
      status: external ? 'Busy (Google)' : 'Unavailable',
      tone: external ? 'calendar-event-google' : 'calendar-event-block',
      listingId: block.listing_id ?? null,
      bookingId: block.booking_id ?? null,
      bookingRole: bookingRoleOf(block),
      internalBlockIds: [],
    });
  }
  return items.sort((a, b) => a.start - b.start);
}

// ── policy, in plain English ───────────────────────────────────────────────
/** Listing attrs fall back to 24 hours when a listing sets no booking notice
 *  (worker/src/cal/engine.ts: `attrs.commercial_booking_notice_hours ?? 24`). */
export const LISTING_NOTICE_FALLBACK_HOURS = 24;

export function effectiveNoticeMinutes(calendarNoticeMin: number, listingNoticeHours?: number | null): { minutes: number; from: 'calendar' | 'listing'; listingHours: number } {
  const hours = typeof listingNoticeHours === 'number' && Number.isFinite(listingNoticeHours) && listingNoticeHours > 0
    ? listingNoticeHours
    : LISTING_NOTICE_FALLBACK_HOURS;
  const listingMinutes = hours * 60;
  const calendar = Math.max(0, Math.round(calendarNoticeMin));
  return listingMinutes > calendar
    ? { minutes: listingMinutes, from: 'listing', listingHours: hours }
    : { minutes: calendar, from: 'calendar', listingHours: hours };
}

export function scheduleScopeSentence(schedule: CreatorSchedule, listingTitle?: string | null): string {
  const title = listingTitle || 'this listing';
  if (!schedule.listing_id) {
    return 'These are your creator-wide working hours. Every listing can follow them, narrow them, or reserve its own windows.';
  }
  if (schedule.mode === 'custom') return `${title} uses its own weekly hours (narrower than your usual hours).`;
  if (schedule.mode === 'exclusive') return `${title} reserves its own windows; other listings cannot use that time.`;
  return `${title} follows your usual working hours.`;
}

export interface PolicySummaryInput {
  schedule: CreatorSchedule;
  listingTitle?: string | null;
  listingBookingNoticeHours?: number | null;
}

/** Plain-English lines for the Working hours tab. Each line names whether the
 *  value is inherited or overridden, so a creator can tell what actually
 *  applies instead of guessing what the calendar policy does to a listing. */
export function policySummaryLines(input: PolicySummaryInput): string[] {
  const { schedule } = input;
  const lines: string[] = [];
  lines.push(scheduleScopeSentence(schedule, input.listingTitle));
  if (schedule.listing_id) {
    lines.push(schedule.mode === 'shared'
      ? 'Scope: inherits your calendar policy (notice, gap, daily limit and horizon).'
      : 'Scope: this listing overrides the session length and its own weekly windows; notice, gap, daily limit and horizon still come from your calendar policy.');
  } else {
    lines.push('Scope: these hours, notice, gap, daily limit and horizon are the defaults every listing inherits.');
  }
  const notice = effectiveNoticeMinutes(schedule.min_notice_min, input.listingBookingNoticeHours);
  lines.push(notice.from === 'listing'
    ? `Customers must book at least ${formatDuration(notice.minutes)} ahead: the listing's own booking notice (${notice.listingHours} hours) is longer than this calendar's ${formatDuration(schedule.min_notice_min)}.`
    : `Customers must book at least ${formatDuration(notice.minutes)} ahead. This calendar asks for ${formatDuration(schedule.min_notice_min)}; a listing whose own booking notice is longer always wins, and a listing that sets none counts as ${notice.listingHours} hours.`);
  lines.push(`Gap: ${formatDuration(schedule.buffer_min)} is kept free before AND after every session, on both sides, not only after it.`);
  lines.push(`Bookings open ${schedule.horizon_days} days ahead and at most ${schedule.max_per_day} can be booked per day.`);
  return lines;
}


// ── the listing's own schedule (#10) ───────────────────────────────────────
/** The draft fields this needs, structurally typed so lib/ does not import an
 *  island (and so a unit test needs no React). */
export interface ListingAvailabilityDraft {
  id: string | null;
  timezone: string;
  availability_mode: CreatorSchedule['mode'];
  availability_rules: AvailabilityRule[];
  duration_min: number;
}

/**
 * [CAL-AUDIT-2026-09-15 · #10] Build the listing's OWN availability schedule
 * from the schedule that is already loaded.
 *
 * The version this replaces hard-coded `horizon_days: 62`, so saving ANY consult
 * silently rewrote a deliberately chosen horizon to the maximum — a listing the
 * creator had limited to 30 days quietly offered 62. The horizon now comes from
 * `current` and is only CLAMPED to the server's 1..62 contract
 * (worker/src/routes/calendar_availability.ts).
 */
export function buildListingAvailabilitySchedule(current: CreatorSchedule, draft: ListingAvailabilityDraft): CreatorSchedule {
  return {
    ...current,
    listing_id: draft.id ?? current.listing_id,
    timezone: draft.timezone,
    mode: draft.availability_mode,
    duration_min: draft.duration_min,
    slot_interval_min: Math.max(5, current.slot_interval_min || draft.duration_min),
    horizon_days: clampHorizonDays(current.horizon_days),
    rules: draft.availability_mode === 'custom' ? draft.availability_rules : current.rules,
    version: current.version,
  };
}

// ── live draft preview (#11) ───────────────────────────────────────────────
/**
 * Last-write-wins guard for an async check whose inputs change as the creator
 * types. A slow response for an OLD time must never paint over the answer for
 * the time they are looking at now, so every request takes a ticket and only
 * the newest ticket is allowed to set state.
 */
export function createRequestGate() {
  let current = 0;
  return {
    next(): number { current += 1; return current; },
    isCurrent(ticket: number): boolean { return ticket === current; },
  };
}

export interface PreviewKeyInput {
  listingId?: string | null;
  startAt: number | null;
  endAt: number | null;
  timezone: string;
}

/** Stable identity of one "check this time" request, or null when there is not
 *  enough information yet (no listing, no time, no valid interval). */
export function conflictPreviewKey(input: PreviewKeyInput): string | null {
  if (!input.listingId) return null;
  if (input.startAt === null || input.endAt === null) return null;
  if (!Number.isFinite(input.startAt) || !Number.isFinite(input.endAt)) return null;
  if (input.endAt <= input.startAt) return null;
  return `${input.listingId}|${input.startAt}|${input.endAt}|${input.timezone}`;
}

/** A draft's time is NOT reserved; only a published/live listing holds it. */
export function listingReservationSentence(status: string | null | undefined): string {
  return status === 'published' || status === 'live'
    ? 'Published: this time is reserved for this listing.'
    : 'Draft: this time is not reserved yet. It is reserved only after the listing is published and a booking is confirmed.';
}

export function isReservedListingStatus(status: string | null | undefined): boolean {
  return status === 'published' || status === 'live';
}

/* ── preview state machine (#7, #11) ───────────────────────────────────────
 * The preview's verdict belongs to ONE (listing, start, end, timezone) key.
 * Keeping the transitions here — instead of inside the React effect — makes two
 * rules testable without a DOM:
 *   • a slow answer for a key that is no longer on screen is DROPPED (never
 *     overwrites a newer verdict, never resurrects a green one);
 *   • the moment the inputs change, the previous verdict is cleared, and a
 *     failure CLEARS any previous "free" state rather than leaving it showing. */
export type PreviewStatus = 'idle' | 'checking' | 'free' | 'conflict' | 'error';

export interface PreviewStateShape {
  status: PreviewStatus;
  /** The conflictPreviewKey this verdict belongs to; null while idle. */
  key: string | null;
  conflicts: ConflictItem[];
  alternatives: ConflictAlternative[];
  message: string | null;
}

export type PreviewEvent =
  | { type: 'reset' }
  | { type: 'start'; key: string }
  | { type: 'result'; key: string; ok: boolean; conflicts: ConflictItem[]; alternatives: ConflictAlternative[] }
  | { type: 'failure'; key: string; message: string };

export const IDLE_PREVIEW_STATE: PreviewStateShape = { status: 'idle', key: null, conflicts: [], alternatives: [], message: null };

export function reducePreview(state: PreviewStateShape, event: PreviewEvent): PreviewStateShape {
  if (event.type === 'reset') return IDLE_PREVIEW_STATE;
  if (event.type === 'start') {
    // Inputs changed: drop the old verdict immediately, even though the answer
    // is still debouncing. A verdict for a time nobody is looking at is wrong.
    if (state.status === 'checking' && state.key === event.key) return state;
    return { status: 'checking', key: event.key, conflicts: [], alternatives: [], message: null };
  }
  // Late answers for a superseded key never apply.
  if (state.key !== event.key) return state;
  if (event.type === 'result') {
    return {
      status: event.ok ? 'free' : 'conflict',
      key: event.key,
      conflicts: event.conflicts,
      alternatives: event.alternatives,
      message: null,
    };
  }
  return { status: 'error', key: event.key, conflicts: [], alternatives: [], message: event.message };
}

/**
 * [CAL-AUDIT-2026-09-15 · #7/#11] Wording for the draft preview.
 *
 * "Free" here means "no clash with the commitments on your calendar yet" — it
 * is NEVER "bookable": Google readiness, working hours, the notice window, the
 * gap before/after a session and the listing's own policy are applied when the
 * listing is saved/published and again when a customer books. Claiming a draft
 * is bookable would be a promise this preview cannot keep.
 */
export function previewHeadline(input: { status: PreviewStatus; firstTitle?: string | null; message?: string | null }): string {
  switch (input.status) {
    case 'checking': return 'Checking your calendar…';
    case 'free': return 'No clash with the commitments on your calendar yet.';
    case 'conflict': return input.firstTitle
      ? `This overlaps ${input.firstTitle}.`
      : 'This time conflicts with another commitment.';
    case 'error': return `Could not check this time: ${input.message ?? 'the preview failed'}`;
    default: return 'Checking this time against your calendar…';
  }
}

/* ── listing wizard availability hydration ────────────────────────────────
 * Late schedule loads are allowed to update the loaded CAS version, but they
 * must not overwrite edits the creator made while the request was in flight.
 * The signature only covers draft fields owned by AvaCalendar. */
export interface AvailabilityDraftFingerprintInput {
  timezone?: string | null;
  availability_mode?: string | null;
  mode?: string | null;
  availability_rules?: { weekday: number; start_min: number; end_min: number }[] | null;
  rules?: { weekday: number; start_min: number; end_min: number }[] | null;
  duration_min?: number | null;
}

export function availabilityDraftSignature(input: AvailabilityDraftFingerprintInput): string {
  const rules = (input.availability_rules ?? input.rules ?? [])
    .map((rule) => ({ weekday: rule.weekday, start_min: rule.start_min, end_min: rule.end_min }))
    .sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min || a.end_min - b.end_min);
  return JSON.stringify({
    timezone: input.timezone || '',
    mode: input.availability_mode || input.mode || '',
    duration_min: Number(input.duration_min) || 0,
    rules,
  });
}

export function shouldApplyHydratedAvailability(input: {
  requestedListingId: string | null;
  currentListingId: string | null;
  requestedGeneration: number;
  currentGeneration: number;
  requestedSignature: string;
  currentSignature: string;
}): boolean {
  return input.requestedListingId === input.currentListingId
    && input.requestedGeneration === input.currentGeneration
    && input.requestedSignature === input.currentSignature;
}

export function hydratedAvailabilityMismatchMessage(input: { firstLoad: boolean }): string {
  return input.firstLoad
    ? 'This listing’s calendar schedule loaded after you began editing availability. Discard those availability edits and reload the schedule before saving.'
    : 'This listing’s calendar schedule changed while you were editing. Discard local availability edits and reload before saving.';
}

/* ── account isolation (#1) ────────────────────────────────────────────────
 * Retained calendar state is per ACCOUNT. Signing into a different account in
 * the same tab must not leave the previous account's schedule, listings, blocks
 * or Google status on screen. The session token itself cannot be used as the
 * key — Clerk re-mints it periodically for the SAME user — so the stable subject
 * claim is used instead. This is a cache key ONLY: it never authorises anything,
 * and an unrecognised token shape returns null (no key, no invalidation) rather
 * than a guess. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function decodeBase64Url(value: string): string | null {
  let bits = 0;
  let count = 0;
  let out = '';
  for (const char of value) {
    const index = BASE64URL.indexOf(char);
    if (index < 0) return null;
    bits = (bits << 6) | index;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out += String.fromCharCode((bits >> count) & 0xff);
    }
  }
  return out;
}

/** Stable, non-secret account identity for cache invalidation, or null when the
 *  token shape is unknown. */
export function tokenAccountKey(token: string | null | undefined): string | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = decodeBase64Url(parts[1] ?? '');
      if (!payload) return null;
      const claims = JSON.parse(payload) as { sub?: unknown; sid?: unknown };
      if (typeof claims.sub === 'string' && claims.sub) return claims.sub;
      if (typeof claims.sid === 'string' && claims.sid) return claims.sid;
      return null;
    }
    // Legacy guest session: g1.<uid>.<exp>.<hmac>
    if (token.startsWith('g1.')) return parts[1] || null;
    return null;
  } catch {
    return null;
  }
}
