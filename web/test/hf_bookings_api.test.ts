import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bookingConfirmationBody, bookingIdempotencyHeaders, legacyHoursToRules, normalizeAvailabilitySchedule, scheduleUpdateBody,
  type AvailabilitySchedule,
} from '../src/lib/hfBookingsApi.ts';

const sample = (): AvailabilitySchedule => ({
  timezone: 'Asia/Kolkata', version: 4, durationsMinutes: [15, 30], slotIntervalMinutes: 15,
  bufferMinutes: 10, minNoticeMinutes: 120, horizonDays: 60,
  rules: [
    { weekday: 1, startMin: 1320, endMin: 120 },
    { weekday: 3, startMin: 540, endMin: 1020 },
  ],
  exceptions: [
    { date: '2026-10-18', startMin: 1380, endMin: 60, status: 'unavailable' },
    { date: '2026-10-20', startMin: 600, endMin: 660, status: 'available' },
  ],
});

test('overnight rules split at midnight and preserve other weekdays and date overrides', () => {
  const before = sample();
  const saved = normalizeAvailabilitySchedule(before);
  assert.deepEqual(saved.rules, [
    { weekday: 1, startMin: 1320, endMin: 1440 },
    { weekday: 2, startMin: 0, endMin: 120 },
    { weekday: 3, startMin: 540, endMin: 1020 },
  ]);
  assert.deepEqual(saved.exceptions, [
    { date: '2026-10-18', startMin: 1380, endMin: 1440, status: 'unavailable' },
    { date: '2026-10-19', startMin: 0, endMin: 60, status: 'unavailable' },
    { date: '2026-10-20', startMin: 600, endMin: 660, status: 'available' },
  ]);
  assert.equal(saved.version, before.version);
  assert.deepEqual(before.rules[1], { weekday: 3, startMin: 540, endMin: 1020 });
});

test('legacy overnight hours split across weekdays, wrap Sunday, and deduplicate selected days', () => {
  assert.deepEqual(legacyHoursToRules({ days: [0, 0, 6, 'bad', 8], from: '22:00', to: '02:00' }), [
    { weekday: 1, startMin: 1320, endMin: 1440 },
    { weekday: 2, startMin: 0, endMin: 120 },
    { weekday: 0, startMin: 1320, endMin: 1440 },
    { weekday: 1, startMin: 0, endMin: 120 },
  ]);
  assert.deepEqual(legacyHoursToRules({ days: [6], from: '21:00', to: '00:00' }), [
    { weekday: 0, startMin: 1260, endMin: 1440 },
  ]);
  assert.deepEqual(legacyHoursToRules({ days: [0], from: 'invalid', to: '02:00' }), []);
});

test('availability update keeps the expected version beside the schedule and sends legacy confirmation only when checked', () => {
  const schedule = sample();
  assert.deepEqual(scheduleUpdateBody(schedule, 0), { schedule, expectedVersion: 0 });
  assert.deepEqual(scheduleUpdateBody(schedule, 0, true), { schedule, expectedVersion: 0, confirmLegacyPreview: true });
});

test('booking confirmation sends only the quote reference and idempotency header', () => {
  assert.deepEqual(bookingConfirmationBody('quote-123'), { quoteId: 'quote-123', policyAccepted: true });
  assert.deepEqual(bookingIdempotencyHeaders('request-123'), { 'Idempotency-Key': 'request-123' });
});
