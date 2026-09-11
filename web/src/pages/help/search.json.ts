// [WEB-HELP-1 2026-09-11] Prerendered search index for the help centre.
// Zero-dependency search (plan §6): the client in Help.astro fetches this
// once on first focus of the search box and scores results itself. Static
// like sitemap-pages.xml.ts, so it lives under the HTML
// `max-age=0, must-revalidate` rule in public/_headers rather than any
// long-cached asset rule — it must never outlive a deploy.
import type { APIRoute } from 'astro';
import { buildSearchIndex } from '../../lib/help';

export const prerender = true;

export const GET: APIRoute = async () => {
  const index = await buildSearchIndex();
  return new Response(JSON.stringify(index), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};
