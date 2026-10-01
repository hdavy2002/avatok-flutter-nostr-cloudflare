// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] Thin typed wrappers over the public shop API
// (Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.1). Every call goes through request() so the
// api_error telemetry and ApiError contract are the site-wide ones. Responses are returned
// AS THE API SENDS THEM (e.g. getQuote -> { quote }), nothing is unwrapped.
//
// NOTE FOR AI: other shop surfaces (checkout, dashboard, admin) import these types and
// functions. Keep the names and shapes stable — they mirror the worker contract exactly.
import { request } from './apiClient';

export interface ShopColour { name: string; hex: string }

export interface ShopCard {
  id: string;
  slug: string;
  name: string;
  price_rupees: number;
  mrp_rupees: number | null;
  off_pct: number | null;
  badge: '' | 'new' | 'best' | 'sale';
  colours: ShopColour[];
  sizes: string[];
  image_url: string | null;
  collection: { slug: string; name: string } | null;
}

export interface ShopProduct extends ShopCard {
  description: string;
  fit: string;
  print_type: string;
  audience: string;
  images: { url: string; label: string }[];
  seo_title: string | null;
  seo_description: string | null;
}

export interface ShopHotspot { x: number; y: number; product: ShopCard }

export interface ShopHero {
  image_url?: string | null;
  eyebrow?: string;
  title?: string;
  title_em?: string;
  lead?: string;
  cta_label?: string;
  second_cta_collection?: string | null;
  ticks?: string[];
  promise?: { title: string; sub: string }[];
  hotspots?: ShopHotspot[];
}

export interface ShopCollectionTile { id: string; slug: string; name: string; blurb: string; image_url: string | null; count: number }

export interface ShopFeaturedBanner {
  eyebrow: string;
  title: string;
  text: string;
  cta_label: string;
  image_url: string | null;
  product: ShopCard;
}

export interface ShopHome {
  hero: ShopHero | null;
  collections: ShopCollectionTile[];
  new_arrivals: ShopCard[];
  featured_banner: ShopFeaturedBanner | null;
  bestsellers: ShopCard[];
}

export interface ShopFacets {
  collections: { slug: string; name: string; count: number }[];
  colours: { name: string; hex: string; count: number }[];
  sizes: { size: string; count: number }[];
  fits: { value: string; count: number }[];
  prints: { value: string; count: number }[];
  audiences: { value: string; count: number }[];
  price: { min: number; max: number };
}

export interface ShopListResult { items: ShopCard[]; total: number; facets: ShopFacets }

type Multi = string | string[] | undefined;
export interface ShopListParams {
  collection?: Multi; colour?: Multi; size?: Multi; fit?: Multi; print?: Multi; for?: Multi;
  min?: number; max?: number;
  sort?: 'feat' | 'new' | 'lo' | 'hi' | 'best';
  tag?: 'new' | 'best' | 'sale';
  ids?: Multi;
  q?: string;
}

export interface ShopCartItem { product_id: string; colour: string; size: string; qty: number }
export interface ShopQuoteLine {
  product_id: string; slug: string; name: string; colour: string; size: string; qty: number;
  unit_rupees: number; amount_rupees: number; image_url: string | null;
}
export interface ShopQuote {
  lines: ShopQuoteLine[];
  subtotal_rupees: number;
  discount_rupees: number;
  coupon_code: string | null;
  taxable_rupees: number;
  gst_rate_pct: number;
  gst_rupees: number;
  shipping_rupees: 0;
  total_rupees: number;
}

const join = (v: Multi): string | undefined => {
  if (v == null) return undefined;
  const list = (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
  return list.length ? list.join(',') : undefined;
};

/** GET /api/shop/home */
export function getHome(signal?: AbortSignal): Promise<ShopHome> {
  return request<ShopHome>('/api/shop/home', { signal });
}

/** GET /api/shop/products — multi-value params are sent comma-separated. */
export function listProducts(params: ShopListParams = {}, signal?: AbortSignal): Promise<ShopListResult> {
  return request<ShopListResult>('/api/shop/products', {
    signal,
    query: {
      collection: join(params.collection), colour: join(params.colour), size: join(params.size),
      fit: join(params.fit), print: join(params.print), for: join(params.for), ids: join(params.ids),
      min: params.min, max: params.max, sort: params.sort, tag: params.tag, q: params.q?.trim() || undefined,
    },
  });
}

/** GET /api/shop/products/:slug — 404 `not_found` (ApiError) unless live. */
export function getProduct(slug: string, signal?: AbortSignal): Promise<{ product: ShopProduct; also_like: ShopCard[] }> {
  return request<{ product: ShopProduct; also_like: ShopCard[] }>(`/api/shop/products/${encodeURIComponent(slug)}`, { signal });
}

/** POST /api/shop/quote — public; 400 `{error, message, line?}` (ApiError.body) on an invalid cart/coupon. */
export function getQuote(items: ShopCartItem[], coupon?: string, signal?: AbortSignal): Promise<{ quote: ShopQuote }> {
  return request<{ quote: ShopQuote }>('/api/shop/quote', {
    method: 'POST',
    body: { items, ...(coupon ? { coupon } : {}) },
    signal,
  });
}

/**
 * GST shown on the product page's tax line ("+ 18% GST at checkout"). Read from the public platform
 * config (gstRatePct / saathumGstEnabled) — never typed into a page. Falls back to the contract's
 * 18% / enabled when the config cannot be read, so the page never breaks on it.
 */
export async function getShopGst(signal?: AbortSignal): Promise<{ rate: number; enabled: boolean }> {
  try {
    const cfg = await request<{ gstRatePct?: number; saathumGstEnabled?: boolean }>('/api/config', { signal });
    const rate = Number(cfg.gstRatePct);
    return { rate: Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 18, enabled: cfg.saathumGstEnabled !== false };
  } catch {
    return { rate: 18, enabled: true };
  }
}
