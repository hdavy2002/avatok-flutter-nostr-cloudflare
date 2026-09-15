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
  ALL_DAY_END_MIN, MAX_EXCEPTIONS, buildListingAvailabilitySchedule, clampHorizonDays, clockToMinutes,
  conflictPreviewKey, createRequestGate, dayItemsForRange, deriveGoogleReadiness, effectiveNoticeMinutes,
  exceptionBudget, intervalLabel, isAllDayInterval, isValidDateKey, listingReservationSentence,
  minutesToClock, planDateRange, planIntervalUpsert, policySummaryLines, removeInterval, weeklyRepeatDates,
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
function event(overrides: Partial<CalendarEvent> & { booking_id?: string | null } = {}): CalendarEvent {
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

test('an older backend without booking_id still folds the matching interval', () => {
  const items = dayItemsForRange(
    [block({ id: 'blk', starts_at: 1_000, ends_at: 2_000 })],
    [event({ booking_id: null, start_at: 1_000, end_at: 2_000 })],
    0, 10_000,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'booking');
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
