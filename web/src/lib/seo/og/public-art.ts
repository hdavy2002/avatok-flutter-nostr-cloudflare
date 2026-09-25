import manifest from '../../publicImageManifest.json';

const ORIGIN = 'https://saathum.com';
const BLOSSOM_ORIGIN = 'https://blossom.avatok.ai';
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 2500;
const MAX_REDIRECTS = 2;
const publicPaths = new Set([...Object.keys(manifest), ...Object.values(manifest)]);

function unwrapTransform(pathname: string): string | null {
  if (!pathname.startsWith('/cdn-cgi/image/')) return pathname;
  const match = pathname.match(/^\/cdn-cgi\/image\/(?:format=jpeg,quality=80,width=900,fit=scale-down|format=jpeg,quality=70,width=1280,fit=cover)(\/.*)$/);
  return match?.[1] ?? null;
}

/** A stable content identity for committed assets; public uploads are already SHA-addressed. */
export function publicArtRevision(value: string): string {
  try {
    const url = new URL(value, ORIGIN);
    const path = unwrapTransform(url.pathname);
    if (!path) return value;
    if (url.origin === ORIGIN) return String((manifest as Record<string, string>)[path] ?? path);
    return `${url.origin}${path}`;
  } catch { return value; }
}

/** Exact committed public asset inventory, not a suffix/domain-wide allowlist. */
export function approvedArtUrl(value: string): URL | null {
  try {
    if (!value || value.length > 2048 || /[\\\u0000-\u0020]/.test(value)) return null;
    const url = new URL(value, ORIGIN);
    if (![ORIGIN, BLOSSOM_ORIGIN].includes(url.origin) || url.username || url.password || url.search || url.hash) return null;
    const path = unwrapTransform(url.pathname);
    if (!path) return null;
    if (/%|\/\.|(?:^|\/)(?:api|private|private-read|verification)(?:\/|$)/i.test(path)) return null;
    if (url.origin === ORIGIN) {
      if (!publicPaths.has(path) || !/\.(?:png|jpe?g|webp|avif)$/i.test(path)) return null;
    } else {
      const uploaded = /^\/u\/[A-Za-z0-9_-]{1,200}\/public\/[a-f0-9]{64}(?:\.(?:png|jpe?g|webp|avif))?$/i.test(path);
      const generatedPoster = /^\/u\/[A-Za-z0-9_-]{1,200}\/public\/posters\/[A-Za-z0-9._-]{1,200}\/[a-f0-9]{64}-(?:portrait|tablet|wide)\.png$/i.test(path);
      if (!uploaded && !generatedPoster) return null;
    }
    return url;
  } catch { return null; }
}

function safeRaster(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/png') {
    if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return safeDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (type !== 'image/jpeg' || bytes[0] !== 255 || bytes[1] !== 216) return false;
  // Read JPEG SOF dimensions before letting the renderer allocate decoded pixels.
  let pos = 2;
  while (pos + 3 < bytes.length) {
    if (bytes[pos++] !== 255) return false;
    while (bytes[pos] === 255) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) return false;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8) return false;
      return safeDimensions((bytes[pos + 5] << 8) | bytes[pos + 6], (bytes[pos + 3] << 8) | bytes[pos + 4]);
    }
    pos += length;
  }
  return false;
}

const safeDimensions = (width: number, height: number) =>
  width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 8_000_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

/** No cookies, auth, arbitrary hosts, SVG, request forwarding or unbounded downloads. */
export async function fetchPublicArt(value: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  let url = approvedArtUrl(value);
  if (!url) return null;
  let rawPath = unwrapTransform(url.pathname);
  if (!rawPath) return null;
  // A committed source asset is mutable by filename; fetch the same immutable
  // content-addressed object that publicArtRevision() put into the OG URL hash.
  if (url.origin === ORIGIN) rawPath = String((manifest as Record<string, string>)[rawPath] ?? rawPath);
  url = new URL(`/cdn-cgi/image/format=jpeg,quality=80,width=900,fit=scale-down${rawPath}`, url.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetcher(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'image/jpeg,image/png' },
      });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('Location');
        if (!location || redirects === MAX_REDIRECTS) return null;
        url = approvedArtUrl(new URL(location, url).href);
        if (!url) return null;
        continue;
      }
      const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
      const size = response.headers.get('Content-Length');
      if (!response.ok || !response.body || !['image/png','image/jpeg'].includes(type) ||
          (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES))) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          count += chunk.byteLength;
          if (count > MAX_BYTES) { await reader.cancel(); return null; }
          chunks.push(chunk);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return safeRaster(bytes, type) ? `data:${type};base64,${bytesToBase64(bytes)}` : null;
    }
  } catch { return null; }
  finally { clearTimeout(timer); }
  return null;
}
