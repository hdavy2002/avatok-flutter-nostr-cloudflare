// [AUMFE-CONSULT-F2-1 2026-10-02] Customer-side wrappers for /api/consultants (booking wizard + "My consultations").
// Contract: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md (HTTP contract, W1 bookings.ts / W2 file.ts photo route).
// Every call goes through request() from lib/apiClient, which already reports api_error + captureException.
// NOTE FOR AI: customer calls only. The consultant desk and admin wrappers live in consultDeskApi.ts / consultAdminApi.ts.
import { ApiError, request } from './apiClient';
import { API_BASE } from './env';
import { apiError, captureException } from './analytics';
import type {
  BookingDTO, ConsultantDetail, Discipline, Intake, PhotoKind, ReviewDTO, SlotDay,
} from './consultTypes';

export interface PayInfo {
  upi_uri: string;
  qr_svg?: string;
  payee_vpa: string;
  amount_paise: number;
  payer_reference: string;
  expires_at: number;
}

export interface CreateBookingBody {
  slug: string;
  discipline: Discipline;
  slot_start_ms: number;
  intake: Intake;
  questions: string[];
  request_key: string;
  terms: true;
  refund_policy: true;
}

export interface CreatedBooking { booking: BookingDTO; pay: PayInfo }
export interface PhotoVerdict { kind: PhotoKind; status: 'accepted' | 'rejected'; reason: string | null }

export const getConsultant = (slug: string, auth?: string | null) =>
  request<{ consultant: ConsultantDetail; reviews: ReviewDTO[]; review_pages: number; sample_reviews: boolean }>(
    `/api/consultants/c/${encodeURIComponent(slug)}`, { auth, timeoutMs: 15_000 },
  );

export const getSlots = (slug: string, from: string, days = 14, auth?: string | null) =>
  request<{ days: SlotDay[] }>(`/api/consultants/c/${encodeURIComponent(slug)}/slots`, {
    query: { from, days }, auth, timeoutMs: 15_000,
  });

export const createBooking = (body: CreateBookingBody, auth: string) =>
  request<CreatedBooking>('/api/consultants/bookings', { method: 'POST', body, auth, timeoutMs: 25_000 });

export const getBooking = (id: string, auth: string) =>
  request<{ booking: BookingDTO }>(`/api/consultants/bookings/${encodeURIComponent(id)}`, { auth, timeoutMs: 15_000 });

export const myBookings = (auth: string) =>
  request<{ bookings: BookingDTO[] }>('/api/consultants/bookings/mine', { auth, timeoutMs: 15_000 });

export const cancelBooking = (id: string, auth: string) =>
  request<{ booking?: BookingDTO; ok?: boolean }>(`/api/consultants/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', body: {}, auth, timeoutMs: 15_000,
  });

/** "I've paid" (+ optional 12-digit UTR). */
export const markPaid = (id: string, utr: string | undefined, auth: string) =>
  request<{ booking?: BookingDTO; ok?: boolean }>(`/api/consultants/bookings/${encodeURIComponent(id)}/paid`, {
    method: 'POST', body: utr ? { utr } : {}, auth, timeoutMs: 15_000,
  });

/** Pays total_rupees tokens from the wallet. Throws ApiError 402 `insufficient` when the balance is short. */
export const payWallet = (id: string, auth: string) =>
  request<{ booking?: BookingDTO; ok?: boolean }>(`/api/consultants/bookings/${encodeURIComponent(id)}/pay-wallet`, {
    method: 'POST', body: {}, auth, timeoutMs: 25_000,
  });

export async function walletSpendable(auth: string): Promise<number> {
  const r = await request<{ spendable?: number; balance?: number }>('/api/wallet/balance', { auth, timeoutMs: 10_000 });
  return Number(r.spendable ?? r.balance ?? 0);
}

/**
 * Raw image body + `x-photo-kind` (an ASCII constant, so no header-encoding trap — see lib/uploadHeaders.ts; a user
 * filename is never sent). Not through request() because that always JSON-encodes the body.
 */
export async function uploadPhoto(id: string, kind: PhotoKind, blob: Blob, auth: string): Promise<PhotoVerdict> {
  const endpoint = '/api/consultants/bookings/:id/photo';
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/consultants/bookings/${encodeURIComponent(id)}/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': blob.type || 'image/jpeg', 'x-photo-kind': kind },
      body: blob,
      cache: 'no-store',
    });
  } catch (e) {
    apiError({ endpoint, method: 'POST', status: 0, reason: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) });
    captureException(e, { endpoint, method: 'POST' });
    throw e;
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  if (!res.ok) {
    const reason = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText || 'upload failed';
    apiError({ endpoint, method: 'POST', status: res.status, reason, ms: Math.round(performance.now() - t0) });
    throw new ApiError(res.status, reason, body);
  }
  return (body as { photo: PhotoVerdict }).photo;
}

/** The worker's human message for an error body, else the fallback. */
export function consultMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.body && typeof e.body === 'object') {
      const m = (e.body as { message?: unknown }).message;
      if (typeof m === 'string' && m) return m;
    }
    if (e.status === 409) return 'That time was just taken. Please pick another.';
    if (e.status === 402) return 'Your wallet balance is not enough for this session.';
  }
  if (e instanceof TypeError) return 'You seem to be offline. Check your connection and try again.';
  return fallback;
}
