// CI-only contract checks. Run after build; never invoked by a push trigger.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const home = read('src/pages/index.astro');
const motion = read('src/styles/motion.css');
const resting = motion.match(/\.t-stagger-line\s*\{([^}]+)\}/)?.[1] ?? '';
assert.match(resting, /opacity:\s*1\s*;/);
assert.match(resting, /transform:\s*none\s*;/);
assert.match(resting, /filter:\s*none\s*;/);
assert.doesNotMatch(read('src/lib/railwayHome.ts'), /classList\.add\('is-shown'\)/);
assert.match(home, /imagesrcset=\{heroSrcSet\}/);
assert.match(home, /srcset=\{heroSrcSet\}/);
// Font ownership is validated from the built page by the Fonts component; the
// source files may include route-specific fallbacks for standalone previews.
assert.doesNotMatch(read('src/styles/global.css'), /font-family:\s*'Nunito';[\s\S]*?src:\s*url\('\/fonts\/Nunito/);
assert.match(read('src/components/Fonts.astro'), /Baloo\+2/);
assert.match(read('src/components/Fonts.astro'), /display=swap/);

const built = ['dist/index.html', 'dist/client/index.html'].map((p) => resolve(root, p)).find(existsSync);
assert(built, 'run after the Astro build: homepage artifact required');
if (built) {
  const html = readFileSync(built, 'utf8');
  assert.match(html, /id="rail-title"/);
  assert.equal((html.match(/data-avatok-fonts/g) ?? []).length, 1, 'one font owner in emitted home');
  assert.match(html, /Apna hunar/);
}
const clientDir = ['dist/_astro', 'dist/client/_astro'].map((p) => resolve(root, p)).find(existsSync);
assert(clientDir, 'built browser chunks required');
if (clientDir) {
  const files = readdirSync(clientDir);
  assert(files.some((f) => f.startsWith('analyticsCore.') && f.endsWith('.js')), 'SDK must remain its own deferred chunk');
}

// Exercise the actual facade while the SDK load is stalled. Overflow may
// discard old samples, but must NEVER discard account transitions.
let releaseCore;
const corePromise = new Promise((r) => { releaseCore = r; });
const frames = [];
const delivered = [];
let active = null;
const fakeCore = {
  initAnalytics() {}, setTrace() {},
  identify(uid) { active = uid; }, reset() { active = null; },
  capture(name, props) { delivered.push({ name, props, uid: active }); },
  captureException() {},
};
const source = read('src/lib/analytics.ts').replace("import('./analyticsCore').then", '__loadCore().then');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const sandbox = {
  exports: {}, __loadCore: () => corePromise, crypto: { randomUUID: () => 'trace-test' },
  window: { setTimeout: () => 1 }, clearTimeout() {},
  requestAnimationFrame: (cb) => { frames.push(cb); },
};
vm.runInNewContext(outputText, sandbox);
const api = sandbox.exports;
api.identify('account-a', { email: 'a@example.test' });
for (let i = 0; i < 600; i++) api.capture('a', { i });
api.reset();
api.identify('account-b', { email: 'b@example.test' });
for (let i = 0; i < 100; i++) api.capture('b', { i });
assert.equal(api.currentDistinctUid(), 'account-b');
let actionRan = false;
await api.withTrace(() => { actionRan = true; });
assert(actionRan, 'user action cannot wait for telemetry');
while (frames.length) frames.shift()();
releaseCore(fakeCore);
await new Promise((r) => setImmediate(r));
assert.equal(delivered.length, 500);
assert(delivered.every((e) => e.uid === (e.name === 'a' ? 'account-a' : 'account-b')), 'queue must preserve event identity');
api.reset();
api.capture('signed-out');
assert.equal(delivered.at(-1).uid, null);
console.log('Render/font/telemetry readiness contracts passed; live FCP/CLS/font bytes require browser measurement.');

const clerk = read('src/lib/clerk.tsx');
// Token readiness polling is intentional: Clerk can publish auth state after the
// dashboard islands mount, so the waited helper must yield briefly between reads.
assert.match(clerk, /export async function getActiveToken\(/);
assert.match(clerk, /export async function getActiveTokenWaited\(/);
assert.match(clerk, /export async function requireGuestAuth\(/);
console.log('Auth token bridge contracts passed.');
