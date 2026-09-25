import type { APIRoute } from 'astro';
import { API_BASE } from '../lib/config';

export const prerender = false;
const SITE = 'https://saathum.com';
const DIRECTORY_PAGE_SIZE = 100;

export const GET: APIRoute = async () => {
  try {
    const response = await fetch(`${API_BASE}/api/sitemap/manifest?page_size=${DIRECTORY_PAGE_SIZE}`);
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    const manifest = await response.json() as { listings?: { pages?: number } };
    const pages = manifest.listings?.pages;
    if (!Number.isSafeInteger(pages) || pages! < 0 || pages! > 50_000) throw new Error('invalid manifest');
    const urls = Array.from({ length: pages! }, (_, index) =>
      `  <url>\n    <loc>${SITE}/marketplace/page/${index + 1}</loc>\n  </url>`,
    ).join('\n');
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' } },
    );
  } catch (error) {
    console.error('sitemap_directory_fetch_failed', { error: String((error as Error)?.message ?? error) });
    return new Response('Sitemap temporarily unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
};
