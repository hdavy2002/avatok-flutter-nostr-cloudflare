// [WEB-SEO-1 2026-08-27] avatok.ai static-pages sitemap.
// [WEB-SEO-3 2026-09-10] Renamed from sitemap.xml.ts to sitemap-pages.xml.ts.
// This file's content and behaviour are UNCHANGED — only the URL moved, from
// /sitemap.xml to /sitemap-pages.xml. /sitemap.xml is now a sitemapindex (see
// the new sitemap.xml.ts) that references this file plus the two new dynamic
// feeds, sitemap-listings.xml.ts and sitemap-creators.xml.ts, which cover the
// per-listing and per-creator routes this file explicitly cannot enumerate
// (see below).
//
// WHY THIS IS HAND-ROLLED AND NOT @astrojs/sitemap.
//   Adding the integration means a new dependency, and CI runs `npm ci` against
//   a committed package-lock.json — a lockfile edit made without a working npm
//   install is exactly how a green-looking commit turns into a failed deploy.
//   This file needs no dependency and no lockfile change.
//
// WHAT GOES IN.
//   Only PUBLIC, prerendered, indexable routes. Deliberately excluded:
//     - /dashboard, /admin, /vision — noindex product surfaces (see robots.txt)
//     - /sign-in, /sign-up, /forgot-password — auth screens; /sign-up is the one
//       exception because it is the funnel's destination and worth ranking
//     - dynamic routes (/[username], /l/[id], /book/[id], /watch/[id], …) — they
//       are per-creator and per-listing, generated at request time, so they
//       cannot be enumerated here. When creator profiles matter for SEO, the
//       right move is a second sitemap fed by the Worker's listings API, not a
//       hardcoded list that silently goes stale.
//
// Keep in sync with src/pages/ when a public page is added.
// [WEB-HELP-1 2026-09-11] Exception: help-centre article routes are NOT
// hardcoded here — they come from the `help` content collection via
// getHelpEntries()/helpUrl() (src/lib/help.ts) and are appended in GET
// below, alongside the static '/help' landing-page entry.
import type { APIRoute } from 'astro';
import { creatorIdeas } from '../lib/creatorIdeas';
// [WEB-HELP-1 2026-09-11] Help routes: '/help' plus one entry per
// non-draft help article, appended in GET() since collection reads are async.
import { getHelpEntries, helpUrl } from '../lib/help';

export const prerender = true;

const SITE = 'https://avatok.ai';

/** [path, changefreq, priority] */
const ROUTES: Array<[string, string, string, string?]> = [
  ['/', 'daily', '1.0'],
  ['/marketplace', 'daily', '0.9'],
  ['/explore', 'daily', '0.9'],
  ['/sign-up', 'monthly', '0.9'],
  ['/about', 'monthly', '0.7'],
  ['/blog', 'weekly', '0.7'],
  ['/ideas', 'weekly', '0.8'],
  ...creatorIdeas.map(idea => [idea.href, 'monthly', '0.6'] as [string, string, string]),
  ['/blog/earn-from-day-one', 'monthly', '0.7'],
  ['/blog/real-people-safety', 'monthly', '0.6'],
  ['/blog/ai-in-every-chat', 'monthly', '0.6'],
  ['/blog/ai-voice-agents', 'monthly', '0.6'],
  ['/blog/never-miss-a-call', 'monthly', '0.6'],
  ['/blog/your-private-number', 'monthly', '0.6'],
  ['/tokens', 'monthly', '0.6'],
  ['/pricing-fees', 'monthly', '0.6'],
  ['/payouts', 'monthly', '0.6'],
  ['/refunds', 'monthly', '0.4'],
  ['/community-guidelines', 'monthly', '0.5'],
  ['/child-safety', 'monthly', '0.5'],
  ['/recording', 'monthly', '0.4'],
  ['/careers', 'monthly', '0.5'],
  ['/contact', 'monthly', '0.5'],
  ['/grievance', 'yearly', '0.3'],
  ['/privacy', 'yearly', '0.3'],
  ['/terms', 'yearly', '0.3'],
  ['/acceptable-use', 'yearly', '0.3'],
  ['/marketplace-terms', 'yearly', '0.3'],
  ['/consultation-terms', 'yearly', '0.3'],
  ['/cookies', 'yearly', '0.3'],
  ['/dmca', 'yearly', '0.3'],
  ['/biometric-retention', 'yearly', '0.3'],
];

export const GET: APIRoute = async () => {
  const lastmod = new Date().toISOString().slice(0, 10);
  // [WEB-HELP-1 2026-09-11] '/help' plus one entry per non-draft help
  // article, built at request time from the content collection so this list
  // can never go stale the way a hardcoded one would. Each article carries
  // its own frontmatter `updated` date as this row's lastmod (4th tuple
  // element, optional — every other route in ROUTES falls back to today's
  // build date below) rather than the build date, so lastmod actually
  // reflects when the content changed.
  const helpEntries = await getHelpEntries();
  const helpRoutes: Array<[string, string, string, string?]> = [
    ['/help', 'weekly', '0.8'],
    ...helpEntries.map(
      (entry) =>
        [helpUrl(entry), 'monthly', '0.6', entry.data.updated.toISOString().slice(0, 10)] as [
          string,
          string,
          string,
          string,
        ],
    ),
  ];
  const urls = [...ROUTES, ...helpRoutes].map(
    ([path, changefreq, priority, rowLastmod]) =>
      `  <url>\n` +
      `    <loc>${SITE}${path}</loc>\n` +
      `    <lastmod>${rowLastmod ?? lastmod}</lastmod>\n` +
      `    <changefreq>${changefreq}</changefreq>\n` +
      `    <priority>${priority}</priority>\n` +
      `  </url>`,
  ).join('\n');

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
