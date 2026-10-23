/* [HF-MERCH-CREATOR-WEB-1] Influencer merch: typed calls to /api/hf/merch/* (worker routes/hf_merch.ts, Specs/SPEC-2026-10-23-HF-MERCH.md sections 5 and 11).
 * Every response is { ok:true, ... } or { ok:false, error, message }; money is integer paise. */
import { hfCall, type HfResult } from '../../../lib/hfCallsApi';
import { request } from '../../../lib/apiClient';
import { API_BASE } from '../../../lib/env';

export interface Colour { name: string; hex: string }
export interface CatalogItem {
  id: string; kind: string; name: string; side: ('front' | 'back')[]; printArea: { wIn: number; hIn: number };
  /** [HF-MERCH-STUDIO-2] Category slug + label for the product tabs, silhouette family (studio/silhouettes.ts), per-side print areas. */
  category?: string; categoryLabel?: string; family?: string; printAreas?: { front?: { wIn: number; hIn: number }; back?: { wIn: number; hIn: number } }; imageUrl?: string;
  colours: Colour[]; sizes: { size: string; basePaise: number; baseRupees: number; printingPaise: number; shippingPaise: number }[];
}
export interface CatalogInfo { items: CatalogItem[]; shippingPaise: number; bufferPaise: number; minMarkupRupees: number; platformShareBps: number; holdDays: number }
export type ProductStatus = 'pending' | 'live' | 'rejected' | 'hidden';
export interface Product {
  id: string; slug: string; title: string; description: string; status: ProductStatus; reviewNote: string | null; imageUrl: string | null;
  mockups: string[]; catalogName: string; colours: Colour[]; sizes: { size: string; basePaise: number; pricePaise: number; youEarnPaise: number; printingPaise: number; shippingPaise: number; bufferPaise: number }[];
  /** true for older products whose printing / shipping split is worked back from today's shipping quote. */
  breakdownEstimated?: boolean;
  markupRupees: number; soldCount: number; publicUrl: string; createdAt: number;
}
export type OrderStatus = 'new' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
export interface SellerOrder {
  id: string; orderNo: string; createdAt: number; status: OrderStatus;
  product: { title: string; imageUrl: string | null; colour: string; size: string; qty: number };
  money: { pricePaise: number; basePaise: number; youEarnPaise: number; availableAt: number | null; credited: boolean };
  buyer: { firstName: string; city: string; state: string; addressMasked: string };
  shipping: { courier: string | null; awb: string | null; trackingUrl: string | null } | null;
  timeline?: { at: number; label: string }[];
}
export interface Summary {
  products: { live: number; pending: number; hidden: number };
  orders: { new: number; processing: number; shipped: number; delivered: number };
  earnings: { pendingPaise: number; availablePaise: number; lifetimePaise: number };
}
export interface ArtUpload { artId: string; url: string; width: number; height: number; checks: { ok: boolean; dpiAtFullWidth: number; warnings: string[] } }
export interface CreateBody {
  title: string; description?: string; catalogId: string; colours: string[]; sizes: string[]; side: 'front' | 'back';
  placement: { frame: 'none' | 'square' | 'circle' | 'rect'; x: number; y: number; w: number; h: number; zoom: number };
  artId: string; printFileId: string; markupRupees: number; ownArtConfirmed: true; mockupUrls?: string[];
}

export const MARKUP_MAX = 5000;

let cfg: Promise<{ enabled: boolean; minMarkupRupees: number; holdDays: number }> | null = null;
/** hfMerchEnabled (and two numbers the screens show) from /api/config, one request per page. Any failure counts as off. */
export function merchConfig() {
  if (!cfg) {
    cfg = request<{ hfMerchEnabled?: boolean; hfMerchMinMarkupRupees?: number; hfMerchHoldDays?: number }>('/api/config', { timeoutMs: 8000 })
      .then(c => ({ enabled: c?.hfMerchEnabled === true, minMarkupRupees: Number(c?.hfMerchMinMarkupRupees) || 10, holdDays: Number(c?.hfMerchHoldDays) || 7 }))
      .catch(() => ({ enabled: false, minMarkupRupees: 10, holdDays: 7 }));
  }
  return cfg;
}
export const merchEnabled = (): Promise<boolean> => merchConfig().then(c => c.enabled);

const B = '/api/hf/merch';
export const getCatalog = () => hfCall<{ ok: boolean } & CatalogInfo>('GET', `${B}/catalog`);
export const getQuote = (p: { catalogId: string; colours: string[]; side: string; w: number; h: number; sizes: string[] }) =>
  hfCall<{ ok: boolean; sizes: { size: string; basePaise: number; baseRupees: number; printingPaise: number; shippingPaise: number }[]; shippingPaise: number; bufferPaise: number }>('GET',
    `${B}/quote?catalogId=${encodeURIComponent(p.catalogId)}&colours=${encodeURIComponent(p.colours.join(','))}&side=${p.side}&w=${p.w.toFixed(2)}&h=${p.h.toFixed(2)}&sizes=${encodeURIComponent(p.sizes.join(','))}`);
export const getSummary = () => hfCall<{ ok: boolean } & Summary>('GET', `${B}/summary`);
export const listProducts = () => hfCall<{ ok: boolean; products: Product[] }>('GET', `${B}/products`);
export const createProduct = (b: CreateBody) => hfCall<{ ok: boolean; product: Product }>('POST', `${B}/products`, b, { timeoutMs: 60_000 });
export const patchProduct = (id: string, b: Partial<{ markupRupees: number; title: string; description: string; hidden: boolean }>) =>
  hfCall<{ ok: boolean; product: Product }>('PATCH', `${B}/products/${encodeURIComponent(id)}`, b);
export const deleteProduct = (id: string) => hfCall<{ ok: boolean }>('DELETE', `${B}/products/${encodeURIComponent(id)}`);
export const listOrders = (status: OrderStatus | 'all') => hfCall<{ ok: boolean; orders: SellerOrder[] }>('GET', `${B}/orders${status === 'all' ? '' : `?status=${status}`}`);
export const getOrder = (id: string) => hfCall<{ ok: boolean; order: SellerOrder }>('GET', `${B}/orders/${encodeURIComponent(id)}`);

/** Raw-body upload (art, print file, mockup). Header values stay ASCII (percent-encoded file names). */
export async function rawUpload<T>(path: string, body: Blob, headers: Record<string, string> = {}): Promise<HfResult<T>> {
  const { getActiveTokenWaited } = await import('../../../lib/clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return { ok: false, status: 401, code: 'no_session', message: 'Please sign in to continue.', body: {} };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body, cache: 'no-store', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': body.type || 'application/octet-stream', ...headers } });
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && j.ok !== false) return { ok: true, data: j as T };
    return { ok: false, status: res.status, code: String(j.error ?? 'error'), message: typeof j.message === 'string' ? j.message : 'Something went wrong. Please try again.', body: j };
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'We could not reach the server. Check your internet and try again.', body: {} };
  } finally { clearTimeout(timer); }
}
const asciiName = (n: string) => { try { return encodeURIComponent(n.slice(0, 120)); } catch { return 'art'; } };
export const uploadArt = (blob: Blob, fileName: string) => rawUpload<ArtUpload>(`${B}/art`, blob, { 'x-file-name': asciiName(fileName) });
export const uploadPrintFile = (artId: string, blob: Blob) => rawUpload<{ printFileId: string; url: string; width: number; height: number }>(`${B}/print-file`, blob, { 'x-art-id': artId });
export const uploadMockup = (blob: Blob) => rawUpload<{ url: string }>(`${B}/mockup`, blob);

/* ── [HF-MERCH-STUDIO-2] AI pictures + background remover (worker routes/hf_merch.ts, Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md §3) ── */
export interface AiGen { genId: string; artId: string; url: string; width: number; height: number; prompt: string; style: string | null; createdAt: number }
export interface AiInfo { enabled: boolean; chargePaise: number; chargeRupees: number; balancePaise: number; testCreditPaise: number; canAfford: boolean; recent: AiGen[] }
export interface AiGenerateBody {
  requestKey: string; prompt: string; style?: string; refArtIds?: string[]; baseArtId?: string; plainBackground?: boolean; aspect?: '1:1' | '3:4' | '4:3' | '9:16';
}
export const getAi = () => hfCall<{ ok: boolean } & AiInfo>('GET', `${B}/ai`);
/** Charges the wallet (paid money only); refunded by the server if the picture cannot be made. 402 insufficient_funds carries chargePaise/balancePaise/shortPaise in `body`. */
export const generateAi = (b: AiGenerateBody) => hfCall<{ ok: boolean; gen: { genId: string; chargedPaise: number }; art: ArtUpload; balancePaise: number }>('POST', `${B}/ai/generate`, b, { timeoutMs: 150_000 });
export const removeBackground = (artId: string) => hfCall<{ ok: boolean; art: ArtUpload }>('POST', `${B}/art/${encodeURIComponent(artId)}/remove-bg`, {}, { timeoutMs: 90_000 });
/** The influencer's own art bytes through the API (CORS-safe for canvas work; the public media host sends no CORS headers). */
export async function fetchArtFile(artId: string): Promise<Blob | null> {
  const { getActiveTokenWaited } = await import('../../../lib/clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}${B}/art/${encodeURIComponent(artId)}/file`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    return res.ok ? await res.blob() : null;
  } catch { return null; }
}
export const newRequestKey = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* ── money (the same floor rule as worker lib/hf_merch_math.ts) ───────────── */
export const youEarnPaise = (markupRupees: number, shareBps: number) => Math.floor((Math.trunc(markupRupees) * 100 * (10_000 - shareBps)) / 10_000);
export const fanPaysPaise = (basePaise: number, markupRupees: number) => basePaise + Math.trunc(markupRupees) * 100;
export const rupees = (paise: number): string => {
  const r = paise / 100;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
export const dayText = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const dayTimeText = (ms: number) => `${dayText(ms)}, ${new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`;
