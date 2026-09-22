// [SHV2-S3] Pure-logic tests for the event shelves island's helpers
// (contracts.md §6a: node:test + node:assert/strict, no vitest — this is the
// only test runner CI actually invokes for web/).
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionFor, formatLocalStart, visibleFieldsFor } from '../src/islands/home/shelfFormat.ts';

test('formatLocalStart returns null when there is no start time', () => {
  assert.equal(formatLocalStart(null), null);
  assert.equal(formatLocalStart(0), null);
});

test('formatLocalStart produces a machine-readable ISO string and a visible zone label', () => {
  const ms = Date.UTC(2026, 9, 5, 14, 30);
  const result = formatLocalStart(ms);
  assert.ok(result);
  assert.equal(result?.iso, new Date(ms).toISOString());
  assert.ok((result?.zone.length ?? 0) > 0);
  assert.ok((result?.label.length ?? 0) > 0);
});

test('actionFor says Join now only when joinable, never a third label', () => {
  const joinable = actionFor(true, '/l/evt_1');
  assert.deepEqual(joinable, { label: 'Join now', href: '/l/evt_1', cta: 'join_now' });

  const notJoinable = actionFor(false, '/l/evt_1');
  assert.deepEqual(notJoinable, { label: 'View details', href: '/l/evt_1', cta: 'view_details' });
});

test('visibleFieldsFor only adds language/duration when the tile would otherwise hide them (poster-first)', () => {
  assert.deepEqual(visibleFieldsFor(true), { showLanguage: true, showDuration: true });
  assert.deepEqual(visibleFieldsFor(false), { showLanguage: false, showDuration: false });
});
