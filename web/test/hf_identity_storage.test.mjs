// Run in CI with Node's test runner and the existing TypeScript dependency.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

function storage(seed = {}) {
  const values = { ...seed };
  return new Proxy(values, { get(target, key) {
    if (key === 'getItem') return name => target[name] ?? null;
    if (key === 'setItem') return (name, value) => { target[name] = value; };
    if (key === 'removeItem') return name => { delete target[name]; };
    return target[key];
  } });
}
async function load(file, { pathname = '/wallet', seed = {}, posthog = {}, guestIssued = 'g1.new' } = {}) {
  const localStorage = storage(seed);
  const exports = {};
  const window = { localStorage, sessionStorage: storage(), location: { pathname }, innerWidth: 800,
    innerHeight: 600, addEventListener() {}, dispatchEvent() {} };
  const source = (await readFile(new URL(`../src/lib/${file}`, import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
    esModuleInterop: true,
  } }).outputText;
  // Expose the private issuer only in this isolated test module to exercise the real write path.
  vm.runInNewContext(output + '\nexports.issueGuestForTest = typeof createGuest === \"function\" ? createGuest : undefined;', { exports, localStorage, window, location: window.location,
    setTimeout, console, require: name => {
      if (name === 'posthog-js') return posthog;
      if (name === './apiClient') return { request: async () => ({ guest_token: guestIssued }) };
      if (name === './embed') return { installEmbedBridge: () => null };
      return new Proxy({}, { get: () => () => {} });
    } });
  return { api: exports, localStorage };
}

test('STORE-04: HF ignores and purges stale guest tokens; native host tokens still work', async () => {
  const { api, localStorage } = await load('clerk.tsx', { seed: {
    saathum_guest_jwt: 'g1.old', ph_email_old: 'old@example.test', unrelated: 'keep',
  } });
  assert.equal(await api.getActiveToken(), null);
  assert.equal(localStorage.getItem('saathum_guest_jwt'), null);
  assert.equal(localStorage.getItem('ph_email_old'), null);
  assert.equal(localStorage.getItem('unrelated'), 'keep');
  api.setHostTokenProvider(async () => 'current-native-token');
  assert.equal(await api.getActiveToken(), 'current-native-token');
  api.setHostTokenProvider(null);
  assert.equal(await api.getActiveToken({ skipCache: true }), null);
});

test('STORE-06: reachable legacy guide routes retain their existing fallback until coordinated migration', async () => {
  for (const pathname of ['/pandit', '/pandit/', '/talk', '/talk/']) {
    const { api } = await load('clerk.tsx', { pathname, seed: { saathum_guest_jwt: 'g1.legacy' } });
    assert.equal(await api.getActiveToken(), 'g1.legacy');
    assert.equal(await api.getActiveToken({ skipCache: true }), null);
    api.clearLegacyIdentityStorage();
    assert.equal(await api.getActiveToken(), null);
  }
});

test('STORE-05: telemetry uses current identity without saving email, and clears it on logout', async () => {
  let config;
  const registered = [];
  const posthog = { init: (_key, options) => { config = options; }, register: props => registered.push(props),
    unregister() {}, identify() {}, reset() {} };
  const { api, localStorage } = await load('analyticsCore.ts', { posthog, seed: { ph_email_old: 'old@example.test' } });
  api.initAnalytics();
  assert.equal(config.persistence, 'memory');
  api.identify('current', { email: 'current@example.test' });
  assert.equal(config.before_send({ properties: {} }).properties.email, 'current@example.test');
  assert.equal(registered.some(props => 'email' in props), false);
  assert.equal(Object.values(localStorage).some(value => String(value).includes('@')), false);
  api.reset();
  assert.equal(config.before_send({ properties: { email: 'old@example.test' } }).properties.email, undefined);
});


test('STORE-06: newly minted legacy tokens remain visible to existing guide readers', async () => {
  for (const pathname of ['/pandit', '/talk']) {
    const { api, localStorage } = await load('clerk.tsx', { pathname });
    await api.issueGuestForTest('guest@example.test');
    assert.equal(await api.getActiveToken(), 'g1.new');
    assert.equal(localStorage.getItem('saathum_guest_jwt'), 'g1.new');
    localStorage.removeItem('saathum_guest_jwt');
    assert.equal(await api.getActiveToken(), 'g1.new'); // module token wins
  }
});

test('STORE-04/06: entering HF clears legacy credentials and returning requires reauthentication', async () => {
  const legacy = await load('clerk.tsx', { pathname: '/talk' });
  await legacy.api.issueGuestForTest('guest@example.test');
  const hf = await load('clerk.tsx', { pathname: '/wallet', seed: { ...legacy.localStorage } });
  assert.equal(await hf.api.getActiveToken(), null);
  assert.equal(hf.localStorage.getItem('saathum_guest_jwt'), null);
  const returned = await load('clerk.tsx', { pathname: '/talk', seed: { ...hf.localStorage } });
  assert.equal(await returned.api.getActiveToken(), null);
  // Similar-looking HF booking routes are not the legacy /talk page.
  const booking = await load('clerk.tsx', { pathname: '/talk/booking-123', seed: { saathum_guest_jwt: 'g1.old' } });
  assert.equal(await booking.api.getActiveToken(), null);
});
