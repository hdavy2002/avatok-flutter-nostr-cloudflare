import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitAgeRecovery } from '../src/lib/hfAgeRecovery.ts';

test('AGE-04 explicit age recovery never acknowledges on cancellation', async () => {
  let acknowledgements = 0;
  const message = await explicitAgeRecovery(() => false, async () => { acknowledgements++; return { ok: true }; });
  assert.equal(acknowledgements, 0);
  assert.match(message, /confirm.*18/);
});
test('AGE-04 affirmative recovery saves once and asks for a new attempt', async () => {
  let acknowledgements = 0;
  const message = await explicitAgeRecovery(() => true, async () => { acknowledgements++; return { ok: true }; });
  assert.equal(acknowledgements, 1);
  assert.match(message, /try your call or booking again/);
});
test('AGE-04 failed acknowledgement remains actionable', async () => {
  assert.equal(await explicitAgeRecovery(() => true, async () => ({ ok: false, message: 'Please try again later.' })), 'Please try again later.');
  assert.match(await explicitAgeRecovery(() => true, async () => { throw new Error('network'); }), /could not save/);
});
