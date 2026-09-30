import { isArchivedPath } from '../archivedPages';
import type { PublicContent } from './types';
import { BRAND } from '../brand';

export interface RoutePolicy {
  indexable: boolean;
  canonicalPath: string;
  reason?: string;
}

const PRIVATE_PREFIXES = [
  '/dashboard', '/admin', '/vision', '/archive', '/book', '/watch', '/live',
  '/session', '/consult', '/talk', '/j', '/pay', '/embed', '/test',
  // [WEB-SEO-REBRAND-1 2026-09-27] Creator profile pages: no outside creators any
  // more, and profiles name real people. Never indexed.
  '/c',
];

const PRIVATE_EXACT = new Set([
  '/add', '/sign-in', '/sign-out', '/sign-up', '/forgot-password', '/sso-callback',
  '/pricing-preview', '/landing-steps-preview', '/global-next', '/india-next',
]);

const PUBLIC_EXACT = new Set([
  '/', '/marketplace', '/help', '/how-it-works', '/temples', '/privacy',
  '/terms', '/cookies', '/refunds', '/contact', '/rituals', '/disclaimer', '/grievance',
]);

function normalizePath(pathname: string): string {
  let path = pathname || '/';
  try { path = decodeURI(path); } catch { /* keep the original path */ }
  path = path.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

function prefixed(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function canonicalUrl(pathname: string): string {
  const path = normalizePath(pathname);
  // [WEB-SEO-REBRAND-1 2026-09-27] /rituals/* is excluded from the worker
  // (astro.config.mjs routes.extend.exclude) and served as static assets, and
  // Cloudflare Pages answers /rituals/x with a 308 to /rituals/x/. The canonical
  // (and the sitemap) must name the URL that answers 200, not the one that
  // redirects — otherwise Google sees canonical -> redirect -> canonical.
  if (path === '/rituals' || path.startsWith('/rituals/')) {
    return new URL(path + '/', BRAND.webOrigin).toString();
  }
  return new URL(path === '/' ? '/' : path, BRAND.webOrigin).toString();
}

export function resolveRoutePolicy(
  pathname: string,
  content?: PublicContent,
  searchParams?: URLSearchParams,
): RoutePolicy {
  const path = normalizePath(content?.canonicalPath ?? pathname);

  if (isArchivedPath(path)) return { indexable: false, canonicalPath: path, reason: 'archived' };
  if (PRIVATE_EXACT.has(path) || PRIVATE_PREFIXES.some((prefix) => prefixed(path, prefix))) {
    return { indexable: false, canonicalPath: path, reason: 'private-or-transactional' };
  }

  if (path === '/marketplace' && searchParams && [...searchParams.keys()].some((key) => key !== 'page')) {
    return { indexable: false, canonicalPath: '/marketplace', reason: 'filtered-collection' };
  }

  if (content) {
    const indexable = content.visibility === 'public' && (!content.state || content.state === 'active');
    return {
      indexable,
      canonicalPath: normalizePath(content.canonicalPath),
      reason: indexable ? undefined : content.state ?? content.visibility,
    };
  }

  if (PUBLIC_EXACT.has(path) || prefixed(path, '/help') || prefixed(path, '/rituals')) {
    return { indexable: true, canonicalPath: path };
  }

  // New route families must deliberately provide PublicContent before indexing.
  return { indexable: false, canonicalPath: path, reason: 'unclassified-route' };
}
