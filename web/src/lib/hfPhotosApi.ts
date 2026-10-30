/* [HF-MOD-WEB-PHOTOS] A fan's own profile photo and cover, checked by AI before anyone sees it.
 * Worker: PUT /api/hf/me/photo and PUT /api/hf/me/cover (raw JPEG bytes, answers 202 {ok,id,status:'checking',message}),
 * GET /api/hf/me/photos ({ok, photos:{profile,cover}}). Switch: hfPhotoModerationEnabled in GET /api/config. */
import { request } from './apiClient';
import { API_BASE } from './env';
import { publicConfig } from './hfConfig'; // [HF-DASH-CACHE-1]
import { capture } from './analytics';
import { isSupportHost, isSupportPath } from './supportHost';

export type PhotoKind = 'profile' | 'cover';
export interface PhotoSlot { url: string | null; checking: boolean; refused: string | null }
/** `complete` is the server's photos_complete (null when the server did not say); `missing` lists 'profile' / 'cover'. */
export interface MyPhotos { profile: PhotoSlot; cover: PhotoSlot; complete: boolean | null; missing: string[] }

function readFlags() { // [HF-DASH-CACHE-1] the one shared /api/config request
  return publicConfig().then((c) => ({ moderation: c.hfPhotoModerationEnabled === true, required: c.hfPhotosRequiredEnabled === true }));
}
/** hfPhotoModerationEnabled from /api/config (one request per page). Any failure counts as off. */
export function photoModerationEnabled(): Promise<boolean> { return readFlags().then((f) => f.moderation); }
/** [HF-PHOTO-CROP-WEB] hfPhotosRequiredEnabled from /api/config. Any failure counts as off (the gate fails open). */
export function photosRequiredEnabled(): Promise<boolean> { return readFlags().then((f) => f.required); }

/* ── [HF-PHOTO-CROP-WEB] mandatory photo gate ───────────────────────────────────────────────────────────────────── */
const GATE_KEY = 'hf_photos_gate_v1';
const GATE_MSG_KEY = 'hf_photos_gate_msg';
const GATE_TTL_MS = 3 * 60_000;
export interface GateStatus { complete: boolean | null; missing: string[] }

function ssGet(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k: string, v: string): void { try { sessionStorage.setItem(k, v); } catch { /* storage may be blocked */ } }
function ssDel(k: string): void { try { sessionStorage.removeItem(k); } catch { /* storage may be blocked */ } }

export function cacheGateStatus(uid: string, s: GateStatus): void { ssSet(GATE_KEY, JSON.stringify({ uid, t: Date.now(), ...s })); }
/** Call after any upload so the next page does not act on a stale "incomplete". */
export function clearPhotoGateCache(): void { ssDel(GATE_KEY); }
/** Is the signed-in member's photo set complete? Cached a few minutes. complete:null = unknown (API error): callers fail open. */
export async function photoGateStatus(uid: string): Promise<GateStatus> {
  const raw = ssGet(GATE_KEY);
  if (raw) {
    try {
      const c = JSON.parse(raw) as { uid?: string; t?: number; complete?: boolean | null; missing?: string[] };
      if (c.uid === uid && typeof c.t === 'number' && Date.now() - c.t < GATE_TTL_MS && typeof c.complete === 'boolean') return { complete: c.complete, missing: Array.isArray(c.missing) ? c.missing : [] };
    } catch { /* ignore a broken cache entry */ }
  }
  const p = await getMyPhotos();
  if (!p || p.complete === null) return { complete: null, missing: [] };
  const s = { complete: p.complete, missing: p.missing };
  cacheGateStatus(uid, s);
  return s;
}

/** True on the support desk (its own host, or /support-desk on the main host). The gate must never run there. */
export function onSupportDesk(): boolean {
  if (typeof location === 'undefined') return false;
  return isSupportHost(location.hostname) || isSupportPath(location.pathname);
}

/** Only same-site relative paths are allowed as a return target. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  return raw;
}

export function onboardingUrl(next?: string | null): string {
  const n = safeNext(next ?? undefined);
  return `/dashboard/my-photo?onboarding=1${n ? `&next=${encodeURIComponent(n)}` : ''}`;
}
export function takeGateMessage(): string | null { const m = ssGet(GATE_MSG_KEY); ssDel(GATE_MSG_KEY); return m; }

/** Sends the member to the photo onboarding page. Returns false (and does nothing) on the support desk. */
export function redirectToPhotoOnboarding(source: string, message?: string): boolean {
  if (typeof location === 'undefined' || onSupportDesk()) return false;
  if (message) ssSet(GATE_MSG_KEY, message);
  clearPhotoGateCache();
  capture('hf_photo_gate_redirect', { source });
  const here = location.pathname + location.search;
  location.assign(onboardingUrl(location.pathname.startsWith('/dashboard/my-photo') ? null : here));
  return true;
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
    const j = await request<{ ok?: boolean; photos?: { profile?: unknown; cover?: unknown }; photos_complete?: unknown; photos_missing?: unknown }>('/api/hf/me/photos', { method: 'GET', auth: token, timeoutMs: 15000 });
    if (!j || j.ok === false || !j.photos) return null;
    return {
      profile: slot(j.photos.profile), cover: slot(j.photos.cover),
      complete: typeof j.photos_complete === 'boolean' ? j.photos_complete : null,
      missing: Array.isArray(j.photos_missing) ? j.photos_missing.filter((m): m is string => typeof m === 'string') : [],
    };
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
    if (res.ok && j.ok !== false) { clearPhotoGateCache(); return { ok: true, message: j.message || '' }; }
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

/* ── [HF-PHOTO-CROP-WEB] crop editor support ────────────────────────────────────────────────────────────────────── */
export type PhotoSource = { src: CanvasImageSource; width: number; height: number; close: () => void };

/** Decodes a picked file with its EXIF orientation applied (createImageBitmap from-image, with an <img> fallback). */
export async function decodePhoto(file: File): Promise<PhotoSource | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        const bm = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
        if (bm.width && bm.height) return { src: bm, width: bm.width, height: bm.height, close: () => bm.close() };
      } catch { /* fall through to <img> */ }
    }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.decoding = 'async';
    try { await new Promise<void>((ok, bad) => { im.onload = () => ok(); im.onerror = () => bad(new Error('decode')); im.src = url; }); } finally { URL.revokeObjectURL(url); }
    if (!im.naturalWidth || !im.naturalHeight) return null;
    return { src: im, width: im.naturalWidth, height: im.naturalHeight, close: () => undefined };
  } catch { return null; }
}

export const CROP_ASPECT = { profile: 1, cover: 3 } as const;
const CROP_MAX = { profile: 1080, cover: 1500 } as const;
const CROP_MIN_W = { profile: 200, cover: 640 } as const;
export const CROP_MAX_ZOOM = 4;

/** Widest crop (source pixels) at zoom 1: the image always covers the frame. */
export const cropBaseWidth = (kind: PhotoKind, iw: number, ih: number): number => Math.min(iw, ih * CROP_ASPECT[kind]);
/** Biggest zoom that still leaves a crop at least as wide as the minimum output. < 1 means the picture is too small to use. */
export const cropMaxZoom = (kind: PhotoKind, iw: number, ih: number): number => Math.min(CROP_MAX_ZOOM, cropBaseWidth(kind, iw, ih) / CROP_MIN_W[kind]);

/** Crops exactly the visible window: centre (cx, cy) in source pixels, crop width = base / zoom. JPEG 0.8. */
export async function cropPhoto(p: PhotoSource, kind: PhotoKind, cx: number, cy: number, zoom: number): Promise<{ blob: Blob; width: number; height: number } | null> {
  const aspect = CROP_ASPECT[kind];
  const sw = cropBaseWidth(kind, p.width, p.height) / zoom, sh = sw / aspect;
  const sx = Math.max(0, Math.min(p.width - sw, cx - sw / 2)), sy = Math.max(0, Math.min(p.height - sh, cy - sh / 2));
  const ow = Math.max(1, Math.min(CROP_MAX[kind], Math.round(sw))), oh = Math.max(1, Math.round(ow / aspect));
  if (ow < CROP_MIN_W[kind]) return null;
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas === 'function') {
    try {
      const oc = new OffscreenCanvas(ow, oh); const g = oc.getContext('2d');
      if (g) { g.imageSmoothingQuality = 'high'; g.drawImage(p.src, sx, sy, sw, sh, 0, 0, ow, oh); blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.8 }); }
    } catch { blob = null; }
  }
  if (!blob) {
    const c = document.createElement('canvas'); c.width = ow; c.height = oh;
    const g = c.getContext('2d'); if (!g) return null;
    g.imageSmoothingQuality = 'high'; g.drawImage(p.src, sx, sy, sw, sh, 0, 0, ow, oh);
    blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
  }
  return blob ? { blob, width: ow, height: oh } : null;
}
