// [CAL-AUDIT-2026-09-15] Regression tests for the creator-calendar fixes.
//
// node:test based, matching the convention already used by this repo's
// web/test/ (see device_checks.test.ts and sendMail.test.ts — there is no
// vitest devDependency in web/package.json). Run with:
//   node --experimental-strip-types --test web/test/calendar_core.test.ts
//
// Everything asserted here is pure logic from src/lib/calendarCore.ts, which has
// NO runtime imports, so these tests need neither a DOM nor a bundler. The
// cases map to the audit's acceptance checks:
//   full-day block round-trip · two breaks on one day · holiday range bounds ·
//   one card per booking · Google readiness from the OLDEST selected calendar ·
//   draft vs published reservation state · stale preview responses.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_DAY_END_MIN, IDLE_PREVIEW_STATE, LAST_CLOCK_MIN, MAX_EXCEPTIONS, availabilityDraftSignature, bookingRoleLabel, bookingRoleOf,
  buildListingAvailabilitySchedule, civilDateKey, clampHorizonDays, clockFieldsToInterval, clockToMinutes,
  conflictPreviewKey, createRequestGate, dayItemsForRange, deriveGoogleReadiness, effectiveNoticeMinutes,
  exceptionBudget, intervalLabel, intervalToClockFields, isAllDayInterval, isEndOfDayInterval,
  isValidDateKey, listingReservationSentence, minutesToClock, planDateRange, planIntervalUpsert,
  planIntervalUpserts, planSignature, policySummaryLines, hydratedAvailabilityMismatchMessage, previewHeadline, reducePreview, removeInterval,
  shouldApplyHydratedAvailability, shouldRunConflictPreview, tokenAccountKey, weeklyRepeatDates,
} from '../src/lib/calendarCore.ts';
import type { AvailabilityException, CalendarBlock, CalendarEvent, CreatorSchedule, GoogleCalendar, GoogleCalendarStatus } from '../src/lib/availability.ts';

const DAY = '2026-10-05';
const MINUTE = 60_000;

function schedule(overrides: Partial<CreatorSchedule> = {}): CreatorSchedule {
  return {
    listing_id: null, timezone: 'Asia/Kolkata', mode: 'shared', duration_min: 60, slot_interval_min: 60,
    buffer_min: 10, min_notice_min: 120, max_per_day: 8, horizon_days: 60, version: 1,
    rules: [], exceptions: [], ...overrides,
  };
}
function exception(overrides: Partial<AvailabilityException> = {}): AvailabilityException {
  return { id: 'e1', date: DAY, start_min: 0, end_min: 1440, status: 'unavailable', ...overrides };
}
function block(overrides: Partial<CalendarBlock> = {}): CalendarBlock {
  return { id: 'b1', source_app: 'availability', starts_at: 1_000, ends_at: 2_000, ...overrides };
}
/** `booking_id: null` drops the key entirely — an older backend OMITS the
 *  field, it does not send null, and the fallback path keys off its absence. */
function event(overrides: Omit<Partial<CalendarEvent>, 'booking_id'> & { booking_id?: string | null } = {}): CalendarEvent {
  const merged = { booking_id: 'bk1', title: 'Consultation', start_at: 1_000, end_at: 2_000, status: 'confirmed', ...overrides };
  const created = merged as CalendarEvent;
  if (overrides.booking_id === null) delete created.booking_id;
  return created;
}
function calendar(overrides: Partial<GoogleCalendar> = {}): GoogleCalendar {
  return { id: 'cal1', summary: 'Work', timezone: 'Asia/Kolkata', primary: false, selected: true, destination: false, ...overrides };
}
function gcalStatus(overrides: Partial<GoogleCalendarStatus> = {}): GoogleCalendarStatus {
  return { connected: true, ...overrides };
}

// ── all-day round-trip (audit #2) ──────────────────────────────────────────
test('minute 1440 is the end of the day, never midnight', () => {
  assert.equal(minutesToClock(ALL_DAY_END_MIN), '24:00');
  assert.equal(clockToMinutes('24:00'), ALL_DAY_END_MIN);
  assert.equal(clockToMinutes('00:00'), 0);
  assert.equal(isAllDayInterval(0, 1440), true);
  assert.equal(intervalLabel(0, 1440), 'All day');
});

test('clock values round-trip, and impossible input is rejected rather than guessed', () => {
  for (const minutes of [0, 1, 60, 540, 1020, 1439, 1440]) {
    assert.equal(clockToMinutes(minutesToClock(minutes)), minutes, `round-trip ${minutes}`);
  }
  assert.equal(clockToMinutes(''), null);
  assert.equal(clockToMinutes('9:00'), null);
  assert.equal(clockToMinutes('25:00'), null);
  assert.equal(clockToMinutes('10:75'), null);
  assert.equal(intervalLabel(780, 840), '13:00–14:00');
});

// The wizard's weekly-window row (listing-form/steps.tsx) renders "All day"
// for the same interval and must never feed "24:00" to an <input type="time">
// (which silently shows nothing and would let a whole-day rule be overwritten).
test('an all-day weekly window is detected, and every timed window is a valid clock value', () => {
  assert.equal(isAllDayInterval(0, 1440), true);
  assert.equal(intervalLabel(0, 1440), 'All day');
  for (const rule of [{ start: 0, end: 1439 }, { start: 540, end: 1020 }, { start: 1439, end: 1440 }]) {
    assert.equal(isAllDayInterval(rule.start, rule.end), false);
    assert.match(minutesToClock(rule.start), /^\d{2}:\d{2}$/);
    assert.match(minutesToClock(rule.end), /^\d{2}:\d{2}$/);
    assert.equal(clockToMinutes(minutesToClock(rule.end)), rule.end);
  }
});

// ── end-of-day for PARTIAL windows (audit #2) ──────────────────────────────
// A time input accepts "00:00".."23:59" and nothing else. 18:00..24:00 is a
// legal SAVED window (the server allows end 1440), so the editor carries the
// end-of-day flag and never hands "24:00" to the field.
const CLOCK_INPUT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

test('a partial window ending at minute 1440 round-trips through valid clock fields', () => {
  const fields = intervalToClockFields(18 * 60, ALL_DAY_END_MIN);
  assert.equal(fields.allDay, false);
  assert.equal(fields.endOfDay, true);
  assert.equal(fields.start, '18:00');
  assert.match(fields.end, CLOCK_INPUT_RE);
  assert.equal(fields.end, '23:59');
  assert.deepEqual(clockFieldsToInterval(fields), { start_min: 1080, end_min: 1440 });
});

test('editing a saved partial or whole-day window never feeds 24:00 to the field', () => {
  for (const [start, end] of [[0, 1440], [0, 1439], [540, 1440], [540, 1020], [1439, 1440]]) {
    const fields = intervalToClockFields(start, end);
    assert.match(fields.start, CLOCK_INPUT_RE, `start of ${start}..${end}`);
    assert.match(fields.end, CLOCK_INPUT_RE, `end of ${start}..${end}`);
    assert.deepEqual(clockFieldsToInterval(fields), { start_min: start, end_min: end }, `round-trip ${start}..${end}`);
  }
  // All-day is its own control, not the end-of-day flag.
  assert.equal(intervalToClockFields(0, 1440).allDay, true);
  assert.equal(intervalToClockFields(0, 1440).endOfDay, false);
  assert.equal(isEndOfDayInterval(0, 1440), false);
  assert.equal(isEndOfDayInterval(540, 1440), true);
  assert.equal(isEndOfDayInterval(540, 1439), false);
  // A rule written by the app (a weekly window to midnight) keeps minute 1440.
  assert.equal(clockFieldsToInterval({ start: '09:00', end: '23:59', allDay: false, endOfDay: true })?.end_min, 1440);
});

test('impossible clock fields are refused instead of guessed', () => {
  assert.equal(clockFieldsToInterval({ start: '17:00', end: '17:00', allDay: false, endOfDay: false }), null);
  assert.equal(clockFieldsToInterval({ start: '18:00', end: '09:00', allDay: false, endOfDay: false }), null);
  assert.equal(clockFieldsToInterval({ start: '', end: '09:00', allDay: false, endOfDay: false }), null);
  assert.equal(clockFieldsToInterval({ start: '24:00', end: '23:59', allDay: false, endOfDay: true }), null);
  assert.equal(clockFieldsToInterval({ start: 'nonsense', end: '09:00', allDay: false, endOfDay: true }), null);
  // endOfDay wins over whatever stale value the (disabled) field still holds.
  assert.deepEqual(clockFieldsToInterval({ start: '09:00', end: '10:00', allDay: false, endOfDay: true }), { start_min: 540, end_min: 1440 });
  assert.equal(LAST_CLOCK_MIN, 1439);
});

// ── several intervals on one day (audit #3) ────────────────────────────────
test('a second break on the same day is added beside the first, not over it', () => {
  const base = schedule({ exceptions: [exception({ id: 'lunch', date: DAY, start_min: 780, end_min: 840 })] });
  const plan = planIntervalUpsert(base, { date: DAY, start_min: 960, end_min: 1020, status: 'unavailable' }, { newId: 'pickup', creatorWide: true });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.next.length, 2);
  assert.deepEqual(plan.next.map((item) => item.id).sort(), ['lunch', 'pickup']);
});

test('saving the identical interval replaces it instead of duplicating the key', () => {
  const base = schedule({ exceptions: [exception({ id: 'lunch', date: DAY, start_min: 780, end_min: 840 })] });
  const plan = planIntervalUpsert(base, { date: DAY, start_min: 780, end_min: 840, status: 'unavailable' }, { newId: 'fresh', creatorWide: true });
  assert.equal(plan.next.length, 1);
  assert.equal(plan.replaced?.id, 'lunch');
});

test('a reserved window is never silently covered or dropped', () => {
  const base = schedule({ exceptions: [exception({ id: 'reserved', date: DAY, start_min: 780, end_min: 840, status: 'reserved', listing_id: 'l1' })] });
  const plan = planIntervalUpsert(base, { date: DAY, start_min: 0, end_min: 1440, status: 'unavailable' }, { newId: 'new', creatorWide: true });
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0], /reserved/i);
  assert.equal(plan.next.some((item) => item.id === 'reserved'), true);
});

test('overlapping blocked windows are refused creator-wide but allowed on a listing schedule', () => {
  const base = schedule({ exceptions: [exception({ id: 'existing', date: DAY, start_min: 600, end_min: 660 })] });
  const target = { date: DAY, start_min: 630, end_min: 690, status: 'unavailable' as const };
  const creatorWide = planIntervalUpsert(base, target, { newId: 'new', creatorWide: true });
  assert.equal(creatorWide.conflicts.length, 1);
  const listingOnly = planIntervalUpsert(base, target, { newId: 'new', creatorWide: false });
  assert.deepEqual(listingOnly.conflicts, []);
  assert.equal(listingOnly.next.length, 2);
});

test('intervals on other dates survive an edit and a removal untouched', () => {
  const other = exception({ id: 'other', date: '2026-10-06', start_min: 600, end_min: 660 });
  const base = schedule({ exceptions: [exception({ id: 'a', date: DAY, start_min: 600, end_min: 660 }), other] });
  const plan = planIntervalUpsert(base, { date: DAY, start_min: 600, end_min: 700, status: 'unavailable' }, { newId: 'x', creatorWide: true });
  assert.equal(plan.next.some((item) => item.id === 'other'), true);
  assert.equal(removeInterval({ ...base, exceptions: plan.next }, 'a').some((item) => item.id === 'other'), true);
  assert.equal(removeInterval(base, 'a').length, 1);
});

// ── multi-date planning + replace confirmation (audit #5) ──────────────────
let idCounter = 0;
const nextId = () => `id${(idCounter += 1)}`;

test('a date range is planned over every date and reports what it would replace', () => {
  const base = schedule({
    exceptions: [
      exception({ id: 'lunch', date: '2026-10-05', start_min: 780, end_min: 840 }),
      exception({ id: 'far', date: '2026-12-01', start_min: 600, end_min: 660 }),
    ],
  });
  const plan = planIntervalUpserts(base, { date: '2026-10-05', start_min: 0, end_min: 1440, status: 'unavailable' }, ['2026-10-05', '2026-10-06', '2026-10-07'], { newId: nextId, creatorWide: true });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.next.filter((item) => item.date.startsWith('2026-10-0')).length, 3);
  // The covered lunch window is REPORTED before the write, not silently dropped.
  assert.deepEqual(plan.removed.map((item) => item.id), ['lunch']);
  assert.equal(plan.changesExisting, true);
  // The unrelated December window is untouched, on every date.
  assert.equal(plan.next.some((item) => item.id === 'far'), true);
  assert.equal(plan.next.length, 4);
});

test('a range that would cover a reserved window changes nothing and says which date', () => {
  const base = schedule({
    exceptions: [
      exception({ id: 'hold', date: '2026-10-06', start_min: 600, end_min: 660, status: 'reserved', listing_id: 'l1' }),
      exception({ id: 'keep', date: '2026-10-07', start_min: 600, end_min: 660 }),
    ],
  });
  const plan = planIntervalUpserts(
    base,
    { date: '2026-10-05', start_min: 0, end_min: 1440, status: 'unavailable' },
    ['2026-10-05', '2026-10-06', '2026-10-07'],
    { newId: nextId, creatorWide: true, labelForDate: (key) => key },
  );
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0], /^2026-10-06: /);
  assert.equal(plan.next.some((item) => item.id === 'hold'), true);
  // The date that could not be applied is NOT added either (nothing partial).
  assert.equal(plan.next.some((item) => item.date === '2026-10-06' && item.id !== 'hold'), false);
  // 10-05 and 10-07 were still planned, and 10-07's block is still there.
  assert.equal(plan.next.some((item) => item.date === '2026-10-05' && item.id !== 'keep' && item.id !== 'hold'), true);
  assert.equal(plan.next.some((item) => item.id === 'keep'), true);
});

test('an edit excludes its OWN window from the plan instead of refusing it (#3)', () => {
  const base = schedule({ exceptions: [exception({ id: 'mine', date: DAY, start_min: 540, end_min: 600 })] });
  const plan = planIntervalUpsert(base, { id: 'mine', date: DAY, start_min: 540, end_min: 720, status: 'unavailable' }, { newId: 'unused', creatorWide: true });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.next.length, 1);
  assert.equal(plan.next[0].id, 'mine');
  assert.equal(plan.next[0].end_min, 720);
});

test('the cosmetic conflict preview never runs for an edit or a replace-set (#3)', () => {
  const none: AvailabilityException[] = [];
  assert.equal(shouldRunConflictPreview({ mode: 'edit', dates: 1, conflicts: [], removed: none, replaced: none }), false);
  assert.equal(shouldRunConflictPreview({ mode: 'add', dates: 2, conflicts: [], removed: none, replaced: none }), false);
  assert.equal(shouldRunConflictPreview({ mode: 'add', dates: 1, conflicts: [], removed: [exception({ id: 'covered' })], replaced: none }), false);
  assert.equal(shouldRunConflictPreview({ mode: 'add', dates: 1, conflicts: [], removed: none, replaced: [exception({ id: 'samekey' })] }), false);
  assert.equal(shouldRunConflictPreview({ mode: 'add', dates: 1, conflicts: ['overlaps a booking'], removed: none, replaced: none }), false);
  assert.equal(shouldRunConflictPreview({ mode: 'add', dates: 1, conflicts: [], removed: none, replaced: none }), true);
});

test('creator-wide unavailable windows and a listing schedule draw different budgets', () => {
  const base = schedule({ exceptions: [exception({ id: 'a' }), exception({ id: 'b', date: '2026-10-07' })] });
  assert.equal(exceptionBudget(base), MAX_EXCEPTIONS - 2);
  assert.equal(exceptionBudget(base, [DAY]), MAX_EXCEPTIONS - 1);
});

// ── holiday date ranges (audit #2, #3) ─────────────────────────────────────
test('a date range stops at the schedule horizon instead of forcing 62 days', () => {
  const plan = planDateRange({ from: '2026-10-01', to: '2026-12-31', horizonDays: 30, existingCount: 0 });
  assert.equal(plan.days, 30);
  assert.equal(plan.truncated, 'horizon');
  assert.equal(plan.dates[0], '2026-10-01');
  assert.equal(plan.dates.at(-1), '2026-10-30');
  assert.match(plan.messages[0], /30-day booking horizon/);
});

test('a date range respects the 62-day maximum and the 100-exception budget', () => {
  const long = planDateRange({ from: '2026-10-01', to: '2027-12-31', horizonDays: 400, existingCount: 0 });
  assert.equal(long.days, 62);
  const tight = planDateRange({ from: '2026-10-01', to: '2026-10-31', horizonDays: 60, existingCount: 98 });
  assert.equal(tight.days, 2);
  assert.equal(tight.truncated, 'budget');
  const full = planDateRange({ from: '2026-10-01', to: '2026-10-31', horizonDays: 60, existingCount: MAX_EXCEPTIONS });
  assert.equal(full.dates.length, 0);
  assert.match(full.messages[0], /maximum of 100/);
});

test('an impossible range is reported, never silently turned into dates', () => {
  const reversed = planDateRange({ from: '2026-10-10', to: '2026-10-01', horizonDays: 60, existingCount: 0 });
  assert.deepEqual(reversed.dates, []);
  assert.equal(reversed.truncated, 'reversed');
  const invalid = planDateRange({ from: '2026-02-30', to: '2026-03-02', horizonDays: 60, existingCount: 0 });
  assert.equal(invalid.truncated, 'invalid');
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-02-28'), true);
});

test('weekly repetition stays inside the horizon and the budget', () => {
  const dates = weeklyRepeatDates(DAY, 60, 100);
  assert.equal(dates[0], DAY);
  assert.equal(dates.length, 9);
  assert.equal(dates.at(-1), '2026-11-30');
  const capped = weeklyRepeatDates(DAY, 60, 3);
  assert.equal(capped.length, 3);
  assert.deepEqual(weeklyRepeatDates(DAY, 5, 100), [DAY]);
});

test('a deliberately chosen horizon is preserved, only clamped to the contract', () => {
  assert.equal(clampHorizonDays(30), 30);
  assert.equal(clampHorizonDays(62), 62);
  assert.equal(clampHorizonDays(63), 62);
  assert.equal(clampHorizonDays(400), 62);
  assert.equal(clampHorizonDays(0), 60);
  assert.equal(clampHorizonDays(-5), 60);
  assert.equal(clampHorizonDays(Number.NaN), 60);
  assert.equal(clampHorizonDays(undefined, 45), 45);
});

// ── one card per booking (audit #7) ────────────────────────────────────────
test('a booking and its own busy block render as ONE card', () => {
  const items = dayItemsForRange(
    [block({ id: 'blk', booking_id: 'bk1', starts_at: 1_000, ends_at: 2_000 })],
    [event({ booking_id: 'bk1', start_at: 1_000, end_at: 2_000 })],
    0, 10_000,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'booking');
  assert.equal(items[0].status, 'Booked');
  assert.deepEqual(items[0].internalBlockIds, ['blk']);
});

test('without a canonical booking id the busy block is NOT folded into a booking (#6)', () => {
  // An older backend omits booking_id. Guessing ownership from an identical
  // interval could attribute this block to the WRONG commitment, so it stays
  // visible as its own card — an honest duplicate beats a wrong link.
  const items = dayItemsForRange(
    [block({ id: 'blk', starts_at: 1_000, ends_at: 2_000 })],
    [event({ booking_id: null, start_at: 1_000, end_at: 2_000 })],
    0, 10_000,
  );
  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.kind === 'booking').length, 1);
  assert.equal(items.filter((item) => item.kind === 'busy').length, 1);
  assert.deepEqual(items.find((item) => item.kind === 'booking')?.internalBlockIds, []);
});

test('each booking keeps its OWN busy block when two share a timespan (#6)', () => {
  const items = dayItemsForRange(
    [
      block({ id: 'blk-a', booking_id: 'bk1', starts_at: 1_000, ends_at: 2_000 }),
      block({ id: 'blk-b', booking_id: 'bk2', starts_at: 1_000, ends_at: 2_000 }),
    ],
    [
      event({ booking_id: 'bk1', start_at: 1_000, end_at: 2_000 }),
      event({ booking_id: 'bk2', start_at: 1_000, end_at: 2_000 }),
    ],
    0, 10_000,
  );
  assert.equal(items.length, 2);
  assert.deepEqual(items.find((item) => item.bookingId === 'bk1')?.internalBlockIds, ['blk-a']);
  assert.deepEqual(items.find((item) => item.bookingId === 'bk2')?.internalBlockIds, ['blk-b']);
});

test('two sessions on one group slot are never collapsed into one card (#6)', () => {
  const items = dayItemsForRange([], [
    event({ booking_id: 'bk1', slot_id: 'slot9', start_at: 1_000, end_at: 2_000 }),
    event({ booking_id: 'bk2', slot_id: 'slot9', start_at: 1_000, end_at: 2_000 }),
  ], 0, 10_000);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.bookingId).sort(), ['bk1', 'bk2']);
});

test('events without a canonical id are never merged even when the interval matches (#6)', () => {
  const items = dayItemsForRange([], [
    event({ booking_id: null, start_at: 1_000, end_at: 2_000 }),
    event({ booking_id: null, start_at: 1_000, end_at: 2_000 }),
  ], 0, 10_000);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
});

test('the booking role is the one the server stated, never guessed (#6)', () => {
  assert.equal(bookingRoleOf({ booking_role: 'creator', role: 'attendee' }), 'creator');
  assert.equal(bookingRoleOf({ booking_role: 'customer' }), 'customer');
  assert.equal(bookingRoleOf({ booking_role: '  CREATOR ' }), 'creator');
  assert.equal(bookingRoleOf({ role: 'host' }), 'creator');
  assert.equal(bookingRoleOf({ role: 'attendee' }), 'customer');
  assert.equal(bookingRoleOf({}), null);
  assert.equal(bookingRoleLabel('creator'), 'you host');
  assert.equal(bookingRoleLabel('customer'), 'you booked');
  assert.equal(bookingRoleLabel(null), null);
  const items = dayItemsForRange([], [event({ booking_id: 'bk9', booking_role: 'customer', title: 'Untitled' })], 0, 10_000);
  assert.equal(items[0].bookingRole, 'customer');
});

test('Google busy time is never folded into a booking and unmatched blocks stay visible', () => {
  const items = dayItemsForRange(
    [block({ id: 'g', source_app: 'gcal', starts_at: 1_000, ends_at: 2_000 }), block({ id: 'u', starts_at: 5_000, ends_at: 6_000 })],
    [event({ booking_id: 'bk1', start_at: 1_000, end_at: 2_000 })],
    0, 10_000,
  );
  assert.equal(items.length, 3);
  assert.equal(items.filter((item) => item.kind === 'booking').length, 1);
  assert.equal(items.some((item) => item.tone === 'calendar-event-google'), true);
  assert.equal(items.some((item) => item.kind === 'busy' && item.internalBlockIds.length === 0), true);
});

test('a duplicated event for the same booking is still one card, and other days are excluded', () => {
  const items = dayItemsForRange([], [
    event({ booking_id: 'bk1', start_at: 1_000, end_at: 2_000 }),
    event({ booking_id: 'bk1', start_at: 1_000, end_at: 2_000 }),
    event({ booking_id: 'bk2', start_at: 50_000, end_at: 51_000 }),
  ], 0, 10_000);
  assert.equal(items.length, 1);
  assert.equal(items[0].bookingId, 'bk1');
});

// ── Google readiness (audit #5, #6) ────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test('the OLDEST selected calendar decides readiness, never the newest', () => {
  const readiness = deriveGoogleReadiness(gcalStatus({
    calendars: [
      calendar({ id: 'fresh', last_success_at: NOW - 5 * MINUTE }),
      calendar({ id: 'stale', last_success_at: NOW - 45 * MINUTE }),
      calendar({ id: 'unselected', selected: false, last_success_at: NOW - MINUTE }),
    ],
  }), NOW);
  assert.equal(readiness.state, 'attention');
  assert.equal(readiness.reason, 'stale');
  assert.equal(readiness.lastSuccessAt, NOW - 45 * MINUTE);
  assert.equal(readiness.selectedCount, 2);
  assert.match(readiness.detail, /45 min/);
});

test('ready needs the server verdict and current selected sources', () => {
  const readiness = deriveGoogleReadiness(gcalStatus({
    ready: true, last_success_at: NOW - 5 * MINUTE,
    calendars: [calendar({ last_success_at: NOW - 5 * MINUTE })],
  }), NOW);
  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.label, 'Ready');
  assert.equal(readiness.verified, true);
});

test('a stale or failing selected calendar downgrades a server "ready"', () => {
  const stale = deriveGoogleReadiness(gcalStatus({
    ready: true, calendars: [calendar({ last_success_at: NOW - 90 * MINUTE })],
  }), NOW);
  assert.equal(stale.state, 'attention');
  const erroring = deriveGoogleReadiness(gcalStatus({
    ready: true, calendars: [calendar({ last_success_at: NOW - MINUTE, last_error: 'token expired' })],
  }), NOW);
  assert.equal(erroring.state, 'attention');
  assert.match(erroring.detail, /token expired/);
});

test('a first sync in progress is Syncing, and it is still not Ready', () => {
  const readiness = deriveGoogleReadiness(gcalStatus({ last_success_at: null, calendars: [calendar({ last_success_at: null })] }), NOW);
  assert.equal(readiness.state, 'syncing');
  assert.match(readiness.detail, /first sync/);
});

test('no selected calendar is attention, and a disconnected account is not connected', () => {
  const empty = deriveGoogleReadiness(gcalStatus({ ready: false, reason: 'no_selected_calendars', calendars: [calendar({ selected: false })] }), NOW);
  assert.equal(empty.state, 'attention');
  assert.equal(empty.reason, 'no_selected_calendars');
  const off = deriveGoogleReadiness(gcalStatus({ connected: false, calendars: [] }), NOW);
  assert.equal(off.state, 'not_connected');
  assert.equal(deriveGoogleReadiness(null, NOW).state, 'unknown');
});

test('an older backend without readiness fields is never labelled healthy', () => {
  const unknown = deriveGoogleReadiness(gcalStatus({ connected: true }), NOW);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.verified, false);
  assert.match(unknown.label, /not verified/);
  const derived = deriveGoogleReadiness(gcalStatus({ connected: true, calendars: [calendar({ last_success_at: NOW - 10 * MINUTE })] }), NOW);
  assert.equal(derived.state, 'ready');
  assert.equal(derived.lastSuccessAt, NOW - 10 * MINUTE);
});

// ── live draft preview (audit #11) ─────────────────────────────────────────
test('a stale preview response cannot overwrite a newer one', () => {
  const gate = createRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test('a preview answer for a superseded time never lands, and a new key clears the old verdict', () => {
  const free = reducePreview(
    reducePreview(IDLE_PREVIEW_STATE, { type: 'start', key: 'K1' }),
    { type: 'result', key: 'K1', ok: true, conflicts: [], alternatives: [] },
  );
  assert.equal(free.status, 'free');
  // The creator edits the time: the green verdict is dropped AT ONCE, before the
  // debounced answer for the new time exists.
  const checking = reducePreview(free, { type: 'start', key: 'K2' });
  assert.equal(checking.status, 'checking');
  assert.deepEqual(checking.conflicts, []);
  // A slow answer for the OLD time arrives: it must not resurrect "free".
  assert.equal(reducePreview(checking, { type: 'result', key: 'K1', ok: true, conflicts: [], alternatives: [] }).status, 'checking');
  const conflicted = reducePreview(checking, { type: 'result', key: 'K2', ok: false, conflicts: [{ title: 'Client call', start_at: 1, end_at: 2 }], alternatives: [] });
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.conflicts.length, 1);
  // A late failure for the OLD key cannot clear the newer conflict.
  assert.equal(reducePreview(conflicted, { type: 'failure', key: 'K1', message: 'network' }).status, 'conflict');
});

test('a failed preview clears an earlier green verdict instead of leaving it showing', () => {
  const free = reducePreview(
    reducePreview(IDLE_PREVIEW_STATE, { type: 'start', key: 'K1' }),
    { type: 'result', key: 'K1', ok: true, conflicts: [], alternatives: [] },
  );
  assert.equal(free.status, 'free');
  const failed = reducePreview(free, { type: 'failure', key: 'K1', message: 'server said no' });
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.conflicts, []);
  assert.deepEqual(failed.alternatives, []);
  assert.match(failed.message ?? '', /server said no/);
  assert.equal(reducePreview(failed, { type: 'reset' }).status, 'idle');
});

test('the preview never calls a draft bookable, only free of clashes (#7)', () => {
  assert.match(previewHeadline({ status: 'free' }), /no clash with the commitments on your calendar/i);
  assert.doesNotMatch(previewHeadline({ status: 'free' }), /bookable|fully booked|will be booked|guaranteed/i);
  assert.equal(previewHeadline({ status: 'conflict', firstTitle: 'Client call' }), 'This overlaps Client call.');
  assert.equal(previewHeadline({ status: 'conflict', firstTitle: null }), 'This time conflicts with another commitment.');
  assert.match(previewHeadline({ status: 'error', message: 'offline' }), /offline/);
  assert.match(previewHeadline({ status: 'checking' }), /Checking/);
});

test('the preview key is stable, and absent until there is a real interval', () => {
  const key = conflictPreviewKey({ listingId: 'l1', startAt: 1_000, endAt: 4_600, timezone: 'Asia/Kolkata' });
  assert.equal(key, 'l1|1000|4600|Asia/Kolkata');
  assert.equal(conflictPreviewKey({ listingId: null, startAt: 1_000, endAt: 4_600, timezone: 'UTC' }), null);
  assert.equal(conflictPreviewKey({ listingId: 'l1', startAt: 5_000, endAt: 5_000, timezone: 'UTC' }), null);
  assert.equal(conflictPreviewKey({ listingId: 'l1', startAt: null, endAt: 4_600, timezone: 'UTC' }), null);
});

test('a draft says its time is unreserved, a published listing says reserved', () => {
  assert.match(listingReservationSentence('draft'), /not reserved yet/);
  assert.match(listingReservationSentence('pending_review'), /not reserved yet/);
  assert.match(listingReservationSentence('published'), /^Published: this time is reserved/);
  assert.match(listingReservationSentence('live'), /^Published: this time is reserved/);
});

// ── policy, in plain English (audit #10) ───────────────────────────────────
test('the effective notice is the longer of calendar and listing, listing defaulting to 24 hours', () => {
  assert.deepEqual(effectiveNoticeMinutes(120, 6), { minutes: 360, from: 'listing', listingHours: 6 });
  assert.deepEqual(effectiveNoticeMinutes(120, 24), { minutes: 1440, from: 'listing', listingHours: 24 });
  assert.equal(effectiveNoticeMinutes(120, undefined).minutes, 1440);
  assert.equal(effectiveNoticeMinutes(2880, 1).from, 'calendar');
});

test('the policy summary names inheritance, the longer notice and the both-sided gap', () => {
  const listingLines = policySummaryLines({ schedule: schedule({ listing_id: 'l1', mode: 'custom', min_notice_min: 120, buffer_min: 15, horizon_days: 30 }), listingTitle: 'Career call' });
  assert.equal(listingLines.some((line) => /own weekly hours/.test(line)), true);
  assert.equal(listingLines.some((line) => /overrides/.test(line)), true);
  assert.equal(listingLines.some((line) => /before AND after/.test(line)), true);
  assert.equal(listingLines.some((line) => /24 hours/.test(line)), true);
  const calendarLines = policySummaryLines({ schedule: schedule() });
  assert.equal(calendarLines.some((line) => /creator-wide/.test(line)), true);
  assert.equal(calendarLines.some((line) => /60 days ahead/.test(line)), true);
});

test('the listing schedule builder preserves the horizon and applies the chosen mode', () => {
  const current = schedule({ listing_id: null, horizon_days: 30, mode: 'shared', rules: [{ weekday: 5, start_min: 600, end_min: 660 }], version: 7 });
  const custom = buildListingAvailabilitySchedule(current, {
    id: 'l1', timezone: 'Europe/London', availability_mode: 'custom',
    availability_rules: [{ weekday: 1, start_min: 540, end_min: 1020 }], duration_min: 45,
  });
  assert.equal(custom.horizon_days, 30);
  assert.equal(custom.listing_id, 'l1');
  assert.equal(custom.mode, 'custom');
  assert.equal(custom.version, 7);
  assert.deepEqual(custom.rules, [{ weekday: 1, start_min: 540, end_min: 1020 }]);
  assert.equal(custom.slot_interval_min, 60);
  assert.equal(custom.timezone, 'Europe/London');

  const shared = buildListingAvailabilitySchedule(current, {
    id: 'l1', timezone: 'Asia/Kolkata', availability_mode: 'shared',
    availability_rules: [{ weekday: 1, start_min: 540, end_min: 1020 }], duration_min: 45,
  });
  assert.deepEqual(shared.rules, current.rules);

  const overMax = buildListingAvailabilitySchedule(schedule({ horizon_days: 400 }), {
    id: 'l2', timezone: 'UTC', availability_mode: 'exclusive', availability_rules: [], duration_min: 30,
  });
  assert.equal(overMax.horizon_days, 62);
});

// ── the newest load wins, and account changes invalidate retained state (#1) ─
//
// The diary takes its sequence ticket BEFORE awaiting the Clerk token renewal
// (CalendarPanel.load). Taken afterwards, an older request that renewed slowly
// could be handed the higher ticket and land LAST, overwriting the month and
// filter the creator is actually looking at with stale data. The property the
// fix relies on is that a ticket only counts while no later one was taken.
test('a load ticket stops being current the moment a later one is taken', () => {
  const sequence = createRequestGate();
  const mountLoad = sequence.next();
  assert.equal(sequence.isCurrent(mountLoad), true);
  const focusReload = sequence.next();
  assert.equal(sequence.isCurrent(mountLoad), false);
  assert.equal(sequence.isCurrent(focusReload), true);
});

test('today is the schedule timezone civil date, not the device date (#1)', () => {
  const instant = Date.UTC(2026, 0, 1, 2, 30, 0);
  assert.equal(civilDateKey(instant, 'America/Los_Angeles'), '2025-12-31');
  assert.equal(civilDateKey(instant, 'Asia/Kolkata'), '2026-01-01');
  assert.equal(civilDateKey(instant, 'UTC'), '2026-01-01');
  assert.equal(civilDateKey(instant, 'No/Such_Zone'), null);
  assert.equal(civilDateKey(Number.NaN, 'UTC'), null);
});

test('a replace confirmation only applies to the identical save plan (#5)', () => {
  const first = planSignature({
    mode: 'add',
    dates: ['2026-10-05'],
    startMin: 540,
    endMin: 1020,
    status: 'unavailable',
    listingId: null,
    affectedIds: ['old'],
  });
  assert.equal(first, planSignature({
    mode: 'add',
    dates: ['2026-10-05'],
    startMin: 540,
    endMin: 1020,
    status: 'unavailable',
    listingId: null,
    affectedIds: ['old'],
  }));
  assert.notEqual(first, planSignature({
    mode: 'add',
    dates: ['2026-10-05'],
    startMin: 540,
    endMin: 1080,
    status: 'unavailable',
    listingId: null,
    affectedIds: ['old'],
  }));
  assert.notEqual(first, planSignature({
    mode: 'add',
    dates: ['2026-10-05'],
    startMin: 540,
    endMin: 1020,
    status: 'unavailable',
    listingId: 'listing_1',
    affectedIds: ['old'],
  }));
});

/** Test-local base64url encoder, so a fixture never depends on the decoder
 *  under test (a shared bug in both would otherwise go unnoticed). */
function b64url(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Array.from(value, (char) => char.charCodeAt(0));
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    out += alphabet[(a >> 2) & 63];
    out += alphabet[((a & 3) << 4) | ((b >> 4) & 15)];
    if (index + 1 < bytes.length) out += alphabet[((b & 15) << 2) | ((c >> 6) & 3)];
    if (index + 2 < bytes.length) out += alphabet[c & 63];
  }
  return out;
}
const jwt = (claims: Record<string, unknown>) => `header.${b64url(JSON.stringify(claims))}.signature`;

test('the account key is stable across token refreshes and changes with the account (#1)', () => {
  // Same account, re-minted token (new exp/iat): NOT a reason to wipe the view.
  assert.equal(tokenAccountKey(jwt({ sub: 'user_a', exp: 1 })), 'user_a');
  assert.equal(tokenAccountKey(jwt({ sub: 'user_a', exp: 2 })), 'user_a');
  // A different account: different key, so retained state is dropped.
  assert.notEqual(tokenAccountKey(jwt({ sub: 'user_a' })), tokenAccountKey(jwt({ sub: 'user_b' })));
  // Session-scoped tokens fall back to `sid`; a guest session to its uid.
  assert.equal(tokenAccountKey(jwt({ sid: 'sess_1' })), 'sess_1');
  assert.equal(tokenAccountKey('g1.user_9.123.hmac'), 'user_9');
});

test('an unreadable token yields no account key rather than a guess (#1)', () => {
  assert.equal(tokenAccountKey(null), null);
  assert.equal(tokenAccountKey(undefined), null);
  assert.equal(tokenAccountKey(''), null);
  assert.equal(tokenAccountKey('opaque-host-token'), null);
  assert.equal(tokenAccountKey('a.@@@.c'), null);
  assert.equal(tokenAccountKey(jwt({})), null);
});


test('availability hydrate signatures ignore rule order but catch calendar edits (#1)', () => {
  const a = availabilityDraftSignature({
    timezone: 'Asia/Kolkata',
    availability_mode: 'shared',
    duration_min: 45,
    availability_rules: [
      { weekday: 2, start_min: 600, end_min: 900 },
      { weekday: 1, start_min: 540, end_min: 720 },
    ],
  });
  const b = availabilityDraftSignature({
    timezone: 'Asia/Kolkata',
    availability_mode: 'shared',
    duration_min: 45,
    availability_rules: [
      { weekday: 1, start_min: 540, end_min: 720 },
      { weekday: 2, start_min: 600, end_min: 900 },
    ],
  });
  assert.equal(a, b);
  assert.notEqual(a, availabilityDraftSignature({ timezone: 'Asia/Kolkata', availability_mode: 'shared', duration_min: 60, availability_rules: [] }));
});

test('late availability hydration applies only to the listing and draft generation it loaded for (#1)', () => {
  const signature = availabilityDraftSignature({ timezone: 'Asia/Kolkata', availability_mode: 'shared', duration_min: 60, availability_rules: [] });
  assert.equal(shouldApplyHydratedAvailability({
    requestedListingId: 'list_a', currentListingId: 'list_a', requestedGeneration: 2, currentGeneration: 2, requestedSignature: signature, currentSignature: signature,
  }), true);
  assert.equal(shouldApplyHydratedAvailability({
    requestedListingId: 'list_a', currentListingId: 'list_a', requestedGeneration: 2, currentGeneration: 3, requestedSignature: signature, currentSignature: signature,
  }), false);
  assert.equal(shouldApplyHydratedAvailability({
    requestedListingId: 'list_a', currentListingId: 'list_b', requestedGeneration: 2, currentGeneration: 2, requestedSignature: signature, currentSignature: signature,
  }), false);
  assert.equal(shouldApplyHydratedAvailability({
    requestedListingId: 'list_a', currentListingId: 'list_a', requestedGeneration: 2, currentGeneration: 2, requestedSignature: signature, currentSignature: availabilityDraftSignature({ timezone: 'UTC', availability_mode: 'shared', duration_min: 60, availability_rules: [] }),
  }), false);
});

test('late availability hydration mismatch does not adopt the fetched schedule version (#1)', () => {
  const draftBefore = { id: 'list_a', timezone: 'Asia/Kolkata', availability_mode: 'shared', duration_min: 60, availability_rules: [], availability_version: 7 };
  const requestedSignature = availabilityDraftSignature(draftBefore);
  const draftAfterUserEdit = { ...draftBefore, duration_min: 90 };
  const fetchedSchedule = schedule({ listing_id: 'list_a', timezone: 'UTC', mode: 'exclusive', duration_min: 30, version: 8, rules: [{ weekday: 1, start_min: 540, end_min: 720 }] });
  const mayApply = shouldApplyHydratedAvailability({
    requestedListingId: 'list_a',
    currentListingId: draftAfterUserEdit.id,
    requestedGeneration: 4,
    currentGeneration: 5,
    requestedSignature,
    currentSignature: availabilityDraftSignature(draftAfterUserEdit),
  });
  assert.equal(mayApply, false);
  // The component's mismatch branch preserves the old draft and reports a
  // discard/reload conflict; it must not combine old edits with version 8.
  const draftAfterMismatch = mayApply ? { ...draftAfterUserEdit, availability_version: fetchedSchedule.version } : draftAfterUserEdit;
  assert.equal(draftAfterMismatch.availability_version, 7);
  assert.equal(draftAfterMismatch.duration_min, 90);
  assert.match(hydratedAvailabilityMismatchMessage({ firstLoad: true }), /Discard those availability edits and reload/);
});
