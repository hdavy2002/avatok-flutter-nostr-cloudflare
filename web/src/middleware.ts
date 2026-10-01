import { defineMiddleware } from 'astro:middleware';
import { BRAND } from './lib/brand';

// [WEB-OLD-PAGES-GONE-1 2026-09-27] OWNER DECISION: the old avaTOK / creator-marketplace
// pages below were DELETED from src/pages. Their URLs answer 410 Gone (not 404) so
// Google drops them fastest and nobody lands on a half-working old flow.
// Deleted files were routed to the SSR worker (dist/_routes.json includes "/*"), so
// this middleware sees every one of these requests.
//
// NOTE FOR AI: paths already 301'd in public/_redirects (/tokens, /payouts, /dmca,
// /organisers, /child-safety, /community-guidelines, /biometric-retention,
// /india, /ideas via page) keep their redirect — _redirects wins before this runs.
// Do not re-create any of these pages; build new Saa Thum pages instead.
const GONE_EXACT = new Set([
  '/add',
  '/careers',
  '/acceptable-use', '/consultation-terms', '/marketplace-terms', '/prohibited-services', '/recording',
  '/biometric-retention', '/child-safety', '/community-guidelines', '/dmca',
  '/organisers', '/payouts', '/pricing-fees', '/tokens',
  '/pricing', '/pricing-preview', '/global-ideas', '/global-next', '/india-next', '/india',
  '/ideas', '/landing-steps-preview',
  '/embed/listing',
  '/sitemap-creators.xml', '/llms-creator-ideas.txt',
  '/vision', '/pay/return',
]);
const GONE_PREFIXES = [
  '/archive/', '/vision/', '/agent/', '/talk/', '/consult/', '/session/',
  // [SAATHUM-FREEVIDEOS-WEB-1 2026-10-01] '/watch/' was removed from this list: /watch/<id> is
  // now the Free videos watch page (pages/watch/[id].astro). The old avaTOK watch URLs were
  // /watch/<listing uuid>; they now 404 (the page looks the id up) instead of 410.
  '/live/', '/j/', '/c/',
];

const GONE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Page removed · ${BRAND.name}</title>
<link rel="icon" href="/assets/saathum-logo/favicon-32.png" type="image/png" sizes="32x32">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fdf1d3;color:#2b1a12;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
  main{max-width:520px;text-align:center}
  h1{font-size:28px;line-height:1.2;margin:0 0 12px}
  p{font-size:18px;line-height:1.5;margin:0 0 24px}
  a{display:inline-block;background:#ad3028;color:#fdf1d3;text-decoration:none;font-weight:800;font-size:18px;padding:14px 24px;border-radius:20px}
</style></head>
<body><main>
<h1>This page has been removed</h1>
<p>Explore the havans and pujas you can join on ${BRAND.name}.</p>
<a href="/marketplace">Explore</a>
</main></body></html>`;

export function isGonePath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (GONE_EXACT.has(p)) return true;
  return GONE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// [WEB-PERF-4 2026-09-30] Edge cache for the public SSR pages.
//
// /book/<id>, /book/<id>/checkout and /marketplace already answer
// `Cache-Control: public, max-age=60, stale-while-revalidate=300` and render the
// SAME document for every visitor (auth lives in the islands) — but a Pages
// Function response is never stored by Cloudflare's CDN on its own, so every
// visit re-ran the SSR and its API call: 1.7-3.5 s to first byte on an event
// page. This stores the finished HTML in the colo's Cache API for as long as
// the page's own max-age says (60 s), so all but the first visitor per minute
// per colo get it in tens of milliseconds. `x-edge-cache: HIT|MISS` shows which.
//
// Only 200s with a public, non-zero max-age and no Set-Cookie are stored, so a
// page that ever starts varying per user must drop `public` from its header.
// [SAATHUM-FREEVIDEOS-WEB-1] /watch/<id> (free video page) is the same document for everyone too.
// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The public shop pages (/shop, /shop/all, /shop/c/<slug>, /shop/p/<slug>) are the
// same document for everyone too. /shop/checkout is deliberately NOT here (per-visitor, noindex).
const EDGE_CACHE_PATH = /^\/(?:book\/[^/]+(?:\/checkout)?|watch\/[^/]+|marketplace|shop(?:\/all|\/c\/[^/]+|\/p\/[^/]+)?)\/?$/;
const BUILD_ID = (import.meta.env.PUBLIC_RELEASE_SHA as string | undefined) || 'dev';
type EdgeCache = { match(k: Request): Promise<Response | undefined>; put(k: Request, r: Response): Promise<void> };

function edgeCache(): EdgeCache | null {
  try {
    return ((globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default) ?? null;
  } catch {
    return null;
  }
}

function cacheable(res: Response): boolean {
  if (res.status !== 200 || res.headers.has('set-cookie')) return false;
  const cc = res.headers.get('cache-control') ?? '';
  const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(cc);
  return /\bpublic\b/.test(cc) && !/no-store|private/.test(cc) && !!maxAge && Number(maxAge[1]) > 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const cache = context.request.method === 'GET' && EDGE_CACHE_PATH.test(context.url.pathname) ? edgeCache() : null;
  if (cache) {
    // Keyed by build: a cached page from the previous deploy would point at
    // /_astro/ asset hashes the new deploy no longer serves.
    const keyUrl = new URL(context.url.toString());
    keyUrl.searchParams.set('__build', BUILD_ID);
    const key = new Request(keyUrl.toString(), { method: 'GET' });
    try {
      const hit = await cache.match(key);
      if (hit) {
        const out = new Response(hit.body, hit);
        out.headers.set('x-edge-cache', 'HIT');
        return out;
      }
    } catch { /* cache unavailable — render normally */ }
    const res = await next();
    if (!cacheable(res)) return res;
    const put = cache.put(key, res.clone()).catch(() => { /* best-effort */ });
    const ctx = (context.locals as { runtime?: { ctx?: { waitUntil(p: Promise<unknown>): void } } }).runtime?.ctx;
    if (ctx) ctx.waitUntil(put);
    const out = new Response(res.body, res);
    out.headers.set('x-edge-cache', 'MISS');
    return out;
  }
  if (isGonePath(context.url.pathname)) {
    return new Response(GONE_HTML, {
      status: 410,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'noindex',
        'cache-control': 'public, max-age=3600',
      },
    });
  }
  return next();
});
