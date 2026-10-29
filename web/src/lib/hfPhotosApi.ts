/* [HF-MOD-WEB-PHOTOS] A fan's own profile photo and cover, checked by AI before anyone sees it.
 * Worker: PUT /api/hf/me/photo and PUT /api/hf/me/cover (raw JPEG bytes, answers 202 {ok,id,status:'checking',message}),
 * GET /api/hf/me/photos ({ok, photos:{profile,cover}}). Switch: hfPhotoModerationEnabled in GET /api/config. */
import { request } from './apiClient';
import { API_BASE } from './env';

export type PhotoKind = 'profile' | 'cover';
export interface PhotoSlot { url: string | null; checking: boolean; refused: string | null }
export interface MyPhotos { profile: PhotoSlot; cover: PhotoSlot }

let cfg: Promise<boolean> | null = null;
/** hfPhotoModerationEnabled from /api/config (one request per page). Any failure counts as off. */
export function photoModerationEnabled(): Promise<boolean> {
  if (!cfg) cfg = request<{ hfPhotoModerationEnabled?: boolean }>('/api/config', { timeoutMs: 8000 }).then((c) => c?.hfPhotoModerationEnabled === true).catch(() => false);
  return cfg;
}

export const LIMITS = { maxBytes: 4 * 1024 * 1024, profileMin: [200, 200], coverMin: [640, 200] } as const;

const slot = (v: unknown): PhotoSlot => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const refused = o.refused;
  return { url: typeof o.url === 'string' && o.url ? o.url : null, checking: o.checking === true, refused: typeof refused === 'string' && refused ? refused : refused ? 'This photo was not accepted.' : null };
};

export async function getMyPhotos(): Promise<MyPhotos | null> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return null;
  try {
    const j = await request<{ ok?: boolean; photos?: { profile?: unknown; cover?: unknown } }>('/api/hf/me/photos', { method: 'GET', auth: token, timeoutMs: 15000 });
    if (!j || j.ok === false || !j.photos) return null;
    return { profile: slot(j.photos.profile), cover: slot(j.photos.cover) };
  } catch { return null; }
}

export type UploadResult = { ok: true; message: string } | { ok: false; error: string; message: string };

/** Sends the shrunk JPEG as raw bytes. The server answers 202 and checks the picture in the background. */
export async function putMyImage(kind: PhotoKind, blob: Blob): Promise<UploadResult> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return { ok: false, error: 'no_session', message: 'Please sign in again to save your photo.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${API_BASE}/api/hf/me/${kind === 'profile' ? 'photo' : 'cover'}`, { method: 'PUT', body: blob, cache: 'no-store', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' } });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; message?: string };
    if (res.ok && j.ok !== false) return { ok: true, message: j.message || '' };
    return { ok: false, error: String(j.error ?? `http_${res.status}`), message: j.message || 'We could not save that photo. Please try again.' };
  } catch { return { ok: false, error: 'network', message: 'We could not reach the server. Check your internet and try again.' }; } finally { clearTimeout(timer); }
}

const MAX_SIDE = { profile: 1080, cover: 1600 } as const;

/** Shrinks in the browser: profile = centre-crop square up to 1080, cover = up to 1600 wide keeping its shape. JPEG at 0.8. */
export async function shrinkImage(file: File, kind: PhotoKind): Promise<{ blob: Blob; width: number; height: number } | null> {
  let src: ImageBitmap | HTMLImageElement | null = null;
  let url: string | null = null;
  try {
    if (typeof createImageBitmap === 'function') {
      try { src = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions); } catch { src = null; }
    }
    if (!src) {
      url = URL.createObjectURL(file);
      const im = new Image();
      im.decoding = 'async';
      await new Promise<void>((ok, bad) => { im.onload = () => ok(); im.onerror = () => bad(new Error('decode')); im.src = url as string; });
      src = im;
    }
    const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
    const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
    if (!sw || !sh) return null;
    let sx = 0, sy = 0, cw = sw, ch = sh, ow: number, oh: number;
    if (kind === 'profile') {
      const side = Math.min(sw, sh); sx = Math.floor((sw - side) / 2); sy = Math.floor((sh - side) / 2); cw = ch = side;
      ow = oh = Math.min(MAX_SIDE.profile, side);
    } else {
      const k = Math.min(1, MAX_SIDE.cover / sw); ow = Math.max(1, Math.round(sw * k)); oh = Math.max(1, Math.round(sh * k));
    }
    let blob: Blob | null = null;
    if (typeof OffscreenCanvas === 'function') {
      try {
        const oc = new OffscreenCanvas(ow, oh); const g = oc.getContext('2d');
        if (g) { g.imageSmoothingQuality = 'high'; g.drawImage(src, sx, sy, cw, ch, 0, 0, ow, oh); blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.8 }); }
      } catch { blob = null; }
    }
    if (!blob) {
      const c = document.createElement('canvas'); c.width = ow; c.height = oh;
      const g = c.getContext('2d'); if (!g) return null;
      g.imageSmoothingQuality = 'high'; g.drawImage(src, sx, sy, cw, ch, 0, 0, ow, oh);
      blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
    }
    return blob ? { blob, width: ow, height: oh } : null;
  } catch { return null; } finally {
    if (src && 'close' in src && typeof src.close === 'function') src.close();
    if (url) URL.revokeObjectURL(url);
  }
}
