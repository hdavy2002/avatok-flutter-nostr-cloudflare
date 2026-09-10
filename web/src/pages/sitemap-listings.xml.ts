// [WEB-SEO-3 2026-09-10] Dynamic sitemap feed for public listings.
//
// SSR (prerender=false) — fetches GET /api/sitemap/listings from the Worker
// (already edge-cached 1h server-side via cached()) at request time and turns
// it into a <urlset>. Canonical URL per row uses the SAME listingPath() helper
// as web/src/pages/l/[id].astro, so this sitemap never disagrees with what the
// listing page itself calls canonical.
//
// On any fetch failure or non-200, returns a VALID EMPTY <urlset> with status
// 200 (never a 500) — a broken sitemap response is worse to Google than an
// empty one, and the failure is still visible via console.error.
import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';
import { listingPath } from '../lib/urls';

export const prerender = false;

const SITE = 'https://avatok.ai';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function emptyUrlset(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`;
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export const GET: APIRoute = async () => {
  type Row = { id: string; handle: string | null; slug: string | null; updated_at: number };
  let rows: Row[] = [];
  try {
    const res = await fetch(`${API_BASE}/api/sitemap/listings`);
    if (!res.ok) {
      console.error('sitemap_listings_fetch_not_ok', { status: res.status });
      return emptyUrlset();
    }
    const data = (await res.json()) as { listings?: Row[] };
    rows = Array.isArray(data.listings) ? data.listings : [];
  } catch (e) {
    console.error('sitemap_listings_fetch_failed', { error: String((e as any)?.message ?? e) });
    return emptyUrlset();
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
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
