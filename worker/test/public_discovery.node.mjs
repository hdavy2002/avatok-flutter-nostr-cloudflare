// Native Node >=22.15 test: node --test worker/test/public_discovery.node.mjs
// No bundler, compilation, Worker runtime or external services. The route uses
// real SQLite SQL; only the shared HTTP json helper is replaced to avoid loading
// its unrelated AI-provider dependency tree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../util' && context.parentURL?.endsWith('/routes/sitemap.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export function json(data,status=200){return Response.json(data,{status})}' };
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { publicListingEligibilitySql, publicDiscoveryReasonSql, publicDiscoveryProjection, sitemapPage } = await import('../src/lib/public_discovery.ts');
const { sitemapListings, sitemapCreators, sitemapManifest } = await import('../src/routes/sitemap.ts');
const NOW = Date.now();

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (uid TEXT PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE listings (id TEXT PRIMARY KEY, title TEXT, creator_id TEXT, slug TEXT, kind TEXT, status TEXT,
      starts_at INTEGER, duration_min INTEGER, expires_at INTEGER, attrs TEXT, is_example INTEGER, updated_at INTEGER);`);
  const user = db.prepare('INSERT INTO users VALUES (?,?)');
  for (const name of ['normal', 'examples', 'hidden', 'ended', 'mixed']) user.run(name, name);
  const insert = db.prepare('INSERT INTO listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const add = (id, overrides = {}) => {
    const r = { id, title: `Title ${id}`, creator_id: 'normal', slug: id, kind: 'consult', status: 'published', starts_at: null,
      duration_min: 60, expires_at: null, attrs: null, is_example: 0, updated_at: NOW, ...overrides };
    insert.run(...Object.values(r));
  };
  const env = { DB_META: { prepare(sql) {
    // D1 positional ?1 bindings correspond to named numeric parameters in node:sqlite.
    const statement = db.prepare(sql);
    let params = {};
    return { bind(...values) { params = Object.fromEntries(values.map((v, i) => [`?${i + 1}`, v])); return this; },
      async all() { return { success: true, results: statement.all(params) }; },
      async first() { return statement.get(params) ?? null; } };
  } } };
  return { db, add, env };
}
const req = (query = '') => new Request(`https://api.example/api/sitemap/listings${query}`);

test('one SQL predicate rejects examples, hidden, closed, expired and unpublished rows', () => {
  const { db, add } = fixture();
  add('public');
  add('example', { is_example: 1 });
  add('hidden', { attrs: '{"hide_from_marketplace":true}' });
  add('hidden_numeric', { attrs: '{"hide_from_marketplace":1}' });
  add('malformed_attrs', { attrs: '{broken' });
  add('completed', { status: 'completed' });
  add('cancelled', { status: 'cancelled' });
  add('expired', { expires_at: NOW - 1 });
  add('expired_seconds', { expires_at: Math.floor(NOW / 1000) - 1 });
  add('future_seconds', { expires_at: Math.floor(NOW / 1000) + 3600 });
  add('ended_event', { kind: 'live_event', starts_at: NOW - 3_600_000 });
  add('live', { kind: 'live_event', status: 'live', starts_at: NOW - 3_600_000 });
  for (const status of ['draft', 'pending_review', 'approved', 'rejected']) add(status, { status });
  const rows = db.prepare(`SELECT id, ${publicDiscoveryReasonSql('l', '?1')} AS reason FROM listings l ORDER BY id`).all({ '?1': NOW });
  const reasons = Object.fromEntries(rows.map(r => [r.id, r.reason]));
  assert.equal(reasons.example, 'example');
  assert.equal(reasons.hidden, 'hidden');
  assert.equal(reasons.hidden_numeric, 'hidden');
  assert.equal(reasons.completed, 'ended');
  assert.equal(reasons.cancelled, 'cancelled');
  assert.equal(reasons.expired, 'expired');
  assert.equal(reasons.expired_seconds, 'expired');
  assert.equal(reasons.ended_event, 'ended');
  for (const status of ['draft', 'pending_review', 'approved', 'rejected']) assert.equal(reasons[status], 'unpublished');
  const eligible = db.prepare(`SELECT id FROM listings l WHERE ${publicListingEligibilitySql('l', '?1')} ORDER BY id`).all({ '?1': NOW });
  assert.deepEqual(eligible.map(r => r.id), ['future_seconds', 'live', 'malformed_attrs', 'public']);
  db.close();
});

test('projection exposes only safe keys and valid modification timestamps', () => {
  assert.deepEqual(publicDiscoveryProjection({ reason: 'hidden', updated_at: 1789084800, attrs: 'private' }), {
    indexable: false, reason: 'hidden', updated_at: 1789084800000,
  });
  assert.deepEqual(publicDiscoveryProjection({ reason: 'unpublished', updated_at: null }), { indexable: false });
  assert.deepEqual(publicDiscoveryProjection({ reason: null, updated_at: 'bad' }), { indexable: true });
  assert.deepEqual(publicDiscoveryProjection({ reason: null, updated_at: 9e18 }), { indexable: true });
});

test('pagination rejects malformed, duplicate and unbounded parameters', () => {
  assert.deepEqual(sitemapPage(), { page: 1, page_size: 10000, offset: 0 });
  assert.deepEqual(sitemapPage(req('?page=2&page_size=10')), { page: 2, page_size: 10, offset: 10 });
  for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=1e3', '?page=50001', '?page=999999999999999',
    '?page=1&page=2', '?page_size=10001', '?page_size=0', '?page_size=', '?page_size=1&page_size=2']) {
    assert.equal(sitemapPage(req(query)), null, query);
  }
});

test('creator feeds and manifest require an eligible listing; all page boundaries are stable', async () => {
  const { db, add, env } = fixture();
  add('b', { updated_at: NOW - 1000 });
  add('a');
  add('c', { creator_id: 'mixed' });
  add('sample', { creator_id: 'examples', is_example: 1 });
  add('secret', { creator_id: 'hidden', attrs: '{"hide_from_marketplace":1}' });
  add('old', { creator_id: 'ended', status: 'completed' });
  add('mixed_secret', { creator_id: 'mixed', attrs: '{"hide_from_marketplace":1}' });
  const manifest = await (await sitemapManifest(env, req('?page_size=2'))).json();
  assert.deepEqual(manifest, { page_size: 2, listings: { count: 3, pages: 2 }, creators: { count: 2, pages: 1 } });
  const first = await (await sitemapListings(env, req('?page_size=2'))).json();
  const second = await (await sitemapListings(env, req('?page=2&page_size=2'))).json();
  assert.deepEqual(first.listings.map(r => r.id), ['a', 'b']);
  assert.deepEqual(second.listings.map(r => r.id), ['c']);
  assert.equal(first.has_more, true);
  assert.equal(second.has_more, false);
  const creators = await (await sitemapCreators(env)).json();
  assert.deepEqual(creators.creators.map(r => r.handle), ['mixed', 'normal']);
  assert.equal((await sitemapListings(env, req('?page=0'))).status, 400);
  db.close();
});

test('over 10,000 eligible rows are reachable without duplicate or omitted boundaries', async () => {
  const { db, add, env } = fixture();
  db.exec('BEGIN');
  for (let i = 0; i < 10003; i++) add(String(i).padStart(5, '0'));
  db.exec('COMMIT');
  const first = await (await sitemapListings(env)).json();
  const second = await (await sitemapListings(env, req('?page=2'))).json();
  assert.equal(first.listings.length, 10000);
  assert.equal(first.listings.at(-1).id, '09999');
  assert.deepEqual(second.listings.map(r => r.id), ['10000', '10001', '10002']);
  const manifest = await (await sitemapManifest(env)).json();
  assert.deepEqual(manifest.listings, { count: 10003, pages: 2 });
  db.close();
});

test('database failures do not turn into successful empty sitemap data', async () => {
  const unavailable = { DB_META: { prepare() { throw new Error('offline'); } } };
  for (const route of [sitemapListings, sitemapCreators, sitemapManifest]) await assert.rejects(() => route(unavailable), /offline/);
  const failed = { DB_META: { prepare() { return { bind() { return this; }, async all() { return { success: false }; }, async first() { return null; } }; } } };
  for (const route of [sitemapListings, sitemapCreators, sitemapManifest]) await assert.rejects(() => route(failed), /unavailable/);
});
