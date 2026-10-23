// [HF-CALL-MODES-E1] callState -> buttons mapping (spec 2.1) and the small helpers.
// @ts-ignore vitest is installed in worker/node_modules only (same as hfPayoutApi.test.ts)
import { describe, it, expect } from 'vitest';
import { deriveCallState, fanButtons, lengthLabel, offeredLengths, offlineWarning, minutesLeft, queueJoinProblem, refusalText } from './hfCallModes';

describe('fanButtons (spec 2.1 table)', () => {
  it('available: Call now (+ Book a time)', () => {
    expect(fanButtons('available', true, true)).toMatchObject({ callNow: true, queue: false, book: true, notify: false, badge: 'Online' });
  });
  it('on_call: On a call + Book a time + Join the queue', () => {
    expect(fanButtons('on_call', true, true)).toMatchObject({ callNow: false, queue: true, book: true, notify: false, badge: 'On a call' });
  });
  it('connecting and queue_only: shown Online, Join the queue', () => {
    expect(fanButtons('connecting', true, true)).toMatchObject({ callNow: false, queue: true, badge: 'Online' });
    expect(fanButtons('queue_only', false, true)).toMatchObject({ callNow: false, queue: true, book: false });
  });
  it('appointments: Available by appointment + Book a time + Notify me', () => {
    expect(fanButtons('appointments', true, true)).toMatchObject({ badge: 'Available by appointment', book: true, notify: true, queue: false, callNow: false });
  });
  it('offline: Offline + Notify me, no booking', () => {
    expect(fanButtons('offline', true, true)).toMatchObject({ badge: 'Offline', notify: true, book: false, queue: false, callNow: false });
  });
  it('queue flag off: an on-call host falls back to Notify me, like today', () => {
    expect(fanButtons('on_call', true, false)).toMatchObject({ queue: false, notify: true });
  });
  it('booking flag off hides Book a time everywhere', () => {
    for (const s of ['available', 'on_call', 'appointments'] as const) expect(fanButtons(s, false, true).book).toBe(false);
  });
});

describe('deriveCallState', () => {
  it('trusts a known callState', () => { expect(deriveCallState('offline', 'queue_only')).toBe('queue_only'); });
  it('falls back to legacy presence', () => {
    expect(deriveCallState('online')).toBe('available');
    expect(deriveCallState('busy')).toBe('on_call');
    expect(deriveCallState(undefined)).toBe('offline');
    expect(deriveCallState('online', 'garbage')).toBe('available');
  });
});

describe('helpers', () => {
  it('lengthLabel', () => {
    expect([15, 30, 60, 120, 180, 240, 300].map(lengthLabel)).toEqual(['15 min', '30 min', '1 h', '2 h', '3 h', '4 h', '5 h']);
    expect(lengthLabel(90)).toBe('1 h 30 min');
  });
  it('offeredLengths narrows to the allowed list, full list when empty', () => {
    expect(offeredLengths([10, 15, 60])).toEqual([15, 60]);
    expect(offeredLengths([10])).toHaveLength(7);
    expect(offeredLengths(null)).toHaveLength(7);
  });
  it('offlineWarning only with booked calls', () => {
    expect(offlineWarning(0)).toBeNull();
    expect(offlineWarning(1)).toBe('You have 1 booked call. They will still ring.');
    expect(offlineWarning(3)).toBe('You have 3 booked calls. They will still ring.');
  });
  it('minutesLeft', () => {
    const now = 1_000_000_000_000;
    expect(minutesLeft(now + 4 * 60_000, now)).toBe(4);
    expect(minutesLeft(now + 5_000, now)).toBe(1);
    expect(minutesLeft(null, now)).toBeNull();
  });
  it('queueJoinProblem maps each error to friendly text', () => {
    expect(queueJoinProblem('already_queued', { hostSlug: 'asha' }, 'Asha', '').link?.href).toBe('/h/asha');
    expect(queueJoinProblem('low_balance', { shortfallPaise: 1500 }, 'Asha', '').text).toContain('₹15');
    expect(queueJoinProblem('not_verified', {}, 'Asha', '').link?.href).toContain('/sign-up');
    expect(queueJoinProblem('queue_full', {}, 'Asha', '').text).toContain('full');
    expect(queueJoinProblem('weird', {}, 'Asha', 'Oops').text).toBe('Oops');
  });
  it('refusalText', () => {
    expect(refusalText('on_call', 'Asha')).toBe('Asha is on a call right now.');
    expect(refusalText('x', 'Asha')).toBeNull();
  });
});
