// [WEB-SEO-3 2026-09-10] Dynamic sitemap feed for public listings.
//
// SSR (prerender=false) — fetches GET /api/sitemap/listings from the Worker
// (already edge-cached 1h server-side via cached()) at request time and turns
// it into a <urlset>. Canonical URL per row uses the SAME listingPath() helper
// as web/src/pages/l/[id].astro, so this sitemap never disagrees with what the
// listing page itself calls canonical.
//
// Fetch failures return 503 + Retry-After. A successful empty sitemap would
// falsely tell crawlers that every previously indexed listing disappeared.
import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';
import { listingPath } from '../lib/urls';

export const prerender = false;

const SITE = 'https://saathum.com';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unavailable(): Response {
  return new Response('Sitemap temporarily unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const page = url.searchParams.get('page') ?? '1';
  const pageSize = url.searchParams.get('page_size') ?? '10000';
  if (!/^\d+$/.test(page) || !/^\d+$/.test(pageSize)) return new Response('Invalid sitemap page', { status: 400 });
  type Row = { id: string; handle: string | null; slug: string | null; updated_at: number };
  let rows: Row[] = [];
  try {
    const res = await fetch(`${API_BASE}/api/sitemap/listings?page=${page}&page_size=${pageSize}`);
    if (!res.ok) {
      console.error('sitemap_listings_fetch_not_ok', { status: res.status });
      return unavailable();
    }
    const data = (await res.json()) as { listings?: Row[] };
    rows = Array.isArray(data.listings) ? data.listings : [];
  } catch (e) {
    console.error('sitemap_listings_fetch_failed', { error: String((e as any)?.message ?? e) });
    return unavailable();
  }

  const urls = rows.map((r) => {
    const path = listingPath({ id: r.id, handle: r.handle, slug: r.slug });
    const lastmod = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : undefined;
    return (
      `  <url>\n` +
      `    <loc>${esc(SITE + path)}</loc>\n` +
      (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '') +
      `  </url>`
    );
  }).join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
};
