/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Typed wrappers over the shop order contract (spec §4.2) and the public quote
 * (§4.1), on the shared request() — which already reports api_error/captureException for every failure. */
import { request } from '../../lib/apiClient';
import { API_BASE } from '../../lib/env';
import type { CreateShopOrderBody, ShopCartItem, ShopOrder, ShopQuote } from './types';

export async function quoteCart(items: ShopCartItem[], coupon: string | null, signal?: AbortSignal): Promise<ShopQuote> {
  const r = await request<{ quote: ShopQuote }>('/api/shop/quote', {
    method: 'POST',
    body: { items, ...(coupon ? { coupon } : {}) },
    signal,
  });
  return r.quote;
}

export async function createOrder(body: CreateShopOrderBody, auth: string): Promise<ShopOrder> {
  const r = await request<{ order: ShopOrder }>('/api/shop/orders', { method: 'POST', body, auth });
  return r.order;
}

export async function getOrder(id: string, auth: string): Promise<ShopOrder> {
  const r = await request<{ order: ShopOrder }>(`/api/shop/orders/${encodeURIComponent(id)}`, { auth });
  return r.order;
}

/** "I've paid" — stamps paid_claimed_at server-side. */
export async function markPaid(id: string, auth: string): Promise<ShopOrder> {
  const r = await request<{ order: ShopOrder }>(`/api/shop/orders/${encodeURIComponent(id)}/paid`, { method: 'POST', body: {}, auth });
  return r.order;
}

export async function submitUtr(id: string, utr: string, expectedReferenceRevision: number, auth: string): Promise<ShopOrder> {
  const r = await request<{ order: ShopOrder }>(`/api/shop/orders/${encodeURIComponent(id)}/utr`, {
    method: 'POST',
    body: { utr, expected_reference_revision: expectedReferenceRevision },
    auth,
  });
  return r.order;
}

/** Receipt PDF with the bearer header (a plain href cannot carry it) — same pattern as the event checkout. */
export async function fetchReceiptBlob(id: string, auth: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/api/shop/orders/${encodeURIComponent(id)}/receipt.pdf`, {
    headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store',
  });
  if (!res.ok) throw new Error(`receipt fetch failed: ${res.status}`);
  return res.blob();
}
