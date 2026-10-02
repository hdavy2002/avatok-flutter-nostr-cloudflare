// [AUMFE-CONSULT-F2-1 2026-10-02] Pure-logic tests for the booking wizard.
// node:test, like the rest of web/test (no vitest in web). Run: node --experimental-strip-types --test web/test/consult_book_logic.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bhagyank, buildIcs, dayParts, digitRoot, frameStats, isSharp, lightVerdict, mmss, moolank, photoKinds, tarotIntake,
  tarotProblem, toDeva,
} from '../src/islands/consult-book/bookLogic.ts';

test('numerology: mockup example 9 Mar 1987 is Moolank 9, Bhagyank 1', () => {
  assert.equal(moolank('1987-03-09'), 9);
  assert.equal(bhagyank('1987-03-09'), 1);
  assert.equal(toDeva(9), '९');
  assert.equal(toDeva(1), '१');
  assert.equal(digitRoot(29), 2);
  assert.equal(moolank('nope'), null);
});

test('ics has the required fields and CRLF line endings', () => {
  const ics = buildIcs({ uid: 'b1', title: 'Call, with; Gurdev', startMs: 1_791_000_000_000, endMs: 1_791_001_800_000, description: 'x', prodId: 'Test' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Call\\, with\; Gurdev\r\n/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z\r\n/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('frame quality: flat dark frame is dark and not sharp; checkerboard is sharp', () => {
  const w = 32, h = 32;
  const flat = new Uint8ClampedArray(w * h * 4).fill(20);
  const a = frameStats(flat, w, h);
  assert.equal(lightVerdict(a.brightness), 'dark');
  assert.equal(isSharp(a.sharpness), false);
  const board = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (x + y) % 2 ? 230 : 40; const p = (y * w + x) * 4; board[p] = board[p + 1] = board[p + 2] = v; board[p + 3] = 255; }
  const b = frameStats(board, w, h);
  assert.equal(lightVerdict(b.brightness), 'ok');
  assert.equal(isSharp(b.sharpness), true);
});

test('tarot intake carries card ids and the optional yes/no card', () => {
  const f = { name: 'A', dob: '', question: 'Q?', picks: [5, 40, 78], reversed: [false, true, false], yesNo: true, yesNoCard: 12 };
  assert.equal(tarotProblem(f), null);
  const i = tarotIntake(f);
  assert.deepEqual(i.cards, { love: 5, career: 40, finance: 78 });
  assert.deepEqual(i.yes_no, { question: 'Q?', card: 12 });
  assert.match(tarotProblem({ ...f, yesNoCard: null }) ?? '', /draw/);
});

test('helpers', () => {
  assert.deepEqual(dayParts('2026-10-06'), { dow: 'Tue', day: 6 });
  assert.equal(mmss(61_000), '1:01');
  assert.equal(photoKinds('palmistry', 'left')[0].kind, 'palm_left');
  assert.equal(photoKinds('astrology', 'right').length, 0);
});
