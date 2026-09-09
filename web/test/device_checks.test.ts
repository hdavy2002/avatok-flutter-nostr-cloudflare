import assert from 'node:assert/strict';
import test from 'node:test';
import { rmsLevel, SpeakerTone } from '../src/components/audioDeviceChecks.ts';

test('rmsLevel reports silence, signal, and clamps loud input', () => {
  assert.equal(rmsLevel(new Uint8Array([128, 128, 128])), 0);
  assert.equal(rmsLevel(new Uint8Array([0, 255, 0, 255])), 1);
});

test('rmsLevel accepts empty analyzer data', () => {
  assert.equal(rmsLevel(new Uint8Array()), 0);
});

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeContext(resume = Promise.resolve(), failGain = false) {
  const calls = { close: 0, start: 0, stop: 0, disconnect: 0, resume: 0 };
  const gain = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() { calls.disconnect++; } };
  const oscillator = { frequency: { value: 0 }, connect() { return gain; }, start() { calls.start++; }, stop() { calls.stop++; }, disconnect() { calls.disconnect++; } };
  const context = {
    state: 'running', currentTime: 0, destination: {},
    resume() { calls.resume++; return resume; },
    close() { calls.close++; return Promise.resolve(); },
    createOscillator() { return oscillator; },
    createGain() { if (failGain) throw new Error('device'); return gain; },
  } as unknown as AudioContext;
  return { context, calls };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('speaker stop cancels pending resume before any sound can start', async () => {
  const wait = deferred(); const fake = fakeContext(wait.promise);
  const tone = new SpeakerTone(() => fake.context, () => {});
  tone.start(); assert.equal(fake.calls.resume, 1);
  tone.stop(); wait.resolve(); await flush();
  assert.equal(fake.calls.start, 0); assert.equal(fake.calls.close, 1);
  tone.dispose();
});

test('speaker repeated start has one owner and disposal releases sound', async () => {
  const fake = fakeContext(); let creations = 0;
  const tone = new SpeakerTone(() => { creations++; return fake.context; }, () => {});
  tone.start(); tone.start(); await flush();
  assert.equal(creations, 1); assert.equal(fake.calls.start, 1);
  tone.dispose(); assert.equal(fake.calls.stop, 1); assert.equal(fake.calls.close, 1);
  tone.start(); assert.equal(creations, 1);
});

test('speaker partial creation failure closes context and supports retry', async () => {
  const bad = fakeContext(Promise.resolve(), true); const good = fakeContext();
  const states: Array<{error: string | null}> = []; let attempt = 0;
  const tone = new SpeakerTone(() => attempt++ === 0 ? bad.context : good.context, (s) => states.push(s));
  tone.start(); await flush(); assert.equal(bad.calls.close, 1); assert.ok(states.at(-1)?.error);
  tone.start(); await flush(); assert.equal(good.calls.start, 1); tone.dispose();
});

test('stale resume failure cannot close a newer speaker test', async () => {
  const wait = deferred(); const old = fakeContext(wait.promise); const next = fakeContext(); let attempt = 0;
  const tone = new SpeakerTone(() => attempt++ === 0 ? old.context : next.context, () => {});
  tone.start(); tone.stop(); tone.start(); await flush(); wait.reject(); await flush();
  assert.equal(next.calls.start, 1); assert.equal(next.calls.close, 0); tone.dispose();
});

test('disposing pending speaker playback prevents late UI updates', async () => {
  const wait = deferred(); const fake = fakeContext(wait.promise); let updates = 0;
  const tone = new SpeakerTone(() => fake.context, () => { updates++; });
  tone.start(); tone.dispose(); const before = updates; wait.resolve(); await flush();
  assert.equal(updates, before); assert.equal(fake.calls.start, 0);
});
