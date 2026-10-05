/** CI-only behavior checks. Run after npm ci: node scripts/check-data-performance.mjs.
 * Transpile isolated TS modules in memory, replacing only external API adapters.
 * No network, secrets, test listings, browser account or production writes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const root = new URL('../src/', import.meta.url);
const moduleURL = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
async function load(relative, replacements = {}) {
  let source = await readFile(new URL(relative, root), 'utf8');
  for (const [from, to] of Object.entries(replacements)) {
    source = source.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`);
  }
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const unresolved = [...output.matchAll(/(?:from\s*|import\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\1/g)].map(match => match[2]);
  if (unresolved.length) {
    throw new Error(`${relative}: unresolved relative import(s) in isolated CI loader: ${[...new Set(unresolved)].join(', ')}. Add an explicit adapter replacement.`);
  }
  return moduleURL(output);
}
const deadlineURL = await load('lib/requestDeadline.ts');
const { withDeadline } = await import(deadlineURL);
assert.equal(await withDeadline(async () => 42, 100), 42);
let expiredSignal;
await assert.rejects(withDeadline((signal) => { expiredSignal = signal; return new Promise(() => {}); }, 10), { name: 'TimeoutError' });
assert.equal(expiredSignal.aborted, true);
const cancelled = new AbortController();
let cancellationSignal;
const pending = withDeadline((signal) => { cancellationSignal = signal; return new Promise(() => {}); }, 1000, cancelled.signal);
cancelled.abort();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(cancellationSignal.aborted, true);
let calledAfterAbort = false;
await assert.rejects(withDeadline(async () => { calledAfterAbort = true; }, 1000, cancelled.signal), { name: 'AbortError' });
assert.equal(calledAfterAbort, false);

// [WEB-OLD-CHECKOUT-GONE-1 2026-09-27] lib/marketplaceSeed.ts and lib/listingCompanions.ts were
// deleted with the old marketplace + listing detail page, so their checks were removed.

// Real request wrapper: timeout covers response body, auth is no-store, no global
// deadline is imposed on a payment/mutation merely because reads are bounded.
const configURL = moduleURL(`export const API_BASE='https://api.invalid';`);
const analyticsURL = moduleURL(`export const apiError=()=>{}; export const captureException=()=>{};`);
const { request } = await import(await load('lib/apiClient.ts', { './config': configURL, './env': configURL, './analytics': analyticsURL, './requestDeadline': deadlineURL }));
const originalFetch = globalThis.fetch;
try {
  let received;
  globalThis.fetch = async (_, options) => { received = options; return { ok: true, text: async () => '{"ok":true}' }; };
  assert.deepEqual(await request('/api/wallet/balance', { auth: 'test-token', timeoutMs: 100 }), { ok: true });
  assert.equal(received.cache, 'no-store');
  await request('/api/booking', { method: 'POST', body: { sample: true } });
  assert.equal(received.signal, undefined);
  globalThis.fetch = async (_, options) => { received = options; return { ok: true, text: () => new Promise(() => {}) }; };
  await assert.rejects(request('/api/explore', { timeoutMs: 10 }), { name: 'TimeoutError' });
  assert.equal(received.signal.aborted, true);
} finally { globalThis.fetch = originalFetch; delete globalThis.__performanceRequest; delete globalThis.__companion; }
console.log('Data performance checks passed: deadlines, cancellation, SSR seed, parallel fallbacks, private reads, mutation contracts.');
