// [DASH2-BILLING / DASH2-PROFILE 2026-09-25] Shared helpers for the Billing and
// Profile screens: authed calls to the /api/me/* worker routes, paise -> ₹,
// and IST date formatting. Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md.
//
// Screen islands never mount a Clerk provider (DashNav owns it); the token
// comes from getActiveTokenWaited(), which DashNav's ClerkBridge feeds.
import { ApiError, request, type RequestOptions } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { API_BASE } from '../../lib/config';

const GUEST_JWT_KEY = 'avatok_guest_jwt';

/** Clerk token, or the stored guest token (same rule as DashNav's guard). */
export async function authToken(): Promise<string | null> {
  const t = await getActiveTokenWaited(6000);
  if (t) return t;
  try { return localStorage.getItem(GUEST_JWT_KEY); } catch { return null; }
}

export class SignedOutError extends Error {
  constructor() { super('Please sign in again.'); this.name = 'SignedOutError'; }
}

/** request() with the caller's bearer token attached. */
export async function meApi<T>(path: string, opts: Omit<RequestOptions, 'auth'> = {}): Promise<T> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  return request<T>(path, { timeoutMs: 20_000, ...opts, auth });
}

/** Worker error body: { error, message, field?, ...extra }. */
export interface ApiErrBody { error?: string; message?: string; field?: string; [k: string]: unknown }

export function errBody(e: unknown): ApiErrBody {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') return e.body as ApiErrBody;
  return {};
}
/** A cancelled request (we navigated or re-filtered) — never shown to the person. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
export function errCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.error : undefined;
}
/** The human message to show (worker `message`, else a calm fallback). */
export function errMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const b = errBody(e);
  if (typeof b.message === 'string' && b.message) return b.message;
  if (e instanceof SignedOutError) return e.message;
  if (e instanceof TypeError) return 'You seem to be offline. Check your connection and try again.';
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'That took too long. Please try again.';
  return fallback;
}

/** Fetch a binary route WITH the auth header (a plain link can't carry the token). */
export async function meBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store' });
  if (!res.ok) {
    let body: unknown = undefined;
    try { body = await res.json(); } catch { /* not json */ }
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, code || 'request failed', body);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return { blob: await res.blob(), filename: m?.[1] ?? null };
}

/* ── money ──────────────────────────────────────────────────────────────── */

/** Paise -> "₹1,25,000" (Indian grouping); two decimals only when not whole rupees. */
export function formatPaise(paise: number | null | undefined): string {
  if (paise == null || !Number.isFinite(Number(paise))) return '—';
  const p = Math.round(Number(paise));
  const whole = p % 100 === 0;
  const rupees = p / 100;
  return `₹${rupees.toLocaleString('en-IN', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ── IST dates ──────────────────────────────────────────────────────────── */

const TZ = 'Asia/Kolkata';
const fmtDate = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtYear = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, year: 'numeric' });

export const istDate = (ms: number | null | undefined) => (ms ? fmtDate.format(ms) : '—');
export const istDay = (ms: number | null | undefined) => (ms ? fmtDay.format(ms) : '—');
export const istTime = (ms: number | null | undefined) => (ms ? `${fmtTime.format(ms).replace(/\s?(am|pm)$/i, (x) => x.toUpperCase())} IST` : '—');
export const istDateTime = (ms: number | null | undefined) => (ms ? `${istDate(ms)}, ${istTime(ms)}` : '—');
export const istYear = (ms: number) => Number(fmtYear.format(ms));

/** "2026-09-25" (a calendar day) -> epoch ms at 00:00 IST, or 23:59:59.999 IST with `endOfDay`. */
export function istDayToMs(day: string, endOfDay = false): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  return Number.isFinite(ms) ? ms : null;
}
/** Local Date (from a date picker) -> "YYYY-MM-DD" of the day the person picked. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** "YYYY-MM-DD" -> local Date at midnight (for the date picker's `selected`). */
export function dayToDate(day: string | null | undefined): Date | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}
