// Runtime config for the web client. PUBLIC_* vars are inlined into the browser
// bundle by Astro/Vite. The API base is the SAME Worker the Flutter app calls
// (MASTER-PROMPT §3/§4) — never a new backend.

/** Base URL for every API call. Defaults to prod; override via PUBLIC_API_BASE. */
export const API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? 'https://api.avatok.ai';

/** Clerk publishable key for web auth/session. May be undefined until set in env. */
export const CLERK_PUBLISHABLE_KEY: string | undefined = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY;

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
