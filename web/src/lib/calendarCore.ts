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
  ExceptionStatus, GoogleCalendar, GoogleCalendarStatus,
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
 *  caller can show a message instead of writing a wrong interval. */
export function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
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
  const isHard = (item: AvailabilityException) =>
    item.status === 'reserved' || (opts.creatorWide && item.status === 'unavailable');
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
    if (covered && isHard(target)) { removed.push(existing); continue; }
    if (isHard(existing) && isHard(target)) {
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
 * `/api/calendar/blocks` fields (`booking_id`) the match is exact; against an
 * older backend the same interval from a non-Google source is treated as the
 * booking's own busy block, and only unmatched blocks stay visible.
 * Google blocks are never folded: they are external busy time, not bookings.
 */
export function dayItemsForRange(blocks: CalendarBlock[], events: CalendarEvent[], from: number, to: number): DayItem[] {
  const bookings: DayItem[] = [];
  const seenBookings = new Set<string>();
  for (const event of events) {
    if (!overlaps(event.start_at, event.end_at, from, to)) continue;
    const bookingId = event.booking_id ?? null;
    const key = bookingId ?? event.slot_id ?? `${event.start_at}-${event.end_at}`;
    if (seenBookings.has(`booking:${key}`)) continue;
    seenBookings.add(`booking:${key}`);
    bookings.push({
      key: `booking:${key}`,
      kind: 'booking',
      title: event.title || 'Booked session',
      start: event.start_at,
      end: event.end_at,
      status: 'Booked',
      tone: 'calendar-event-booked',
      listingId: event.listing_id ?? null,
      bookingId,
      internalBlockIds: [],
    });
  }
  const bookingIds = new Set(bookings.map((item) => item.bookingId).filter((value): value is string => !!value));
  const bookingIntervals = new Set(bookings.map((item) => `${item.start}:${item.end}`));
  const items: DayItem[] = [...bookings];
  for (const block of blocks) {
    if (!overlaps(block.starts_at, block.ends_at, from, to)) continue;
    const source = String(block.source_app ?? '').toLowerCase();
    const external = source === 'gcal';
    const ownedByBooking = !external && (
      (!!block.booking_id && bookingIds.has(block.booking_id)) ||
      bookingIntervals.has(`${block.starts_at}:${block.ends_at}`)
    );
    if (ownedByBooking) {
      const owner = items.find((item) => item.bookingId && block.booking_id === item.bookingId)
        ?? items.find((item) => item.start === block.starts_at && item.end === block.ends_at);
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
