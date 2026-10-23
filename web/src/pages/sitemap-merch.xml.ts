// [HF-MERCH-FAN-WEB-1 2026-10-23] Sitemap of live merch product pages (/h/<slug>/merch/<product>) with their picture. Source: GET /api/hf/merch/sitemap.
// While the merch feature is off the API answers 404 and this is a valid, empty sitemap.
import type { APIRoute } from 'astro';
import { BRAND } from '../lib/brand';
import { fetchMerchSitemap } from '../lib/merchPublic';

export const prerender = false;
const SITE = BRAND.webOrigin;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (ms: number): string | null => { if (!ms || !Number.isFinite(ms)) return null; const d = new Date(ms < 1e12 ? ms * 1000 : ms); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export const GET: APIRoute = async () => {
  const map = await fetchMerchSitemap();
  const urls = (map?.products ?? [])
    .filter((p) => /^[a-z0-9-]{3,40}$/.test(p.hostSlug) && /^[a-z0-9][a-z0-9-]{0,80}$/.test(p.slug))
    .map((p) => {
      const lm = iso(p.updatedAt);
      const img = p.imageUrl && /^https:\/\//.test(p.imageUrl) ? `\n    <image:image><image:loc>${esc(p.imageUrl)}</image:loc><image:title>${esc(p.title)}</image:title></image:image>` : '';
      return `  <url>\n    <loc>${SITE}/h/${p.hostSlug}/merch/${p.slug}</loc>${lm ? `\n    <lastmod>${lm}</lastmod>` : ''}${img}\n  </url>`;
    });
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`,
    { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600' } },
  );
};
