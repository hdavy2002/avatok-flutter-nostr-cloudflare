// [SAATHUM-FREEZE-1] Single source of truth for the frozen-archive lane.
// Every other script in this folder (and the workflow) imports from here, so
// the kept pages and the redirect list
// each live in exactly ONE place.
//
// The OLD brand name is never typed here: it is read from Specs/brand.json at
// run time (see loadOldBrandName), per the repo's brand-central rule.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// There is deliberately NO new origin anywhere in this lane: the archive must hold no
// trace of the live site (owner decision 2026-10-01). Every functional path 302s to the
// archive's own home page, "/".
export const REDIRECT_TARGET = '/';

export function brandJsonPath(env = process.env) {
  return env.BRAND_JSON || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Specs', 'brand.json');
}

export function loadBrand(env = process.env) {
  return JSON.parse(readFileSync(brandJsonPath(env), 'utf8'));
}

export function loadOldBrandName(env = process.env) {
  const name = loadBrand(env).name;
  if (!name || typeof name !== 'string') throw new Error(`Specs/brand.json has no "name" (${brandJsonPath(env)})`);
  return name;
}

// ---------------------------------------------------------------------------
// 2. The pages that survive (paths relative to web/src/pages). Everything else
//    in src/pages is deleted — an ALLOW-list, so a page added to main later is
//    dropped by default instead of silently shipping into the archive.
// ---------------------------------------------------------------------------
export const KEEP_PAGES = [
  '404.astro',
  'index.astro', // home
  'about.astro',
  'how-it-works.astro',
  'temples.astro',
  'rituals/index.astro', // Puja & Havan guide
  'rituals/[slug].astro', // its articles (getStaticPaths)
  'help/index.astro',
  'help/[...slug].astro', // help articles (getStaticPaths)
  'help/search.json.ts', // static search index the help-centre search box reads
  'contact.astro', // form neutralised by prepare-source
  'terms.astro',
  'privacy.astro',
  'refunds.astro',
  'cookies.astro',
  'disclaimer.astro',
  'grievance.astro',
];

// ---------------------------------------------------------------------------
// 3. Functional paths people still hold in old emails / WhatsApp messages /
//    bookmarks. Each prefix P becomes three rules on the archive:
//        /P            -> /   (302, static)
//        /P/           -> /   (302, static)
//        /P/*          -> /   (302, dynamic)
//    Derived from web/src/pages (dynamic/SSR/auth/checkout/dashboard/admin/shop
//    trees) plus web/public/_redirects.
// ---------------------------------------------------------------------------
export const REDIRECT_PREFIXES = [
  'j', // emailed join links /j/<token>
  'l', // listing /l/<id>
  'e', // event /e/<event>
  'book', // /book/<id> and /book/<id>/checkout
  'checkout',
  'dashboard', // whole dashboard tree
  'sign-in',
  'sign-up',
  'sign-out',
  'sso-callback',
  'forgot-password',
  'watch', // /watch/<id> free-video watch page
  'free-videos',
  'shop', // storefront, product, collection, checkout
  'explore',
  'marketplace',
  'admin',
  'live', // old live-room links
  'session', // old paid-session links
  'talk',
  'consult',
  'c', // old creator pages
  'saathum', // listing URLs /saathum/<slug> (the [username]/[slug] route)
  // NOT 'og': /og/*.png are static files in public/ and stay served here.
];

// Max rules Cloudflare Pages accepts in one _redirects file.
export const REDIRECT_LIMITS = { static: 2000, dynamic: 100 };

// First path segment of an internal href, or '' for '/'.
export function firstSegment(path) {
  const clean = path.split('#')[0].split('?')[0];
  return clean.split('/').filter(Boolean)[0] ?? '';
}

export function isRedirectedPath(path) {
  return REDIRECT_PREFIXES.includes(firstSegment(path));
}

// Rules as [source, destination] pairs, static first (Pages requires it).
export function functionalRedirectRules() {
  const statics = [];
  const dynamics = [];
  for (const p of REDIRECT_PREFIXES) {
    statics.push([`/${p}`, REDIRECT_TARGET]);
    statics.push([`/${p}/`, REDIRECT_TARGET]);
    dynamics.push([`/${p}/*`, REDIRECT_TARGET]);
  }
  return { statics, dynamics };
}

export function isDynamicRule(source) {
  return source.includes('*') || /:[A-Za-z]/.test(source);
}
