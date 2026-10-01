// [SAATHUM-FREEZE-1] Single source of truth for the frozen-archive lane.
// Every other script in this folder (and the workflow) imports from here, so
// the target origin, the banner wording, the kept pages and the redirect list
// each live in exactly ONE place.
//
// The OLD brand name is never typed here: it is read from Specs/brand.json at
// run time (see loadOldBrandName), per the repo's brand-central rule.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 1. Where the live site moved to.
//    Override with `--new-origin=https://example.com` or env NEW_ORIGIN.
//    THIS is the only place the default target origin is written down.
// ---------------------------------------------------------------------------
export const DEFAULT_NEW_ORIGIN = 'https://aumfe.com';

// The new brand name is NOT final. It is only the visible link text in the
// banner ("<old brand> is now at <NEW_BRAND_NAME>"). Change this constant (or
// set env NEW_BRAND_NAME) when the name is decided; nothing else depends on it.
export const DEFAULT_NEW_BRAND_NAME = 'aumfe.com';

// The banner sentence. `{old}` = old brand name (from Specs/brand.json),
// `{link}` = an <a> to NEW_ORIGIN + the same path whose text is NEW_BRAND_NAME.
export const BANNER_TEMPLATE = '{old} is now at {link}';

// Banner look. Plain and readable: never below 14px (the check enforces it).
export const BANNER_FONT_SIZE_PX = 16;

export function resolveNewOrigin(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a.startsWith('--new-origin='));
  const raw = (flag ? flag.slice('--new-origin='.length) : env.NEW_ORIGIN || '').trim() || DEFAULT_NEW_ORIGIN;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEW_ORIGIN "${raw}" is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`NEW_ORIGIN must be https, got "${raw}"`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`NEW_ORIGIN must be a bare origin (no path/query), got "${raw}"`);
  return url.origin;
}

export function resolveNewBrandName(env = process.env) {
  return (env.NEW_BRAND_NAME || '').trim() || DEFAULT_NEW_BRAND_NAME;
}

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
//        /P            -> NEW_ORIGIN/P            (static)
//        /P/           -> NEW_ORIGIN/P/           (static)
//        /P/*          -> NEW_ORIGIN/P/:splat     (dynamic)
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
export function functionalRedirectRules(newOrigin) {
  const statics = [];
  const dynamics = [];
  for (const p of REDIRECT_PREFIXES) {
    statics.push([`/${p}`, `${newOrigin}/${p}`]);
    statics.push([`/${p}/`, `${newOrigin}/${p}/`]);
    dynamics.push([`/${p}/*`, `${newOrigin}/${p}/:splat`]);
  }
  return { statics, dynamics };
}

export function isDynamicRule(source) {
  return source.includes('*') || /:[A-Za-z]/.test(source);
}
