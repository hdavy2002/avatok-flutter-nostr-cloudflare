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
  '/live/', '/watch/', '/j/', '/c/',
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

export const onRequest = defineMiddleware(async (context, next) => {
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
