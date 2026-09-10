// [WEB-SEO-3 2026-09-10] Dynamic sitemap feed for creators with >=1 public listing.
//
// SSR (prerender=false) — fetches GET /api/sitemap/creators from the Worker
// (edge-cached 1h server-side) at request time and turns it into a <urlset>.
// Canonical URL uses the same creatorPath() helper the rest of the site uses.
//
// On any fetch failure or non-200, returns a VALID EMPTY <urlset> with status
// 200 (never a 500) — see sitemap-listings.xml.ts header for why.
import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';
import { creatorPath } from '../lib/urls';

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
  type Row = { handle: string; updated_at: number };
  let rows: Row[] = [];
  try {
    const res = await fetch(`${API_BASE}/api/sitemap/creators`);
    if (!res.ok) {
      console.error('sitemap_creators_fetch_not_ok', { status: res.status });
      return emptyUrlset();
    }
    const data = (await res.json()) as { creators?: Row[] };
    rows = Array.isArray(data.creators) ? data.creators : [];
  } catch (e) {
    console.error('sitemap_creators_fetch_failed', { error: String((e as any)?.message ?? e) });
    return emptyUrlset();
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
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
