/* [AUMFE-CONSULT-F3-1 2026-10-02] Typed wrappers for the consultant desk + the call ticket.
 * Contract: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md (W2 file.ts, W3 call.ts, W4 desk.ts).
 * Every call goes through request() from lib/apiClient, which reports api_error to PostHog itself. */
import { ApiError, request } from './apiClient';
import { getActiveTokenWaited } from './clerk';
import { API_BASE } from './env';
import type {
  CallTicketDTO, ConsultantDetail, DeskBookingDTO, DeskFileDTO, PriceBreakdown,
} from './consultTypes';

export interface AvailabilityRule { weekday: number; start: string; end: string }
export interface AvailabilityException { date: string; off: boolean; start?: string | null; end?: string | null }
export interface DeskAvailability {
  rules: AvailabilityRule[]; exceptions: AvailabilityException[]; slot_minutes: number; buffer_minutes: number;
}
export interface DeskMe { consultant: ConsultantDetail; rate_floor: number; rate_ceil: number }
/** Shape is W4's to finish; every field is optional so the UI degrades instead of crashing. */
export interface DeskCustomer {
  uid: string; name: string; city?: string | null; sessions?: number; last_session_ms?: number | null; disciplines?: string[];
}
export interface DeskEarnings {
  wallet_rupees?: number; month_total_rupees?: number; month_sessions?: number; pending_rupees?: number;
}
export type DeskScope = 'today' | 'upcoming' | 'past';

export class SignedOutError extends Error {
  constructor() { super('Please sign in again.'); this.name = 'SignedOutError'; }
}

export async function authToken(): Promise<string | null> {
  return getActiveTokenWaited(6000);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function authed<T>(path: string, opts: { method?: Method; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  return request<T>(path, { timeoutMs: 20_000, ...opts, auth });
}

export function errStatus(e: unknown): number | undefined { return e instanceof ApiError ? e.status : undefined; }
export function errCode(e: unknown): string | undefined { return e instanceof ApiError ? e.error : undefined; }
export function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') {
    const m = (e.body as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (e instanceof TypeError) return 'You seem to be offline. Check your connection and try again.';
  return fallback;
}

const B = '/api/consultants/desk';
const enc = encodeURIComponent;

export const getDeskMe = () => authed<DeskMe>(`${B}/me`);
export const putDeskProfile = (p: { bio: string | null; tagline: string | null; languages: string[]; city: string | null }) =>
  authed<{ ok?: boolean }>(`${B}/profile`, { method: 'PUT', body: p });
export const getAvailability = () => authed<DeskAvailability>(`${B}/availability`);
export const putAvailability = (a: DeskAvailability) => authed<DeskAvailability | { ok: boolean }>(`${B}/availability`, { method: 'PUT', body: a });
export const putRate = (rate: number) => authed<{ price: PriceBreakdown }>(`${B}/rate`, { method: 'PUT', body: { rate } });
export async function getDeskBookings(scope: DeskScope): Promise<DeskBookingDTO[]> {
  const r = await authed<{ bookings: DeskBookingDTO[] }>(`${B}/bookings`, { query: { scope } });
  return r.bookings ?? [];
}
export async function getDeskCustomers(): Promise<DeskCustomer[]> {
  const r = await authed<{ customers: DeskCustomer[] }>(`${B}/customers`);
  return r.customers ?? [];
}
export const getDeskEarnings = () => authed<DeskEarnings>(`${B}/earnings`);

export const getDeskFile = (bookingId: string) => authed<DeskFileDTO>(`${B}/bookings/${enc(bookingId)}/file`);
export const patchCard = (bookingId: string, key: string, override: unknown | null) =>
  authed<{ ok?: boolean; card?: unknown }>(`${B}/bookings/${enc(bookingId)}/cards/${enc(key)}`, { method: 'PATCH', body: { override } });
export const rerunFile = (bookingId: string, tob?: string) =>
  authed<{ ok?: boolean }>(`${B}/bookings/${enc(bookingId)}/rerun`, { method: 'POST', body: tob ? { tob } : {} });
export const putNotes = (bookingId: string, notes: string) =>
  authed<{ ok?: boolean }>(`${B}/bookings/${enc(bookingId)}/notes`, { method: 'PUT', body: { notes } });

/** Photos are private: fetch with the token and hand the browser a blob URL (an <img src> cannot send a header). */
export async function fetchDeskPhoto(url: string): Promise<string> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  const full = url.startsWith('http') ? url : `${API_BASE}${url}`;
  const res = await fetch(full, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new ApiError(res.status, 'photo_failed');
  return URL.createObjectURL(await res.blob());
}

/** POST /api/consultants/sessions/:id/ticket — works for the booking's customer and its consultant. */
export const postCallTicket = (bookingId: string) =>
  authed<CallTicketDTO>(`/api/consultants/sessions/${enc(bookingId)}/ticket`, { method: 'POST', body: {} });

/** Customer side: one booking (own). */
export interface CustomerBookingLite {
  id: string; discipline: string; slot_start_ms: number; slot_end_ms: number; status: string; join_opens_ms: number;
  consultant: { slug: string; name: string; photo_url: string };
}
export async function getMyBooking(id: string): Promise<CustomerBookingLite> {
  const r = await authed<{ booking: CustomerBookingLite }>(`/api/consultants/bookings/${enc(id)}`);
  return r.booking;
}
