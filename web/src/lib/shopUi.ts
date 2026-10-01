// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Tiny presentation helpers shared by the shop islands and pages
// (ported from Specs/shop-mockup/shop.js: inr(), shade(), the card's default size).
import { cfImage } from './config';
import type { ShopCard } from './shopApi';

/** ₹ with Indian digit grouping, no Intl dependency (identical on the server and in the browser). */
export function inr(n: number): string {
  const v = Math.round(Number(n) || 0);
  const neg = v < 0;
  const s = String(Math.abs(v));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (neg ? '-' : '') + '₹' + grouped;
}

/** The mockup's placeholder tint: the colour pulled 55% toward the paper tone. */
export function shade(hex: string | undefined | null): string {
  let h = (hex || '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) return '#efdcbf';
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  const n = parseInt(h.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * 0.45 + 239 * 0.55); g = Math.round(g * 0.45 + 220 * 0.55); b = Math.round(b * 0.45 + 191 * 0.55);
  return `rgb(${r},${g},${b})`;
}

/** Real photo through the Cloudflare image pipeline (width snaps to the site's bounded set). */
export function photo(url: string | null | undefined, width: number): string | null {
  return url ? cfImage(url, { width, fit: 'cover' }) : null;
}

/** Quick-add default size: the 2nd size, else the 1st (mockup rule). */
export function defaultSize(p: Pick<ShopCard, 'sizes'>): string {
  return p.sizes[1] || p.sizes[0] || '';
}

