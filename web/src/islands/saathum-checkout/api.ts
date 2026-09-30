/* [SAATHUM-CHECKOUT-UI 2026-09-26] Thin typed wrappers over the saathum
 * checkout HTTP contract (Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md), built on
 * the shared `request()` in lib/apiClient.ts — same rules as every other API
 * helper on the site: `request` already reports api_error/captureException on
 * every non-2xx or network failure, so callers here don't duplicate that.
 */
import { request } from '../../lib/apiClient';
import { API_BASE } from '../../lib/env';
import { captureException } from '../../lib/analytics';
import type { VideoCrop } from '../../components/dash2/crop';
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
  /** [SAATHUM-DISCLAIMER-TICK-1] Required: buyer ticked the disclaimer. */
  disclaimer_accepted: true;
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
export interface LiveState {
  listing_id: string; state: 'none' | 'live' | 'ended'; ended_at?: number;
  /** [SAATHUM-FREEVID-WEB-1] Free event (anyone signed in can watch). Absent = paid. */
  free?: boolean;
  /** [SAATHUM-FREEVID-WEB-1] Free event that has ended but still has a video to replay. */
  replay?: boolean;
  /** [SAATHUM-FREEVID-ANYTIME-1] Free event with a saved video — watchable anytime. */
  available?: boolean;
}
export function getLiveState(listingId: string, signal?: AbortSignal): Promise<LiveState> {
  return request<LiveState>(`/api/saathum/live-state/${encodeURIComponent(listingId)}`, { signal });
}

export interface WatchInfo {
  ok: true; listing_id: string; title: string; starts_at: number | null; status: string;
  youtube_video_id: string; stream_state: 'none' | 'live' | 'ended';
  preview?: boolean; // [SAATHUM-LIVE-PREVIEW-1] admin-only test view
  /** [SAATHUM-FREEVID-WEB-1] Free event flag, the admin's crop box (null = whole frame)
   *  and whether the player should show now (free: live OR ended replay). All optional:
   *  an older worker omits them and the page behaves exactly as before. */
  free?: boolean;
  crop?: VideoCrop | null;
  playable?: boolean;
}
export function getWatch(listingId: string, auth: string, signal?: AbortSignal, preview = false): Promise<WatchInfo> {
  return request<WatchInfo>(`/api/saathum/watch/${encodeURIComponent(listingId)}`, {
    auth, signal, ...(preview ? { query: { preview: '1' } } : {}),
  });
}

/** [SAATHUM-FREEVID-WEB-1] POST /api/saathum/watch/:id/view — counts one viewer. Fire and
 * forget: a failed count must never disturb playback, but it is always reported. */
export function postWatchView(listingId: string, token: string): void {
  request<unknown>(`/api/saathum/watch/${encodeURIComponent(listingId)}/view`, { method: 'POST', body: {}, auth: token })
    .catch((err) => captureException(err, { surface: 'saathum_watch_view', listing_id: listingId }));
}

const viewCounted = new Set<string>();
/** Count a viewer at most once per listing per page load (first Play). */
export function postWatchViewOnce(listingId: string, token: string): void {
  if (viewCounted.has(listingId)) return;
  viewCounted.add(listingId);
  postWatchView(listingId, token);
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
