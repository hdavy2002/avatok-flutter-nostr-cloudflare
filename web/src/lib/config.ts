import publicImageManifest from './publicImageManifest.json';
// Runtime config for the web client. PUBLIC_* vars are inlined into the browser
// bundle by Astro/Vite. The API base is the SAME Worker the Flutter app calls
// (MASTER-PROMPT §3/§4) — never a new backend.

/** Base URL for every API call. Defaults to prod; override via PUBLIC_API_BASE. */
export const API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? 'https://api.avatok.ai';

/** Clerk publishable key for web auth/session. May be undefined until set in env. */
export const CLERK_PUBLISHABLE_KEY: string | undefined = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * Native-app store links for the "get the app to watch" CTAs. Env-driven so a
 * button only renders once its store listing is actually public — set
 * PUBLIC_PLAY_STORE_URL when the Android listing goes live (package
 * ai.avatok.avatok_call) and PUBLIC_APP_STORE_URL when iOS ships. Until then the
 * CTA shows web-viewing only, with no dead store links.
 */
export const PLAY_STORE_URL: string | undefined = import.meta.env.PUBLIC_PLAY_STORE_URL || undefined;
export const APP_STORE_URL: string | undefined = import.meta.env.PUBLIC_APP_STORE_URL || undefined;

/** True when at least one native app store listing is live and linkable. */
export const HAS_NATIVE_APP: boolean = Boolean(PLAY_STORE_URL || APP_STORE_URL);

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

/** Bounded variants keep the image cache from fragmenting per CSS pixel. */
export const IMAGE_WIDTHS = [48, 96, 160, 256, 420, 640, 900, 1280, 1600, 2048] as const;
export interface ImageOptions { width?: number; quality?: number; fit?: string; format?: string }
const imageHost = (host: string) => host === 'avatok.ai' || host.endsWith('.avatok.ai');
const privateImagePath = (path: string) => /(?:^|\/)(?:private|private-read|api|verification)(?:\/|$)/i.test(path);
const rasterPath = (path: string) => /\.(?:png|jpe?g|webp|avif)$/i.test(path);
function imageParams(opts: ImageOptions): string {
  const wanted = Number.isFinite(opts.width) ? Math.max(1, opts.width!) : 256;
  const width = IMAGE_WIDTHS.find(value => value >= wanted) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  const quality = Number.isFinite(opts.quality) ? Math.max(1, Math.min(100, Math.round(opts.quality!))) : 60;
  const fit = ['cover', 'contain', 'scale-down', 'crop', 'pad'].includes(opts.fit ?? '') ? opts.fit : 'cover';
  const format = ['auto', 'avif', 'webp', 'jpeg'].includes(opts.format ?? '') ? opts.format : 'auto';
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

/** Website assets stay on the website origin, never API_BASE. */
export function publicImage(path: string, opts: ImageOptions = {}): string {
  // Astro dev has no Cloudflare transformation endpoint.
  if (!path || import.meta.env.DEV || import.meta.env.PUBLIC_DISABLE_IMAGE_TRANSFORMS === '1') return path;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(path);
    const u = new URL(path, 'https://avatok.ai');
    if (!['https:', 'http:'].includes(u.protocol) || !imageHost(u.hostname) || u.username || u.password) return path;
    if (u.search || u.hash || privateImagePath(u.pathname) || !rasterPath(u.pathname)) return path;
    if (u.pathname.startsWith('/cdn-cgi/image/')) return path;
    const origin = absolute ? u.origin : '';
    const source = (!absolute || u.hostname === 'avatok.ai') ? (publicImageManifest as Record<string, string>)[u.pathname] ?? u.pathname : u.pathname;
    return `${origin}/cdn-cgi/image/${imageParams(opts)}${source}`;
  } catch { return path; }
}

export function publicImageSrcSet(path: string, widths: readonly number[], opts: Omit<ImageOptions, 'width'> = {}): string {
  const variants = [...new Set(widths.map(width => IMAGE_WIDTHS.find(value => value >= width) ?? 2048))];
  return variants.map(width => `${publicImage(path, { ...opts, width })} ${width}w`).join(', ');
}
