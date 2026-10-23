/* [HF-MERCH-FAN-WEB-1] Browser client for the FAN side of the merch shop. Worker: routes/hf_merch.ts.
 *   POST /api/hf/merch/checkout            { productId, colour, size, qty, address, saveAddress, acceptTerms, acceptRefund, method, requestKey }
 *   GET  /api/hf/merch/my-orders(/:id)     FanOrder (+ timeline); asks Cashfree itself when the order is awaiting payment
 *   POST /api/hf/merch/my-orders/:id/problem-photo (raw image) then /problem { kind, note, photoKey }
 *   GET/DELETE /api/hf/merch/addresses     saved delivery addresses (max 5)
 *   GET  /api/hf/merch/pincode/:pin        public, cached a day
 * Every call goes through hfCall (bearer token, typed errors). Money is integer paise on the wire. */
import { hfCall, type HfResult } from './hfCallsApi';
import { request } from './apiClient';
import { API_BASE } from './env';
import { fileNameHeader } from './uploadHeaders';

export type FanStatus = 'awaiting_payment' | 'placed' | 'approved' | 'printing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
export interface FanOrder {
  id: string; orderNo: string; createdAt: number; status: FanStatus;
  product: { title: string; imageUrl: string | null; colour: string; size: string; qty: number; hostName: string; hostSlug: string };
  totalPaise: number; payMethod: 'wallet' | 'cashfree' | null;
  shipping: { courier: string | null; awb: string | null; trackingUrl: string | null } | null;
  receiptUrl: string | null; canReportProblem: boolean;
  refundStatus?: 'none' | 'refunding' | 'done' | 'pending_manual'; rejectReason?: string | null; deepLink?: string;
}
export type FanOrderFull = FanOrder & { timeline?: { at: number; label: string }[] };
export interface SavedAddress { id: string; name: string; phone: string; line1: string; line2?: string | null; city: string; state: string; pincode: string }
export interface AddressInput { name: string; phone: string; line1: string; line2: string; city: string; state: string; pincode: string }
export interface CheckoutBody {
  productId: string; colour: string; size: string; qty: number; address: AddressInput; saveAddress: boolean;
  acceptTerms: true; acceptRefund: true; method: 'wallet' | 'cashfree'; requestKey: string;
}
export interface CheckoutDone { ok: true; orderId: string; orderNo: string; status: 'paid' | 'awaiting_payment'; checkoutUrl?: string; paymentSessionId?: string }

export const checkoutMerch = (b: CheckoutBody) => hfCall<CheckoutDone>('POST', '/api/hf/merch/checkout', { ...b, client: 'web' }, { timeoutMs: 45_000 });
export const listMyOrders = () => hfCall<{ orders: FanOrder[] }>('GET', '/api/hf/merch/my-orders');
export const getMyOrder = (id: string) => hfCall<{ order: FanOrderFull }>('GET', `/api/hf/merch/my-orders/${encodeURIComponent(id)}`);
export const listAddresses = () => hfCall<{ addresses: SavedAddress[] }>('GET', '/api/hf/merch/addresses');
export const deleteAddress = (id: string) => hfCall<{ ok: boolean }>('DELETE', `/api/hf/merch/addresses/${encodeURIComponent(id)}`);
export const reportProblem = (id: string, body: { kind: 'wrong' | 'damaged'; note: string; photoKey?: string }) =>
  hfCall<{ reported: boolean }>('POST', `/api/hf/merch/my-orders/${encodeURIComponent(id)}/problem`, body);

export const checkPincode = (pin: string) => hfCall<{ deliverable: boolean; etaDays: number | null }>('GET', `/api/hf/merch/pincode/${pin}`, undefined, { auth: false, timeoutMs: 15_000 });

let cfg: Promise<boolean> | null = null;
/** hfMerchEnabled from /api/config (one request per page). Any failure counts as off. */
export function merchEnabled(): Promise<boolean> {
  if (!cfg) cfg = request<{ hfMerchEnabled?: boolean }>('/api/config', { timeoutMs: 8000 }).then((c) => c?.hfMerchEnabled === true).catch(() => false);
  return cfg;
}

export type PhotoResult = { ok: true; photoKey: string } | { ok: false; message: string };
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Raw-body upload (the worker reads the bytes, not JSON). Max 5 MB; the file name never goes in a header unencoded. */
export async function uploadProblemPhoto(orderId: string, file: File): Promise<PhotoResult> {
  if (!PHOTO_TYPES.includes(file.type)) return { ok: false, message: 'Use a JPG, PNG or WebP photo.' };
  if (file.size > 5 * 1024 * 1024) return { ok: false, message: 'That photo is larger than 5 MB.' };
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return { ok: false, message: 'Please sign in again.' };
  try {
    const res = await fetch(`${API_BASE}/api/hf/merch/my-orders/${encodeURIComponent(orderId)}/problem-photo`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type, 'x-file-name': fileNameHeader(file.name) }, body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { photoKey?: string; message?: string };
    if (!res.ok || !body.photoKey) return { ok: false, message: body.message ?? 'We could not upload the photo. Please try again.' };
    return { ok: true, photoKey: body.photoKey };
  } catch { return { ok: false, message: 'We could not reach the server. Check your internet and try again.' }; }
}

/** The receipt PDF needs the bearer token, so it is fetched and opened as a blob (a plain link would be refused). */
export async function openReceipt(url: string): Promise<boolean> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) return false;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const win = window.open(href, '_blank', 'noopener');
    if (!win) { const a = document.createElement('a'); a.href = href; a.download = 'receipt.pdf'; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return true;
  } catch { return false; }
}

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];
export const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
export type { HfResult };
