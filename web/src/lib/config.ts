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
const imageHost = (host: string) => ['avatok.ai', 'www.avatok.ai', 'staging.avatok.ai', 'api.avatok.ai', 'api-staging.avatok.ai', 'blossom.avatok.ai', 'blossom-staging.avatok.ai'].includes(host);
const privateImagePath = (path: string) => /(?:^|\/)(?:private|private-read|api|verification|dm|ava-readable)(?:\/|$)/i.test(path);
const rasterPath = (path: string) => /\.(?:png|jpe?g|webp|avif)$/i.test(path);
function imageParams(opts: ImageOptions): string {
  const wanted = Number.isFinite(opts.width) ? Math.max(1, opts.width!) : 256;
  const width = IMAGE_WIDTHS.find(value => value >= wanted) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
  // Browser images have one quality policy; JPEG is an explicit social-preview exception.
  const quality = opts.format === 'jpeg' && Number.isFinite(opts.quality) ? Math.max(1, Math.min(100, Math.round(opts.quality!))) : 60;
  const fit = ['cover', 'contain', 'scale-down', 'crop', 'pad'].includes(opts.fit ?? '') ? opts.fit : 'cover';
  const format = opts.format === 'jpeg' ? 'jpeg' : 'avif';
  return `format=${format},quality=${quality},width=${width},fit=${fit}`;
}

function existingImageOptions(path: string, opts: ImageOptions): ImageOptions {
  const match = path.match(/^\/cdn-cgi\/image\/([^/]+)\//);
  if (!match) return opts;
  const previous = Object.fromEntries(match[1].split(',').map(pair => pair.split('=')));
  return { width: Number(previous.width) || undefined, fit: previous.fit, ...opts };
}

/** Public API media only. Signed/private/external URLs retain their original URL. */
export function cfImage(path: string, opts: ImageOptions = {}): string {
  if (!path) return path;
  try {
    const u = new URL(path, API_BASE);
    if (!['https:', 'http:'].includes(u.protocol) || !imageHost(u.hostname) || u.username || u.password) return path;
    if (u.search || u.hash || (/%2f|%3f|%23|%25/i.test(u.pathname) || privateImagePath(decodeURIComponent(u.pathname)))) return path;
    // Never forward a nested remote source through our public image cache.
    const source = u.pathname.replace(/^\/cdn-cgi\/image\/[^/]+(?=\/)/, '');
    if (/\.(?:svg|gif)$/i.test(source) || /^\/(?:\/|https?:)/i.test(decodeURIComponent(source))) return path;
    const publicMedia = /^\/(?:u\/[^/]+\/public\/|public\/|affiliate-assets\/|[a-f0-9]{64}(?:\.[a-z]+)?$)/i.test(source);
    const websiteAsset = ['avatok.ai', 'www.avatok.ai', 'staging.avatok.ai'].includes(u.hostname) && rasterPath(source);
    if (!publicMedia && !websiteAsset) return path;
    return `${u.origin}/cdn-cgi/image/${imageParams(existingImageOptions(u.pathname, opts))}${source}`;
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
    if (u.search || u.hash || (/%2f|%3f|%23|%25/i.test(u.pathname) || privateImagePath(decodeURIComponent(u.pathname))) || !rasterPath(u.pathname)) return path;
    if (!['avatok.ai', 'www.avatok.ai', 'staging.avatok.ai'].includes(u.hostname)) return cfImage(path, opts);
    const original = u.pathname.replace(/^\/cdn-cgi\/image\/[^/]+(?=\/)/, '');
    if (/^\/(?:\/|https?:)/i.test(decodeURIComponent(original))) return path;
    const origin = absolute ? u.origin : '';
    const source = (!absolute || u.hostname === 'avatok.ai') ? (publicImageManifest as Record<string, string>)[original] ?? original : original;
    return `${origin}/cdn-cgi/image/${imageParams(existingImageOptions(u.pathname, opts))}${source}`;
  } catch { return path; }
}

export function publicImageSrcSet(path: string, widths: readonly number[], opts: Omit<ImageOptions, 'width'> = {}): string {
  const variants = [...new Set(widths.filter(width => Number.isFinite(width) && width > 0).map(width => IMAGE_WIDTHS.find(value => value >= width) ?? 2048))].sort((a, b) => a - b);
  return variants.map(width => `${publicImage(path, { ...opts, width })} ${width}w`).join(', ');
}
