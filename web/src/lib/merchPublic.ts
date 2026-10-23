/* [HF-MERCH-FAN-WEB-1] Server-side (SSR) readers for the PUBLIC merch routes. No auth, no browser APIs: safe to import from .astro pages,
 * sitemaps and llms.txt. Worker: GET /api/hf/merch/public/:host, /public/:host/:product, /sitemap (routes/hf_merch.ts).
 * Every reader answers null / a status word instead of throwing, so one slow API never breaks the influencer page. */
import { API_BASE } from './env';

export interface MerchColour { name: string; hex: string }
export interface MerchSize { size: string; pricePaise: number; inStock: boolean }
export interface PublicProduct { id: string; slug: string; title: string; imageUrl: string | null; colours: MerchColour[]; sizes: MerchSize[]; fromPricePaise: number; url: string }
export interface PublicProductFull extends PublicProduct {
  photos: string[]; description: string | null; side: 'front' | 'back'; maxQty: number;
  /** Not sent by the server yet; when it is, the product page shows it instead of the standard chart. */
  sizeChart?: { size: string; chestIn?: number; lengthIn?: number }[];
  /** [HF-MERCH-GST-2] GST rate in basis points (500 = 5%). Optional: the label falls back to 5%. */
  gstRateBps?: number;
}
/** [HF-MERCH-GST-2] "5" from 500 bps; falls back to 5 when the server did not send a rate. */
export const gstPct = (bps?: number | null): string => { const v = typeof bps === 'number' && bps > 0 ? bps / 100 : 5; return String(Number.isInteger(v) ? v : Number(v.toFixed(2))); };
export interface PublicHostRef { slug: string; displayName: string; avatarUrl: string | null }
export interface MerchSitemap { hosts: { slug: string; updatedAt: number }[]; products: { hostSlug: string; slug: string; updatedAt: number; imageUrl: string | null; title: string }[] }

const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
    let body: T | null = null;
    try { body = (await res.json()) as T; } catch { /* not json */ }
    return { status: res.status, body };
  } catch (e) {
    console.warn('[HF-MERCH-FAN-WEB-1] public merch fetch failed', path.replace(/[a-z0-9-]+$/i, ':x'), e instanceof Error ? e.message : String(e));
    return { status: 0, body: null };
  }
};

/** Live products of one influencer. null while the feature is off, the host is unknown, or the API is down. */
export async function fetchMerchHost(slug: string): Promise<{ host: PublicHostRef; checkoutEnabled: boolean; products: PublicProduct[] } | null> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
  const r = await get<{ ok: boolean; host: PublicHostRef; checkoutEnabled?: boolean; products?: PublicProduct[] }>(`/api/hf/merch/public/${slug}`);
  if (r.status !== 200 || !r.body?.ok || !r.body.host) return null;
  return { host: r.body.host, checkoutEnabled: r.body.checkoutEnabled === true, products: Array.isArray(r.body.products) ? r.body.products : [] };
}

export type MerchProductResult =
  | { status: 'ok'; host: PublicHostRef; checkoutEnabled: boolean; product: PublicProductFull }
  | { status: 'gone' | 'missing' | 'unavailable' };

/** One product page. 410 from the server means hidden or deleted: the page answers 410 and is not indexed. */
export async function fetchMerchProduct(hostSlug: string, productSlug: string): Promise<MerchProductResult> {
  if (!/^[a-z0-9-]{3,40}$/.test(hostSlug) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(productSlug)) return { status: 'missing' };
  const r = await get<{ ok: boolean; host: PublicHostRef; checkoutEnabled?: boolean; gstRateBps?: number; product: PublicProductFull }>(`/api/hf/merch/public/${hostSlug}/${productSlug}`);
  if (r.status === 410) return { status: 'gone' };
  if (r.status === 404) return { status: 'missing' };
  if (r.status !== 200 || !r.body?.ok || !r.body.product) return { status: 'unavailable' };
  return { status: 'ok', host: r.body.host, checkoutEnabled: r.body.checkoutEnabled === true, product: { ...r.body.product, gstRateBps: r.body.product.gstRateBps ?? r.body.gstRateBps } };
}

/** Everything live, for the sitemaps and llms.txt. null when the feature is off or the API is down. */
export async function fetchMerchSitemap(): Promise<MerchSitemap | null> {
  const r = await get<{ ok: boolean } & Partial<MerchSitemap>>('/api/hf/merch/sitemap');
  if (r.status !== 200 || !r.body?.ok) return null;
  return { hosts: Array.isArray(r.body.hosts) ? r.body.hosts : [], products: Array.isArray(r.body.products) ? r.body.products : [] };
}

/** All live influencers, page by page (the public list is capped at 48 a page). Bounded so a runaway list cannot hang a sitemap. */
export interface LiveHost { slug: string; displayName: string; avatarUrl: string | null; tagline: string | null }
export async function fetchLiveHosts(maxPages = 40): Promise<LiveHost[]> {
  const out: LiveHost[] = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await get<Partial<LiveHost>[]>(`/api/hosts/public?limit=48&offset=${page * 48}`);
    if (r.status !== 200 || !Array.isArray(r.body)) break;
    for (const h of r.body) if (h && typeof h.slug === 'string' && /^[a-z0-9-]{3,40}$/.test(h.slug)) out.push({ slug: h.slug, displayName: h.displayName ?? h.slug, avatarUrl: h.avatarUrl ?? null, tagline: typeof h.tagline === 'string' ? h.tagline : null });
    if (r.body.length < 48) break;
  }
  return out;
}

/** Whole rupees for a merch price ("₹699"). Merch prices are always whole rupees. */
export const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

/** Standard T-shirt size guide, shown when the server sends none. Approximate body chest in inches. */
export const STANDARD_SIZE_CHART: { size: string; chestIn: number; lengthIn: number }[] = [
  { size: 'S', chestIn: 38, lengthIn: 27 }, { size: 'M', chestIn: 40, lengthIn: 28 }, { size: 'L', chestIn: 42, lengthIn: 29 },
  { size: 'XL', chestIn: 44, lengthIn: 30 }, { size: 'XXL', chestIn: 46, lengthIn: 31 }, { size: '3XL', chestIn: 48, lengthIn: 32 },
];
