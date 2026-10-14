import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingsOnDay, calendarDays, collectBookingPages, dayEnd, localDayKey } from '../src/lib/hfBookingCalendar.ts';
import type { HfBooking } from '../src/lib/hfBookingsApi.ts';

const booking = (id: string, start: Date, end: Date): HfBooking => ({
  id, startUtc: start.toISOString(), endUtc: end.toISOString(), status: 'confirmed',
  hostUid: 'host', customerUid: 'customer', hostTimezone: 'Asia/Kolkata', reservedPaise: 100,
});

test('month includes complete Sunday-first weeks across year boundaries', () => {
  const days = calendarDays(new Date(2026, 11, 12));
  assert.equal(localDayKey(days[0]), '2026-11-29');
  assert.equal(localDayKey(days.at(-1)!), '2027-01-02');
  assert.equal(days.length % 7, 0);
  assert.equal(localDayKey(dayEnd(days.at(-1)!)), '2027-01-03');
});

test('overnight appointments appear on both days but midnight end is exclusive', () => {
  const before = new Date(2026, 9, 31, 23, 30);
  const midnight = new Date(2026, 10, 1);
  const after = new Date(2026, 10, 1, 0, 30);
  const rows = [booking('overnight', before, after), booking('midnight-end', before, midnight)];
  assert.deepEqual(bookingsOnDay(rows, before).map(row => row.id), ['midnight-end', 'overnight']);
  assert.deepEqual(bookingsOnDay(rows, midnight).map(row => row.id), ['overnight']);
});

test('day boundaries follow local civil dates through DST, not fixed durations', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const spring = new Date(2026, 2, 8);
    const autumn = new Date(2026, 10, 1);
    assert.equal(dayEnd(spring).getTime() - spring.getTime(), 23 * 3600000);
    assert.equal(dayEnd(autumn).getTime() - autumn.getTime(), 25 * 3600000);
    const row = booking('late', new Date(2026, 2, 8, 23), new Date(2026, 2, 9));
    assert.equal(bookingsOnDay([row], spring).length, 1);
    assert.equal(bookingsOnDay([row], dayEnd(spring)).length, 0);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('loads every page beyond 50 rows and deduplicates IDs', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => booking(String(index), new Date(2026, 9, 1, 10), new Date(2026, 9, 1, 11)));
  const cursors: (string | undefined)[] = [];
  const result = await collectBookingPages(async cursor => {
    cursors.push(cursor);
    return !cursor ? { bookings: rows.slice(0, 50), nextCursor: 'second' }
      : cursor === 'second' ? { bookings: rows.slice(49, 100), nextCursor: 'third' }
      : { bookings: rows.slice(100) };
  }, () => true);
  assert.deepEqual(cursors, [undefined, 'second', 'third']);
  assert.equal(result.rows.length, 101);
  assert.equal(result.error, undefined);
});

test('partial failure and repeated cursors keep loaded rows with an explicit error', async () => {
  const row = booking('one', new Date(2026, 9, 1), new Date(2026, 9, 2));
  const failure = new Error('offline');
  const partial = await collectBookingPages(async cursor => {
    if (cursor) throw failure;
    return { bookings: [row], nextCursor: 'next' };
  }, () => true);
  assert.equal(partial.error, failure);
  assert.equal(partial.rows.length, 1);
  const repeated = await collectBookingPages(async () => ({ bookings: [row], nextCursor: 'same' }), () => true);
  assert.ok(repeated.error);
  assert.equal(repeated.rows.length, 1);
});

test('a month/account change discards pending data and stops pagination', async () => {
  let current = true;
  let requests = 0;
  const result = await collectBookingPages(async () => {
    requests++;
    current = false;
    return { bookings: [booking('old-account', new Date(2026, 9, 1), new Date(2026, 9, 2))], nextCursor: 'next' };
  }, () => current);
  assert.deepEqual(result.rows, []);
  assert.equal(requests, 1);
});


test('an endless sequence of unique cursors stops with an explicit partial error', async () => {
  let requests = 0;
  const result = await collectBookingPages(async () => {
    requests++;
    return {
      bookings: [booking(String(requests), new Date(2026, 9, 1), new Date(2026, 9, 2))],
      nextCursor: String(requests),
    };
  }, () => true);
  assert.equal(requests, 100);
  assert.equal(result.rows.length, 100);
  assert.ok(result.error);
});
