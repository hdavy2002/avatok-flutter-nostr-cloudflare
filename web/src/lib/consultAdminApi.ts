// [AUMFE-CONSULT-F4-1 2026-10-02] Typed calls for the Real Consultants admin screens (worker routes/consultants/admin.ts,
// all under /api/consultants/admin/*, admin only). The public review-by-token calls live in the review island itself
// so the public page never pulls the admin/Clerk code.
// Contract: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md "W4" + "W3". Money is rupees (integers).
// NOTE FOR AI: the row shapes below are what the admin screens READ; every field the worker may omit is optional so a
// thinner response renders as "—" instead of crashing. Do not add pricing maths here (lib/consultants/pricing.ts owns it).
import { API_BASE } from './env';
import { fileNameHeader } from './uploadHeaders';
import { ApiError, adminToken } from '../islands/admin2/adminApi';
import { adminCall } from '../islands/admin2/peopleKit';
import type { BookingStatus, ConsultantStatus, Discipline, PriceBreakdown, ReviewStatus } from './consultTypes';

const B = '/api/consultants/admin';
const e = encodeURIComponent;

/* ── consultants ────────────────────────────────────────────────────────── */
export interface AdminConsultant {
  id: string; slug: string; name: string; disciplines: Discipline[];
  photo_url: string | null; years: number | null; languages: string[]; city: string | null;
  tagline?: string | null; bio: string | null; lineage: string | null;
  rate: number | null; rate_floor: number | null; rate_ceil: number | null;
  status: ConsultantStatus; uid: string | null; attached_email: string | null;
  rating_avg: number | null; rating_count: number;
}
/** Fields an admin may write (PATCH sends only what changed; POST sends the lot). */
export interface ConsultantWrite {
  name: string; slug: string; disciplines: Discipline[]; years: number | null; languages: string[];
  bio: string; lineage: string; city: string; rate_floor: number; rate_ceil: number; status: ConsultantStatus;
}

export const consultAdminApi = {
  consultants: async () => (await adminCall<{ consultants: AdminConsultant[] }>(`${B}/consultants`)).consultants ?? [],
  createConsultant: (b: ConsultantWrite) => adminCall<{ consultant: AdminConsultant }>(`${B}/consultants`, { method: 'POST', body: b }),
  updateConsultant: (id: string, b: Partial<ConsultantWrite>) =>
    adminCall<{ consultant: AdminConsultant }>(`${B}/consultants/${e(id)}`, { method: 'PATCH', body: b }),
  attach: (id: string, who: { email: string } | { uid: string }) =>
    adminCall<{ consultant: AdminConsultant }>(`${B}/consultants/${e(id)}/attach`, { method: 'POST', body: who }),
  detach: (id: string) => adminCall<{ consultant: AdminConsultant }>(`${B}/consultants/${e(id)}/detach`, { method: 'POST', body: {} }),

  /* bookings */
  bookings: async (q: { status?: string; q?: string }) =>
    (await adminCall<{ bookings: AdminBooking[] }>(`${B}/bookings`, { query: { status: q.status || undefined, q: q.q || undefined } })).bookings ?? [],
  confirmPayment: (id: string, note: string) => adminCall<{ booking?: AdminBooking }>(`${B}/bookings/${e(id)}/confirm-payment`, { method: 'POST', body: { note } }),
  refund: (id: string, b: { utr: string; note: string }) => adminCall<{ booking?: AdminBooking }>(`${B}/bookings/${e(id)}/refund`, { method: 'POST', body: b }),
  cancel: (id: string, reason: string) => adminCall<{ booking?: AdminBooking }>(`${B}/bookings/${e(id)}/cancel`, { method: 'POST', body: { reason } }),

  /* reviews */
  reviews: (status: AdminReviewTab, page: number) =>
    adminCall<AdminReviewPage>(`${B}/reviews`, { query: { status, page } }),
  setReview: (id: string, status: Exclude<ReviewStatus, 'pending'> | 'pending') =>
    adminCall<{ review?: AdminReview }>(`${B}/reviews/${e(id)}`, { method: 'PATCH', body: { status } }),
};

/** Raw-image upload of a consultant's portrait → public R2 URL. JPG / PNG / WebP up to 8 MB. */
export const PORTRAIT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;
export async function uploadConsultantPhoto(id: string, file: File): Promise<string | null> {
  if (!PORTRAIT_TYPES.includes(file.type)) throw new Error('Use a JPG, PNG or WebP photo.');
  if (file.size > MAX_PORTRAIT_BYTES) throw new Error('That photo is larger than 8 MB.');
  const token = await adminToken();
  if (!token) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const res = await fetch(`${API_BASE}${B}/consultants/${e(id)}/photo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-content-type': file.type, 'x-file-name': fileNameHeader(file.name) }, // non-ASCII names: see uploadHeaders.ts
    body: file,
  });
  let body: { photo_url?: string; url?: string; error?: string; message?: string } = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'upload_failed', { message: body.message ?? `The upload failed (${res.status}).` });
  return body.photo_url ?? body.url ?? null;
}

/* ── bookings ───────────────────────────────────────────────────────────── */
export interface AdminBooking {
  id: string; ref: string; status: BookingStatus; created_at: number;
  discipline: Discipline; slot_start_ms: number; slot_end_ms: number; price: PriceBreakdown | null;
  customer: { uid: string; name: string | null; email: string | null; phone_masked?: string | null } | null;
  consultant: { id?: string; slug: string; name: string } | null;
  payment?: {
    utr?: string | null; payer_vpa?: string | null; confirm_source?: string | null; confirmed_at?: number | null;
    unique_amount_paise?: number | null; note?: string | null;
  } | null;
  refund?: { utr?: string | null; note?: string | null; at?: number | null } | null;
  cancel_reason?: string | null;
}

/* ── reviews ────────────────────────────────────────────────────────────── */
export type AdminReviewTab = 'pending' | 'approved' | 'rejected' | 'seed';
export interface AdminReview {
  id: string; status: ReviewStatus; seed?: boolean; stars: number; text: string | null; created_at: number;
  consultant: { name: string; slug?: string } | null;
  customer_name: string | null; slot_start_ms?: number | null; minutes?: number | null; verified?: boolean;
}
export interface AdminReviewPage { reviews: AdminReview[]; page: number; pages: number; counts?: Partial<Record<AdminReviewTab, number>> }
