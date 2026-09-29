/* [SAATHUM-CHECKOUT-UI 2026-09-26] Thin typed wrappers over the saathum
 * checkout HTTP contract (Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md), built on
 * the shared `request()` in lib/apiClient.ts — same rules as every other API
 * helper on the site: `request` already reports api_error/captureException on
 * every non-2xx or network failure, so callers here don't duplicate that.
 */
import { request } from '../../lib/apiClient';
import { API_BASE } from '../../lib/config';
import type { Address, ChadhavaSelection, Checkout, CheckoutConfig, Quote, Sankalp } from './types';

export function getCheckoutConfig(listingId: string): Promise<CheckoutConfig> {
  return request<CheckoutConfig>('/api/saathum/checkout/config', { query: { listing_id: listingId } });
}

export function getQuote(
  body: { listing_id: string; chadhava: ChadhavaSelection[]; dakshina_rupees: number; prasad: boolean },
  signal?: AbortSignal,
): Promise<Quote> {
  return request<Quote>('/api/saathum/checkout/quote', { method: 'POST', body, signal });
}

export interface CreateCheckoutBody {
  listing_id: string;
  request_key: string;
  chadhava: ChadhavaSelection[];
  dakshina_rupees: number;
  prasad: boolean;
  sankalp: Sankalp;
  address?: Address;
  accept_terms: true;
  /** [REFUND-POLICY-WEB-1 2026-09-28] Required alongside accept_terms — the
   *  server rejects with 400 {error:"refund_policy_required"} when missing. */
  refund_policy_accepted: true;
}

export async function createCheckout(body: CreateCheckoutBody, auth: string): Promise<Checkout> {
  const r = await request<{ checkout: Checkout }>('/api/saathum/checkout', { method: 'POST', body, auth });
  return r.checkout;
}

export async function getCheckout(id: string, auth: string): Promise<Checkout> {
  const r = await request<{ checkout: Checkout }>(`/api/saathum/checkout/${encodeURIComponent(id)}`, { auth });
  return r.checkout;
}

/** [SAATHUM-UPI-3LAYER] "I've paid" — stamps paid_claimed_at server-side. */
export async function markPaid(id: string, auth: string): Promise<Checkout> {
  const r = await request<{ checkout: Checkout }>(`/api/saathum/checkout/${encodeURIComponent(id)}/paid`, { method: 'POST', body: {}, auth });
  return r.checkout;
}

export async function submitUtr(
  id: string,
  utr: string,
  expectedReferenceRevision: number,
  auth: string,
): Promise<Checkout> {
  const r = await request<{ checkout: Checkout }>(`/api/saathum/checkout/${encodeURIComponent(id)}/utr`, {
    method: 'POST',
    body: { utr, expected_reference_revision: expectedReferenceRevision },
    auth,
  });
  return r.checkout;
}

export async function updateCheckoutAddress(id: string, address: Address, auth: string): Promise<Checkout> {
  const r = await request<{ checkout: Checkout }>(`/api/saathum/checkout/${encodeURIComponent(id)}/address`, {
    method: 'PUT',
    body: { address },
    auth,
  });
  return r.checkout;
}

// [SAATHUM-WATCH-1 2026-09-28] Live-state (public) + watch (entitled) — shared by
// the listing detail page's LiveOverlay island and the checkout DoneStep redirect.
export interface LiveState { listing_id: string; state: 'none' | 'live' | 'ended'; ended_at?: number }
export function getLiveState(listingId: string, signal?: AbortSignal): Promise<LiveState> {
  return request<LiveState>(`/api/saathum/live-state/${encodeURIComponent(listingId)}`, { signal });
}

export interface WatchInfo {
  ok: true; listing_id: string; title: string; starts_at: number | null; status: string;
  youtube_video_id: string; stream_state: 'none' | 'live' | 'ended';
}
export function getWatch(listingId: string, auth: string, signal?: AbortSignal): Promise<WatchInfo> {
  return request<WatchInfo>(`/api/saathum/watch/${encodeURIComponent(listingId)}`, { auth, signal });
}

/** GET .../receipt.pdf WITH the auth header — a plain link/href can't carry a
 * bearer token, so this fetches the blob and hands back an object URL to
 * download, mirroring dashboard2/accountApi.ts's meBlob(). */
export async function fetchReceiptBlob(id: string, auth: string): Promise<Blob> {
  const url = `${API_BASE}/api/saathum/checkout/${encodeURIComponent(id)}/receipt.pdf`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`receipt fetch failed: ${res.status}`);
  return res.blob();
}
