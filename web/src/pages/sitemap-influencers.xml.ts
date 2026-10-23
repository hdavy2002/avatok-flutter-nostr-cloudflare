// [HF-MERCH-FAN-WEB-1 2026-10-23] Sitemap of live influencer pages (/h/<slug>). Hosts come from the public list GET /api/hosts/public (48 a page);
// lastmod comes from the merch sitemap when the host has merch. Linked from the sitemap.xml index and robots.txt.
import type { APIRoute } from 'astro';
import { BRAND } from '../lib/brand';
import { fetchLiveHosts, fetchMerchSitemap } from '../lib/merchPublic';

export const prerender = false;
const SITE = BRAND.webOrigin;
const iso = (ms: number | undefined): string | null => { if (!ms || !Number.isFinite(ms)) return null; const d = new Date(ms < 1e12 ? ms * 1000 : ms); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export const GET: APIRoute = async () => {
  const [hosts, merch] = await Promise.all([fetchLiveHosts(), fetchMerchSitemap()]);
  const updated = new Map((merch?.hosts ?? []).map((h) => [h.slug, h.updatedAt]));
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const h of hosts) {
    if (!/^[a-z0-9-]{3,40}$/.test(h.slug) || seen.has(h.slug)) continue;
    seen.add(h.slug);
    const lm = iso(updated.get(h.slug));
    urls.push(`  <url>\n    <loc>${SITE}/h/${h.slug}</loc>${lm ? `\n    <lastmod>${lm}</lastmod>` : ''}\n  </url>`);
  }
  // A failed list must not publish an empty sitemap that crawlers cache for an hour.
  const down = hosts.length === 0 && merch === null;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': down ? 'public, max-age=60' : 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600' } },
  );
};
