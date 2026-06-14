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

/**
 * Cloudflare image-transform helper — the avatar/poster URL pattern used across
 * the kit. Produces `/cdn-cgi/image/format=avif,quality=60,width=N,fit=cover/<path>`.
 * Pass an already-absolute origin path or a full URL.
 */
export function cfImage(
  path: string,
  opts: { width?: number; quality?: number; fit?: string; format?: string } = {},
): string {
  if (!path) return path;
  const { width = 256, quality = 60, fit = 'cover', format = 'avif' } = opts;
  const params = `format=${format},quality=${quality},width=${width},fit=${fit}`;
  // Absolute URL → splice the transform segment after the origin.
  try {
    const u = new URL(path);
    return `${u.origin}/cdn-cgi/image/${params}${u.pathname}${u.search}`;
  } catch {
    // Relative path → resolve against the API origin.
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `${API_BASE}/cdn-cgi/image/${params}${clean}`;
  }
}
