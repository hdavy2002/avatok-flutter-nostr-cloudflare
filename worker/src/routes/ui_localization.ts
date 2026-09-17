import type { Env } from '../types';
import { catalogObjectKey, MAX_CATALOG_BYTES, validCatalog, validManifest } from '../lib/ui_catalogs';

function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
  } });
}
function conditional(req: Request, response: Response): Response {
  const etag = response.headers.get('ETag');
  const matches = req.headers.get('If-None-Match')?.split(',').map(s => s.trim().replace(/^W\//, ''));
  if (etag && (matches?.includes(etag) || matches?.includes('*'))) return new Response(null, { status: 304, headers: response.headers });
  return req.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
export async function uiLocalization(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return failure(405, 'method_not_allowed');
  const url = new URL(req.url);
  const key = catalogObjectKey(env.ENVIRONMENT_NAME, url.pathname);
  if (!key) return failure(404, 'catalog_not_found');
  // A fresh request strips cookies, credentials, query parameters and user headers.
  // The explicit environment suffix also isolates deployments sharing a hostname.
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('__catalog_environment', env.ENVIRONMENT_NAME!);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  let hit: Response | undefined;
  try { hit = await cache.match(cacheKey); } catch { /* Cache unavailable: R2 remains authoritative. */ }
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set('X-UI-Catalog-Cache', 'edge');
    return conditional(req, response);
  }
  const object = await env.BLOBS.get(key);
  if (!object) return failure(404, 'catalog_not_published');
  if (object.size > MAX_CATALOG_BYTES) return failure(502, 'invalid_catalog');
  const body = await object.text();
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return failure(502, 'invalid_catalog'); }
  const sourceManifest = /^\/i18n\/v1\/sources\/([a-f0-9]{64})\/manifest\.json$/.exec(url.pathname);
  const manifest = url.pathname === '/i18n/v1/manifest.json' || sourceManifest !== null;
  const parts = url.pathname.split('/');
  if (manifest) {
    if (!validManifest(payload)) return failure(502, 'invalid_catalog');
    if (sourceManifest && !Object.values(payload.sourceHashes ?? {}).includes(sourceManifest[1])) return failure(502, 'incompatible_source_manifest');
  } else if (!validCatalog(payload, parts[3], parts[4], parts[5].slice(0, -5))) return failure(502, 'invalid_catalog');
  // Deliberately construct safe headers rather than replaying R2 metadata.
  const response = new Response(body, { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': manifest ? 'public, max-age=60, must-revalidate' : 'public, max-age=31536000, immutable',
    'ETag': object.httpEtag, 'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, X-UI-Catalog-Cache',
    'X-Content-Type-Options': 'nosniff', 'X-UI-Catalog-Cache': 'r2',
  } });
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  return conditional(req, response);
}
