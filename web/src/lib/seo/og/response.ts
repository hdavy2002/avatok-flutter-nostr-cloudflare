import { fallbackBase64, heroDataUri } from './assets.generated';
import { fetchPublicArt } from './public-art';
import { decodeBase64, renderOgPng } from './renderer';
import { ogImagePath, ogRevision, sha256 } from './revision';
import type { OgResolver } from './types';

const kinds = new Set(['home', 'page', 'collection', 'article', 'help', 'listing', 'creator', 'agent']);
const safetyHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };

function errorResponse(status: number): Response {
  return new Response(status === 503 ? 'Temporarily unavailable' : status === 400 ? 'Invalid image request' : 'Not found', {
    status, headers: { ...safetyHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 503 ? { 'Retry-After': '60' } : {}) },
  });
}

/** Request only identifies a registered public record; copy and artwork come from the resolver. */
export async function ogResponse(request: Request, kind: string, key: string, resolve: OgResolver): Promise<Response> {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const version = url.searchParams.get('v');
  if (keys.some(param => param !== 'v') || keys.length > 1 || (version !== null && !/^[a-f0-9]{64}$/.test(version))) return errorResponse(400);
  if (!kinds.has(kind) || !key || key.length > 300 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(key) || key.includes('//') || key.endsWith('/') || key.split('/').some(part => part === '.' || part === '..')) return errorResponse(404);

  let resolved: Awaited<ReturnType<OgResolver>>;
  try { resolved = await resolve(kind, key); }
  catch { return errorResponse(503); }
  if (resolved.status === 'not-found') return errorResponse(404);
  if (resolved.status === 'unavailable') return errorResponse(503);
  const record = resolved.record;
  // Defence in depth against a resolver accidentally returning a neighbouring/private key.
  if (record.kind !== kind || record.key !== key) return errorResponse(404);
  const revision = await ogRevision(record);
  if (version && version !== revision) {
    return new Response(null, { status: 302, headers: { ...safetyHeaders, Location: await ogImagePath(record), 'Cache-Control': 'no-store' } });
  }

  let fallback: 'art' | 'render' | undefined;
  let art = heroDataUri;
  if (record.art?.url) {
    const fetched = await fetchPublicArt(record.art.url);
    if (fetched) art = fetched;
    else fallback = 'art';
  }
  let bytes: Uint8Array;
  try { bytes = await renderOgPng(record, art); }
  catch { bytes = decodeBase64(fallbackBase64); fallback = 'render'; }
  // Hash actual bytes so art changes/fallback responses never reuse a misleading strong ETag.
  const etag = `"${await sha256(bytes)}"`;
  const headers = new Headers({
    ...safetyHeaders, 'Content-Type': 'image/png', ETag: etag,
    // Record visibility/art may change: even versioned URLs intentionally revalidate.
    // Eligibility is rechecked frequently so withdrawals reach shared caches quickly.
    'Cache-Control': fallback ? 'public, max-age=30, s-maxage=30' : 'public, max-age=60, s-maxage=60, must-revalidate',
    'X-SEO-OG-Revision': revision,
    ...(fallback ? { 'X-SEO-OG-Fallback': fallback } : {}),
  });
  if (request.headers.get('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
}
