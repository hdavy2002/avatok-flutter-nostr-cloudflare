// [ADMIN2-SHELL 2026-09-26] Shared helpers for every Admin 2 screen island.
// Contract: Specs/SPEC-2026-09-26-ADMIN-2.md ("Shell usage").
//
// - Screen islands never mount a Clerk provider: AdminNav owns the page's ONLY
//   <ClerkProvider>, and its ClerkBridge feeds getActiveTokenWaited().
// - AdminNav probes GET /api/admin/whoami and publishes the verdict here.
//   adminApi() waits for that verdict, so a screen never fires a request for a
//   signed-in non-admin (the layout shows the "no admin access" card instead).
// - Money on the wire is integer paise: format with formatPaise().
import { ApiError, request, type RequestOptions } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { API_BASE } from '../../lib/config';

export { ApiError };
export {
  formatPaise, istDate, istDay, istTime, istDateTime, istDayToMs, errMessage, errCode, errBody, isAbort,
} from '../dashboard2/accountApi';

export type AdminGate = 'loading' | 'ok' | 'denied' | 'error';
export interface AdminWho { admin: true; uid: string; email: string | null }

export class AdminDeniedError extends Error {
  constructor() { super("You don't have admin access."); this.name = 'AdminDeniedError'; }
}

let gate: AdminGate = 'loading';
let who: AdminWho | null = null;
const waiters: Array<{ ok: () => void; no: (e: Error) => void }> = [];

/** Called by AdminNav only. Also mirrors the verdict onto the layout root for CSS. */
export function setAdminGate(next: AdminGate, me: AdminWho | null = null): void {
  gate = next;
  if (me) who = me;
  if (typeof document !== 'undefined') {
    document.querySelector<HTMLElement>('[data-admin2-root]')?.setAttribute('data-admin2-state', next);
  }
  if (next === 'loading') return;
  const list = waiters.splice(0);
  for (const w of list) (next === 'ok' ? w.ok() : w.no(new AdminDeniedError()));
}

export function adminWho(): AdminWho | null { return who; }

/**
 * Resolves once AdminNav has confirmed admin access; rejects if denied. If the nav
 * has not answered within `timeoutMs` the call proceeds anyway (the worker still
 * enforces requireAdmin on every route).
 */
export function whenAdmin(timeoutMs = 15_000): Promise<void> {
  if (gate === 'ok') return Promise.resolve();
  if (gate === 'denied' || gate === 'error') return Promise.reject(new AdminDeniedError());
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, timeoutMs);
    waiters.push({ ok: () => { clearTimeout(t); resolve(); }, no: (e) => { clearTimeout(t); reject(e); } });
  });
}

/** The signed-in admin's bearer token (null when signed out). */
export async function adminToken(): Promise<string | null> {
  return getActiveTokenWaited(6000);
}

/** Authed call to an admin worker route. Throws ApiError / AdminDeniedError. */
export async function adminApi<T>(path: string, opts: Omit<RequestOptions, 'auth'> = {}): Promise<T> {
  await whenAdmin();
  const auth = await adminToken();
  if (!auth) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  return request<T>(path, { timeoutMs: 20_000, ...opts, auth });
}

/** Authed GET of a binary/text route (e.g. a CSV export); returns the blob + filename. */
export async function adminBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  await whenAdmin();
  const auth = await adminToken();
  if (!auth) throw new ApiError(401, 'unauthorized', { message: 'Please sign in again.' });
  const url = path.startsWith('http') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store' });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* not json */ }
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, code || 'request failed', body);
  }
  const m = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '');
  return { blob: await res.blob(), filename: m?.[1] ?? null };
}

/** Save a Blob as a file in the browser. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
