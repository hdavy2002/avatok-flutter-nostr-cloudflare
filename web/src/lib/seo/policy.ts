import { isArchivedPath } from '../archivedPages';
import type { PublicContent } from './types';

export interface RoutePolicy {
  indexable: boolean;
  canonicalPath: string;
  reason?: string;
}

const PRIVATE_PREFIXES = [
  '/dashboard', '/admin', '/vision', '/archive', '/book', '/watch', '/live',
  '/session', '/consult', '/talk', '/j', '/pay', '/embed', '/test',
];

const PRIVATE_EXACT = new Set([
  '/add', '/sign-in', '/sign-out', '/sign-up', '/forgot-password', '/sso-callback',
  '/pricing-preview', '/landing-steps-preview', '/global-next', '/india-next',
]);

const PUBLIC_EXACT = new Set([
  '/', '/marketplace', '/help', '/how-it-works', '/prohibited-services', '/privacy',
  '/terms', '/cookies', '/refunds', '/contact', '/rituals', '/india',
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
  return new URL(path === '/' ? '/' : path, 'https://saathum.com').toString();
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
