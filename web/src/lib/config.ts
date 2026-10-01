import publicImageManifest from './publicImageManifest.json';
import { BRAND } from './brand';
// Runtime config for the web client. PUBLIC_* vars are inlined into the browser
// bundle by Astro/Vite. The API base is the SAME Worker the Flutter app calls
// (MASTER-PROMPT §3/§4) — never a new backend.

// [WEB-PERF-1 2026-09-30] The plain values moved to ./env so light client
// code stops pulling publicImageManifest.json into every page. Re-exported here
// so every existing import keeps working.
export { API_BASE, CLERK_PUBLISHABLE_KEY, PLAY_STORE_URL, APP_STORE_URL, HAS_NATIVE_APP } from './env';
import { API_BASE, CLERK_PUBLISHABLE_KEY } from './env';

/**
 * Frontend-API host for the configured Clerk instance, derived from the
 * publishable key. A `pk_live_…` / `pk_test_…` key is `pk_<env>_` followed by a
 * base64 encoding of `<fapi-host>$` (e.g. `clerk.avatok.ai$`). We decode it so
 * the <link rel="preconnect"> on the auth pages always points at the host
 * clerk-js will actually load from — correct in prod, staging and pk_test
 * previews alike, with no hard-coded domain to drift. Returns undefined when no
 * (or a placeholder) key is set.
 */
export function clerkFapiHost(): string | undefined {
  const key = CLERK_PUBLISHABLE_KEY;
  if (!key) return undefined;
  const b64 = key.replace(/^pk_(live|test)_/, '');
  if (!b64 || b64 === key) return undefined; // not a real pk_ key
  try {
    const decode =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('utf8');
    const host = decode.replace(/\$+$/, '').trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * [WEB-PERF-3 2026-09-30] Quality tiers. Photos keep the default 60. Flat
 * illustrated ARTWORK (category tiles, folk art, havan cards, elephants) is
 * visually identical at 45 and ~30% smaller (e.g. category tile 83 KB -> 56 KB
 * at 640w). check-image-coverage.mjs accepts exactly these two values.
 */
export const PHOTO_QUALITY = 60;
export const ARTWORK_QUALITY = 45;

/** Bounded variants keep the image cache from fragmenting per CSS pixel. */
export const IMAGE_WIDTHS = [48, 96, 160, 256, 420, 640, 900, 1280, 1600, 2048] as const;
export interface ImageOptions { width?: number; quality?: number; fit?: string; format?: string }
const imageHost = (host: string) =>
  // [SAATHUM-DEBRAND-1 2026-09-27] media.saathum.com replaced blossom.avatok.ai
  // (stored URLs migrated). A leftover old-host URL is simply served untransformed.
  // Former-domain hosts are deliberately NOT listed here: this file ships to browsers and the
  // old domain must not appear in client code. Such stored URLs are served untransformed.
  host === BRAND.domain || host.endsWith(`.${BRAND.domain}`);
const privateImagePath = (path: string) => /(?:^|\/)(?:private|private-read|api|verification)(?:\/|$)/i.test(path);
const rasterPath = (path: string) => /\.(?:png|jpe?g|webp|avif)$/i.test(path);
function imageParams(opts: ImageOptions): string {
  const wanted = Number.isFinite(opts.width) ? Math.max(1, opts.width!) : 256;
  const width = IMAGE_WIDTHS.find(value => value >= wanted) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  const quality = Number.isFinite(opts.quality) ? Math.max(1, Math.min(100, Math.round(opts.quality!))) : 60;
  const fit = ['cover', 'contain', 'scale-down', 'crop', 'pad'].includes(opts.fit ?? '') ? opts.fit : 'cover';
  const format = ['auto', 'avif', 'webp', 'jpeg'].includes(opts.format ?? '') ? opts.format : 'avif';
  return `format=${format},quality=${quality},width=${width},fit=${fit}`;
}

/** Public API media only. Signed/private/external URLs retain their original URL. */
export function cfImage(path: string, opts: ImageOptions = {}): string {
  if (!path) return path;
  try {
    const u = new URL(path, API_BASE);
    if (!['https:', 'http:'].includes(u.protocol) || !imageHost(u.hostname) || u.username || u.password) return path;
    if (u.search || u.hash || privateImagePath(u.pathname) || u.pathname.startsWith('/cdn-cgi/image/')) return path;
    if (/\.(?:svg|gif)$/i.test(u.pathname)) return path;
    return `${u.origin}/cdn-cgi/image/${imageParams(opts)}${u.pathname}`;
  } catch { return path; }
}

/**
 * [WEB-OG-SHARE-1 2026-09-29] OWNER DECISION: a shared link previews with the
 * page's OWN main photo (listing hero, article picture, homepage hero) — not a
 * branded text card. This turns that photo into a WhatsApp/Facebook-friendly
 * og:image: 1200x630 JPEG (JPEG, not AVIF: WhatsApp drops AVIF previews),
 * crop biased to the upper part (faces, crowns, peaks sit high). Accepts a raw URL, a site path, or an already-
 * transformed /cdn-cgi/image/ URL (its params are replaced). Returns undefined
 * for anything that must not become a public share image.
 */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;
export function shareImage(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const u = new URL(path, BRAND.webOrigin);
    if (u.protocol !== 'https:' || !imageHost(u.hostname) || u.username || u.password || u.search || u.hash) return undefined;
    let source = u.pathname;
    const transformed = source.match(/^\/cdn-cgi\/image\/[^/]+(\/.+)$/);
    if (transformed) source = transformed[1];
    if (privateImagePath(source) || /\.(?:svg|gif)$/i.test(source)) return undefined;
    if (u.hostname === BRAND.domain) source = (publicImageManifest as Record<string, string>)[source] ?? source;
    return `${u.origin}/cdn-cgi/image/format=jpeg,quality=80,width=${SHARE_IMAGE.width},height=${SHARE_IMAGE.height},fit=cover,gravity=0.5x0.35${source}`;
  } catch { return undefined; }
}

/** Website assets stay on the website origin, never API_BASE. */
export function publicImage(path: string, opts: ImageOptions = {}): string {
  // Astro dev has no Cloudflare transformation endpoint.
  if (!path || import.meta.env.DEV || import.meta.env.PUBLIC_DISABLE_IMAGE_TRANSFORMS === '1') return path;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(path);
    const u = new URL(path, BRAND.webOrigin);
    if (!['https:', 'http:'].includes(u.protocol) || !imageHost(u.hostname) || u.username || u.password) return path;
    if (u.search || u.hash || privateImagePath(u.pathname) || !rasterPath(u.pathname)) return path;
    if (u.pathname.startsWith('/cdn-cgi/image/')) return path;
    const origin = absolute ? u.origin : '';
    const source = (!absolute || u.hostname === BRAND.domain) ? (publicImageManifest as Record<string, string>)[u.pathname] ?? u.pathname : u.pathname;
    return `${origin}/cdn-cgi/image/${imageParams(opts)}${source}`;
  } catch { return path; }
}

export function publicImageSrcSet(path: string, widths: readonly number[], opts: Omit<ImageOptions, 'width'> = {}): string {
  const variants = [...new Set(widths.map(width => IMAGE_WIDTHS.find(value => value >= width) ?? 2048))];
  return variants.map(width => `${publicImage(path, { ...opts, width })} ${width}w`).join(', ');
}
