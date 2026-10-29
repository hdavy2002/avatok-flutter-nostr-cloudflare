// [HF-SUPPORT-DESK] support.<brand domain> serves the support desk (pages/support-desk/[...path].astro) at "/".
//
// The desk lives INSIDE the web/ Astro project as SSR routes under /support-desk/... so it reuses the site's auth,
// brand config and fonts. When a request arrives on the support host, middleware.ts rewrites "/x" to
// "/support-desk/x" (the browser URL does not change). Pure functions, no Astro imports, so they are unit-testable.
//
// The host is derived from the brand config. Never hard-code the domain.
import { BRAND } from './brand';

/** Path prefix the desk is mounted at on the main site (hellofraands.com/support-desk/...). */
export const SUPPORT_BASE = '/support-desk';

/** "support.<brand domain>". */
export const SUPPORT_HOST = `support.${BRAND.domain}`;

/** True for the support host (case-insensitive, port ignored). */
export function isSupportHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/:\d+$/, '') === SUPPORT_HOST;
}

// Paths that must keep being served as themselves on the support host: build assets, fonts, images, well-known files,
// anything with a file extension (favicon.ico, robots.txt, ...). The Worker API lives on api.<domain>, not here.
const PASSTHROUGH = /^\/(?:_astro|_image|_images|fonts|assets|images|icons|hf|\.well-known|cdn-cgi)(?:\/|$)|\.[a-z0-9]{2,6}$/i;

/**
 * The path to rewrite a request to, or null when it should be served unchanged.
 * `/` -> `/support-desk`, `/t/HF-10234?x=1` -> `/support-desk/t/HF-10234?x=1`.
 */
export function supportRewritePath(url: URL): string | null {
  if (!isSupportHost(url.hostname)) return null;
  const p = url.pathname;
  if (p === SUPPORT_BASE || p.startsWith(`${SUPPORT_BASE}/`)) return null;
  if (PASSTHROUGH.test(p)) return null;
  const tail = p === '/' ? '' : p.replace(/\/+$/, '');
  return `${SUPPORT_BASE}${tail}${url.search}`;
}

/** Headers every support-desk response carries: private, never indexed, never cached. */
export const SUPPORT_RESPONSE_HEADERS: Record<string, string> = {
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'private, no-store',
};

/** True for any path that belongs to the desk on the main host (so it also gets the headers above). */
export function isSupportPath(pathname: string): boolean {
  return pathname === SUPPORT_BASE || pathname.startsWith(`${SUPPORT_BASE}/`);
}
