// [WEB-SEO-1 2026-08-27] saathum.com static-pages sitemap.
// [WEB-SEO-3 2026-09-10] Renamed from sitemap.xml.ts to sitemap-pages.xml.ts.
// This file's content and behaviour are UNCHANGED — only the URL moved, from
// /sitemap.xml to /sitemap-pages.xml. /sitemap.xml is now a sitemapindex (see
// the new sitemap.xml.ts) that references this file plus the two new dynamic
// feeds, sitemap-listings.xml.ts and sitemap-directory.xml.ts, which cover the
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
import { rituals } from '../lib/ritualGuides';
// [WEB-HELP-1 2026-09-11] Help routes: '/help' plus one entry per
// non-draft help article, appended in GET() since collection reads are async.
import { getHelpEntries, helpUrl } from '../lib/help';
import { isArchivedPath } from '../lib/archivedPages';
import { BRAND } from '../lib/brand';
import brandConfig from '../../../Specs/brand.json';

export const prerender = true;

const SITE = BRAND.webOrigin;
const HELLO_SITE = `https://${brandConfig.homepageIdentity.domain}`;
const HELLO_ROUTES = new Set([
  '/', '/about', '/how-it-works', '/faq', '/contact', '/press',
  '/hosts/join', '/hosts/requirements', '/hosts/rules', '/hosts/crisis-script', '/hosts/rates', '/hosts/agreement', '/hosts/kyc',
  '/safety', '/community-guidelines', '/recording-policy', '/report', '/grievance', '/emergency', '/women-only', '/lgbtq', '/age-policy', '/wellbeing',
  '/terms', '/disclaimer', '/privacy', '/wallet-terms', '/refunds', '/cookies', '/data-deletion', '/intermediary-policy',
]);

/** [path, changefreq, priority] */
// [WEB-SEO-REBRAND-1 2026-09-27] Rebuilt from a scan of every page on the live
// site: ONLY the pages that answer 200 AND carry robots "index". Archived,
// redirected, noindex and 410 pages are gone from this list (the old creator/
// wallet/legal-for-sellers rows were removed rather than left to the archive
// filter). Ritual guides use the trailing-slash URL — that is the one Cloudflare
// Pages serves with 200 (see canonicalUrl in lib/seo/policy.ts).
const BASE_ROUTES: Array<[string, string, string, string?]> = [
  ['/', 'daily', '1.0'],
  ['/marketplace', 'daily', '0.9'],
  ['/free-videos', 'daily', '0.7'], // [SAATHUM-FREEVIDEOS-WEB-1]
  ['/rituals/', 'weekly', '0.9'],
  ...rituals.map(ritual => [ritual.href, 'monthly', '0.8'] as [string, string, string]),
  ['/how-it-works', 'monthly', '0.8'],
  ['/temples', 'monthly', '0.8'],
  // [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The Shop. Product and collection pages are crawled from these two hubs
  // (every product links from /shop/all, every collection from /shop), the same way /free-videos covers /watch/<id>.
  ['/shop', 'daily', '0.8'],
  ['/shop/all', 'daily', '0.8'],
  ['/about', 'monthly', '0.8'],
  ['/contact', 'monthly', '0.5'],
  ['/refunds', 'monthly', '0.5'],
  ['/privacy', 'yearly', '0.3'],
  ['/terms', 'yearly', '0.3'],
  ['/cookies', 'yearly', '0.3'],
  ['/disclaimer', 'yearly', '0.3'],
  ['/grievance', 'yearly', '0.3'],
  // Hello Fraands content routes share the site's static sitemap.
];
const ROUTES: Array<[string, string, string, string?]> = [
  ...BASE_ROUTES,
  ...[...HELLO_ROUTES].filter(path => !BASE_ROUTES.some(([existing]) => existing === path)).map(path => [path, 'monthly', '0.5'] as [string, string, string]),
];

export const GET: APIRoute = async () => {
  // [WEB-HELP-1 2026-09-11] '/help' plus one entry per non-draft help
  // article, built at request time from the content collection so this list
  // can never go stale the way a hardcoded one would. Each article carries
  // its own frontmatter `updated` date as this row's lastmod. Routes without
  // a trustworthy content date omit lastmod instead of publishing build time.
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
  // [SAATHUM-ARCHIVE-1 2026-09-25] Archived pages are noindex — keep them out.
  const urls = [...ROUTES, ...helpRoutes].filter(([path]) => !isArchivedPath(path)).map(
    ([path, changefreq, priority, rowLastmod]) =>
      `  <url>\n` +
      `    <loc>${HELLO_ROUTES.has(path) ? HELLO_SITE : SITE}${path}</loc>\n` +
      (rowLastmod ? `    <lastmod>${rowLastmod}</lastmod>\n` : '') +
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
