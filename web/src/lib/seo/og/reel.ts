/* [HF-EXPLORE-PUBLIC-1] Share image of one public reel: /og/reel/<hfrl_… | hfiv_…>.png, 720x1280 (vertical, like the reel itself).
 * The reel's thumbnail full-bleed (object-fit cover), a soft dark gradient at the bottom, and the marigold "Call <Creator>" pill
 * (40px from the sides, 56px from the bottom, 112px tall, 40px heavy text). No icons, no other text.
 * The record comes from the PUBLIC reels API only (GET /api/hf/reels/:id), so a hidden / unknown reel is a 404. The thumbnail is fetched
 * only from a short allow-list of image CDNs over https, with a size cap and a timeout; if it cannot be read the card is the dark
 * background with the pill alone. */
import { createElement as h } from 'react';
import { API_BASE } from '../../env';
import { BRAND } from '../../brand';
import { whoOf, type ReelItem } from '../../hfExplore';
import { fontBase64 } from './assets.generated';
import { readBoundedImage } from './public-art';
import { decodeBase64 } from './renderer';
import { sha256 } from './revision';

const W = 720;
const H = 1280;
const safetyHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };
const ID = /^(?:hfrl|hfiv)_[a-z0-9]{8,40}$/;
/** Hosts a reel thumbnail may come from (YouTube, Instagram / Facebook CDNs, and our own media host). */
const THUMB_HOSTS = [/(^|\.)ytimg\.com$/i, /(^|\.)ggpht\.com$/i, /(^|\.)googleusercontent\.com$/i, /(^|\.)cdninstagram\.com$/i, /(^|\.)fbcdn\.net$/i];

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { ...safetyHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}

function thumbAllowed(raw: string | null | undefined): URL | null {
  try {
    if (!raw || raw.length > 2048) return null;
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const media = new URL(BRAND.mediaOrigin).hostname;
    return u.hostname === media || THUMB_HOSTS.some(re => re.test(u.hostname)) ? u : null;
  } catch { return null; }
}

async function thumbData(raw: string | null | undefined): Promise<string | null> {
  const u = thumbAllowed(raw);
  if (!u) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(u, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { Accept: 'image/jpeg,image/png' } });
    return await readBoundedImage(res);
  } catch { return null; } finally { clearTimeout(timer); }
}

const clip = (v: string, n: number): string => { const a = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()); return a.length <= n ? a.join('') : a.slice(0, n - 1).join('').trimEnd() + '…'; };

export function reelTemplate(name: string, thumb: string | null) {
  const label = `Call ${clip(name, 22)}`;
  return h('div', { style: { width: W, height: H, display: 'flex', position: 'relative', overflow: 'hidden', backgroundColor: '#0E0A12', fontFamily: 'Comfortaa', fontWeight: 700 } },
    thumb ? h('img', { src: thumb, width: W, height: H, style: { position: 'absolute', left: 0, top: 0, width: W, height: H, objectFit: 'cover' } }) : null,
    h('div', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 520, display: 'flex', backgroundImage: 'linear-gradient(to top, rgba(14,10,18,0.88), rgba(14,10,18,0))' } }),
    h('div', { style: { position: 'absolute', left: 40, right: 40, bottom: 56, height: 112, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 56, backgroundColor: '#FFB000', color: '#2B1530', fontSize: 40, fontWeight: 700 } }, label),
  );
}

function isReelPng(bytes: Uint8Array): boolean {
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(16) === W && v.getUint32(20) === H;
}

export async function reelOgResponse(request: Request, key: string): Promise<Response> {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  const version = url.searchParams.get('v');
  if (keys.length > 1 || keys.some(k => k !== 'v') || (version !== null && !/^[a-zA-Z0-9]{1,64}$/.test(version))) return plain(400, 'Invalid image request');
  if (!ID.test(key)) return plain(404, 'Not found');
  let item: ReelItem | null = null;
  try {
    const res = await fetch(`${API_BASE}/api/hf/reels/${key}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3500) });
    if (res.status === 404) return plain(404, 'Not found');
    if (!res.ok) return plain(503, 'Temporarily unavailable', { 'Retry-After': '60' });
    item = ((await res.json()) as { item?: ReelItem }).item ?? null;
  } catch { return plain(503, 'Temporarily unavailable', { 'Retry-After': '60' }); }
  if (!item || item.id !== key) return plain(404, 'Not found');

  const thumb = await thumbData(item.thumbUrl);
  let bytes: Uint8Array;
  try {
    const { ImageResponse } = await import('cf-workers-og/workerd');
    const response = await ImageResponse.create(reelTemplate(whoOf(item).name, thumb), {
      width: W, height: H, format: 'png',
      fonts: [{ name: 'Comfortaa', data: decodeBase64(fontBase64), weight: 700, style: 'normal' }],
    });
    bytes = new Uint8Array(await response.arrayBuffer());
    if (!isReelPng(bytes)) throw new Error('reel OG renderer returned an invalid raster');
  } catch { return plain(503, 'Temporarily unavailable', { 'Retry-After': '60' }); }

  const etag = `"${await sha256(bytes)}"`;
  const headers = new Headers({ ...safetyHeaders, 'Content-Type': 'image/png', ETag: etag, 'Cache-Control': 'public, max-age=300, s-maxage=300, must-revalidate', 'Content-Length': String(bytes.byteLength) });
  if (request.headers.get('If-None-Match')?.split(',').some(v => v.trim().replace(/^W\//, '') === etag || v.trim() === '*')) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
}
