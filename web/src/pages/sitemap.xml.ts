// [WEB-SEO-3 2026-09-10] saathum.com sitemap index.
//
// Replaces the old single-file sitemap.xml.ts (now sitemap-pages.xml.ts — the
// static marketing routes) with a <sitemapindex> that references it plus the
// two dynamic feeds this issue adds: sitemap-listings.xml.ts (per-listing
// /<handle>/<slug> or /l/<id> pages) and (formerly) sitemap-creators.xml.ts (per-creator
// /c/<handle> pages). Those two cannot be enumerated at build time — they are
// generated at request time from live D1 rows — so they are separate
// prerender=false routes that fetch the Worker's /api/sitemap/* endpoints.
//
// The index is runtime-generated from the Worker's count-only manifest so it
// automatically expands past 10,000 listings/creators without a code change.
import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';
import { BRAND } from '../lib/brand';

export const prerender = false;

const SITE = BRAND.webOrigin;

const PAGE_SIZE = 10_000;

export const GET: APIRoute = async () => {
  let manifest: { listings: { pages: number }; creators: { pages: number } };
  try {
    const response = await fetch(`${API_BASE}/api/sitemap/manifest?page_size=${PAGE_SIZE}`);
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    manifest = await response.json() as typeof manifest;
    if (!Number.isSafeInteger(manifest.listings?.pages) || !Number.isSafeInteger(manifest.creators?.pages)) {
      throw new Error('invalid manifest');
    }
  } catch (error) {
    console.error('sitemap_manifest_fetch_failed', { error: String((error as Error)?.message ?? error) });
    return new Response('Sitemap temporarily unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
  const sitemaps = [
    '/sitemap-pages.xml',
    '/sitemap-directory.xml',
    ...Array.from({ length: manifest.listings.pages }, (_, index) => `/sitemap-listings.xml?page=${index + 1}&amp;page_size=${PAGE_SIZE}`),
    // [WEB-SEO-REBRAND-1 2026-09-27] Creator profiles are no longer listed: Saa Thum has
    // no outside creators, and /c/* is noindex (lib/seo/policy.ts). The feed itself was
    // DELETED 2026-09-27 ([WEB-OLD-PAGES-GONE-1]) and now answers 410.
  ];
  const entries = sitemaps.map(
    (path) =>
      `  <sitemap>\n` +
      `    <loc>${SITE}${path}</loc>\n` +
      `  </sitemap>`,
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
};
