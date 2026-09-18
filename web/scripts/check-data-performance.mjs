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
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(`'${from}'`, `'${to}'`);
  return moduleURL(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
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

const adapterURL = moduleURL(`export const request = (...args) => globalThis.__performanceRequest(...args);`);
const { getMarketplaceSeed } = await import(await load('lib/marketplaceSeed.ts', { './apiClient': adapterURL }));
let calls = [];
globalThis.__performanceRequest = async (...args) => { calls.push(args); return { listings: [], cursor: null }; };
assert.deepEqual(await getMarketplaceSeed('  '), { page: { listings: [], cursor: null } });
assert.equal(calls[0][0], '/api/explore');
assert.deepEqual(calls[0][1].query, { limit: 24, examples: 1 });
assert.equal(calls[0][1].auth, undefined);
assert.ok(calls[0][1].timeoutMs > 0);
await getMarketplaceSeed('  singing lessons  ');
assert.equal(calls[1][0], '/api/explore/search');
assert.deepEqual(calls[1][1].query, { limit: 24, examples: 1, q: 'singing lessons' });
await getMarketplaceSeed(undefined, { timeoutMs: 15000 });
assert.equal(calls[2][1].timeoutMs, 15000, '[WEB-GATEWAY-FIX4] build-time Featured rail must pass its own timeout through');
const cards = [{ id: 'listing', title: 'A real result' }];
globalThis.__performanceRequest = async () => ({ listings: cards, cursor: 'page-2', section_counts: { live_streams: 1 } });
assert.equal((await getMarketplaceSeed()).page.cursor, 'page-2');
assert.deepEqual((await getMarketplaceSeed()).page.listings, cards);
globalThis.__performanceRequest = async () => { throw new Error('network'); };
const failure = await getMarketplaceSeed();
assert.ok(failure.error);
assert.equal(failure.page, undefined, 'failed SSR must not claim a genuine empty catalogue');

const companionURL = moduleURL(`
export const getListingReviews = (...args) => globalThis.__companion('reviews', ...args);
export const getListingSlots = (...args) => globalThis.__companion('slots', ...args);
export const getExplore = (...args) => globalThis.__companion('explore', ...args);
export const getCreator = (...args) => globalThis.__companion('creator', ...args);
`);
const { getListingCompanions } = await import(await load('lib/listingCompanions.ts', { './apiClient': companionURL, './requestDeadline': deadlineURL }));
let started = [];
let stalledSignal;
globalThis.__companion = (name, ...args) => {
  started.push(name);
  if (name === 'reviews') { stalledSignal = args.at(-1); return new Promise(() => {}); }
  if (name === 'slots') return Promise.reject(new Error('disabled'));
  if (name === 'explore') return Promise.resolve({ listings: cards });
  return Promise.resolve({ listings: cards, id: 'creator' });
};
const companions = getListingCompanions({ id: 'listing', creator: { uid: 'creator' } });
assert.deepEqual(started, ['reviews', 'slots', 'explore', 'creator'], 'all companions must begin before any resolves');
const partial = await companions;
assert.equal(stalledSignal.aborted, true);
assert.equal(partial.reviewList, null);
assert.equal(partial.slots, null);
assert.deepEqual(partial.browseMore, cards);
assert.deepEqual(partial.creatorListings, cards);

// Real request wrapper: timeout covers response body, auth is no-store, no global
// deadline is imposed on a payment/mutation merely because reads are bounded.
const configURL = moduleURL(`export const API_BASE='https://api.invalid';`);
const analyticsURL = moduleURL(`export const apiError=()=>{}; export const captureException=()=>{};`);
const { request } = await import(await load('lib/apiClient.ts', { './config': configURL, './analytics': analyticsURL, './requestDeadline': deadlineURL }));
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
