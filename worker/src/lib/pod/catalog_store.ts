// [AUMFE-POD-COST-1 2026-10-01] The partner catalogue as the Studio sees it: stored rows in pod_catalog, refreshed from the
// partner automatically (a day old or empty), with the built-in manual catalogue only as a visible fallback.
// `shopPodProvider` only decides who PLACES orders; the catalogue comes from Printrove whenever its login is configured.
// The partner `sync` admin route and the daily cron share syncCatalogToDb(); nothing here is partner-field specific.
import type { Env } from '../../types';
import { track, trackException } from '../../hooks';
import { builtInCatalog, ManualProvider } from './manual';
import { PrintroveProvider, printroveLogin } from './printrove';
import type { CatalogProduct, CatalogVariant, PodProvider, PodProviderId } from './types';

const APP = 'saathum';
const BATCH = 50;
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_KEY = 'pod:printrove:sync_lock';
const LOCK_TTL_S = 120;
const FAIL_BACKOFF_MS = 5 * 60 * 1000;
const SHIP_KEY = 'pod:printrove:ship_ref';
export const SHIP_REF_PINCODE = '110001';
const SHIP_REF_WEIGHT_G = 500;

type CatRow = {
  provider: string; provider_product_id: string; kind: string; name: string; category: string | null;
  variants_json: string; size_chart_json: string | null; raw_json: string | null; synced_at: number;
};

const isNoTable = (e: unknown) => /no such table/i.test(String((e as { message?: string })?.message ?? e));

function parseCol<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return (JSON.parse(raw) as T) ?? fallback; } catch { return fallback; }
}

/** Stored catalogue rows for a provider (empty when nothing is synced or the table is missing). */
export async function loadStoredCatalog(env: Env, provider: PodProviderId): Promise<{ products: CatalogProduct[]; synced_at: number | null }> {
  let rows: CatRow[] = [];
  try {
    const r = await env.DB_META.prepare('SELECT * FROM pod_catalog WHERE provider=?1 ORDER BY kind, name').bind(provider).all<CatRow>();
    rows = r.results ?? [];
  } catch (e) {
    if (!isNoTable(e)) throw e;
  }
  let at: number | null = null;
  const products: CatalogProduct[] = rows.map((r) => {
    at = at === null ? Number(r.synced_at) : Math.max(at, Number(r.synced_at));
    const area = parseCol<{ print_area_in?: CatalogProduct['print_area_in'] } | null>(r.raw_json, null)?.print_area_in;
    return {
      provider, provider_product_id: r.provider_product_id, kind: r.kind, name: r.name, category: r.category,
      variants: parseCol<CatalogVariant[]>(r.variants_json, []), size_chart: parseCol<CatalogProduct['size_chart']>(r.size_chart_json, null),
      ...(area ? { print_area_in: area } : {}),
    };
  });
  return { products, synced_at: at };
}

/** Pull the partner's catalogue and store it (this sync is the whole truth: products no longer listed drop out). */
export async function syncCatalogToDb(env: Env, id: PodProviderId, provider?: PodProvider): Promise<{ count: number; synced_at: number; ms: number }> {
  const started = Date.now();
  const p = provider ?? (id === 'printrove' ? new PrintroveProvider(env) : new ManualProvider());
  const items = await p.syncCatalog();
  const now = Date.now();
  const stmt = env.DB_META.prepare(
    `INSERT INTO pod_catalog (provider, provider_product_id, kind, name, category, variants_json, size_chart_json, raw_json, synced_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?9,?8)
     ON CONFLICT(provider, provider_product_id) DO UPDATE SET kind=excluded.kind, name=excluded.name, category=excluded.category,
       variants_json=excluded.variants_json, size_chart_json=excluded.size_chart_json, raw_json=excluded.raw_json, synced_at=excluded.synced_at`,
  );
  const writes = items.map((x) => stmt.bind(
    x.provider, x.provider_product_id, x.kind, x.name, x.category, JSON.stringify(x.variants),
    x.size_chart ? JSON.stringify(x.size_chart) : null, now,
    x.print_area_in ? JSON.stringify({ print_area_in: x.print_area_in }) : null, // raw_json carries the partner's own print areas
  ));
  for (let i = 0; i < writes.length; i += BATCH) await env.DB_META.batch(writes.slice(i, i + BATCH));
  await env.DB_META.prepare('DELETE FROM pod_catalog WHERE provider=?1 AND synced_at < ?2').bind(id, now).run();
  return { count: items.length, synced_at: now, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Automatic refresh (request path and cron share this)
// ---------------------------------------------------------------------------
let failedAt = 0;
let failedReason = '';

/** True when the Printrove login is configured on the server. */
export const printroveConfigured = (env: Env): boolean => printroveLogin(env) !== null;

type AutoSync = { ok: true; count: number } | { ok: false; reason: string };

async function autoSync(env: Env): Promise<AutoSync> {
  if (failedAt && Date.now() - failedAt < FAIL_BACKOFF_MS) return { ok: false, reason: failedReason };
  try {
    if (await env.TOKENS.get(LOCK_KEY)) return { ok: false, reason: 'The Printrove catalogue is being refreshed right now.' };
  } catch { /* the lock is best-effort */ }
  try { await env.TOKENS.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL_S }); } catch { /* best-effort */ }
  try {
    const r = await syncCatalogToDb(env, 'printrove');
    failedAt = 0;
    try { await track(env, 'system', 'pod_catalog_auto_synced', APP, { count: r.count, ms: r.ms }); } catch { /* telemetry is best-effort */ }
    return { ok: true, count: r.count };
  } catch (e) {
    failedAt = Date.now();
    failedReason = 'Printrove did not answer the catalogue request.';
    await trackException(env, e, { route: 'pod/catalog_auto_sync', handled: true, app_name: APP });
    return { ok: false, reason: failedReason };
  } finally {
    try { await env.TOKENS.delete(LOCK_KEY); } catch { /* the TTL clears it */ }
  }
}

export type CatalogInfo = {
  products: CatalogProduct[];
  /** printrove = real partner rows; builtin = the manual estimate catalogue (no prices). */
  source: 'printrove' | 'builtin';
  /** Why the built-in catalogue is shown (null for the real one). */
  reason: string | null;
  synced_at: number | null;
};

/**
 * The catalogue for the Studio. Printrove rows when the login is configured (auto-synced when empty or older than 24 h);
 * the built-in manual catalogue only when Printrove is not configured or the sync fails and nothing is stored.
 * Stale stored rows are still preferred over the built-in ones when a refresh fails.
 */
export async function ensurePodCatalog(env: Env): Promise<CatalogInfo> {
  if (!printroveConfigured(env)) {
    return { products: builtInCatalog(), source: 'builtin', reason: 'Printrove is not connected yet.', synced_at: null };
  }
  let stored = await loadStoredCatalog(env, 'printrove');
  const age = stored.synced_at === null ? Infinity : Date.now() - stored.synced_at;
  if (!stored.products.length || age >= CATALOG_MAX_AGE_MS) {
    const r = await autoSync(env);
    if (r.ok) stored = await loadStoredCatalog(env, 'printrove');
    else if (!stored.products.length) return { products: builtInCatalog(), source: 'builtin', reason: r.reason, synced_at: null };
  }
  return { products: stored.products, source: 'printrove', reason: null, synced_at: stored.synced_at };
}

let lastCronCheck = 0;
/** Daily cron: refresh the stored catalogue when it is a day old. Cheap (one memo check, then one count query). Never throws. */
export async function runPodCatalogRefresh(env: Env): Promise<{ synced: boolean; count?: number }> {
  if (!printroveConfigured(env)) return { synced: false };
  if (Date.now() - lastCronCheck < 30 * 60 * 1000) return { synced: false };
  lastCronCheck = Date.now();
  try {
    const r = await env.DB_META.prepare("SELECT MAX(synced_at) AS at FROM pod_catalog WHERE provider='printrove'").first<{ at: number | null }>();
    if (r?.at && Date.now() - Number(r.at) < CATALOG_MAX_AGE_MS) return { synced: false };
  } catch (e) {
    if (!isNoTable(e)) await trackException(env, e, { route: 'pod/catalog_cron_check', handled: true, app_name: APP });
    return { synced: false };
  }
  const s = await autoSync(env);
  return s.ok ? { synced: true, count: s.count } : { synced: false };
}

// ---------------------------------------------------------------------------
// Shipping estimate
// ---------------------------------------------------------------------------
/** Cheapest courier charge in rupees to a reference pincode (110001), cached in KV for 24 h. Null when it cannot be had. */
export async function referenceShippingRupees(env: Env): Promise<number | null> {
  if (!printroveConfigured(env)) return null;
  try {
    const hit = (await env.TOKENS.get(SHIP_KEY, 'json')) as { rupees: number | null } | null;
    if (hit && (hit.rupees === null || typeof hit.rupees === 'number')) return hit.rupees;
  } catch { /* fall through to a live check */ }
  let rupees: number | null = null;
  try {
    const r = await new PrintroveProvider(env).serviceability(SHIP_REF_PINCODE, SHIP_REF_WEIGHT_G);
    rupees = r.ok && typeof r.shipping_cost_rupees === 'number' ? r.shipping_cost_rupees : null;
  } catch (e) {
    await trackException(env, e, { route: 'pod/ship_ref', handled: true, app_name: APP });
  }
  try { await env.TOKENS.put(SHIP_KEY, JSON.stringify({ rupees }), { expirationTtl: rupees === null ? 300 : 24 * 60 * 60 }); } catch { /* best-effort */ }
  return rupees;
}
