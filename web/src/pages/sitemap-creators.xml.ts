// [WEB-SEO-3 2026-09-10] Dynamic sitemap feed for creators with >=1 public listing.
//
// SSR (prerender=false) — fetches GET /api/sitemap/creators from the Worker
// (edge-cached 1h server-side) at request time and turns it into a <urlset>.
// Canonical URL uses the same creatorPath() helper the rest of the site uses.
//
// Fetch failures return 503 + Retry-After; see sitemap-listings.xml.ts.
import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';
import { creatorPath } from '../lib/urls';

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
  type Row = { handle: string; updated_at: number };
  let rows: Row[] = [];
  try {
    const res = await fetch(`${API_BASE}/api/sitemap/creators?page=${page}&page_size=${pageSize}`);
    if (!res.ok) {
      console.error('sitemap_creators_fetch_not_ok', { status: res.status });
      return unavailable();
    }
    const data = (await res.json()) as { creators?: Row[] };
    rows = Array.isArray(data.creators) ? data.creators : [];
  } catch (e) {
    console.error('sitemap_creators_fetch_failed', { error: String((e as any)?.message ?? e) });
    return unavailable();
  }

  const urls = rows.map((r) => {
    const path = creatorPath(r.handle);
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
