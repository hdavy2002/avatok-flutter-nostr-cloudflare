// [WEB-SEO-3 2026-09-10] avatok.ai sitemap index.
//
// Replaces the old single-file sitemap.xml.ts (now sitemap-pages.xml.ts — the
// static marketing routes) with a <sitemapindex> that references it plus the
// two dynamic feeds this issue adds: sitemap-listings.xml.ts (per-listing
// /<handle>/<slug> or /l/<id> pages) and sitemap-creators.xml.ts (per-creator
// /c/<handle> pages). Those two cannot be enumerated at build time — they are
// generated at request time from live D1 rows — so they are separate
// prerender=false routes that fetch the Worker's /api/sitemap/* endpoints.
//
// This index itself stays prerendered (static, tiny, never changes shape).
// robots.txt's `Sitemap:` line keeps pointing at this same /sitemap.xml URL.
import type { APIRoute } from 'astro';

export const prerender = true;

const SITE = 'https://avatok.ai';

const SITEMAPS = ['/sitemap-pages.xml', '/sitemap-listings.xml', '/sitemap-creators.xml'];

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const entries = SITEMAPS.map(
    (path) =>
      `  <sitemap>\n` +
      `    <loc>${SITE}${path}</loc>\n` +
      `    <lastmod>${lastmod}</lastmod>\n` +
      `  </sitemap>`,
  ).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
