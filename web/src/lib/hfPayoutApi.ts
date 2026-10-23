/* [HF-CLOSE-UPI-1] Payout setup on the website: the person's UPI ID and the one-time ID check state.
 * Worker: GET /api/hf/payouts/summary, PUT /api/hf/payouts/upi {vpa} (the same endpoints the app uses; anyone signed in, fans too).
 * There is no UPI name check on save (nameMatched stays null); the ID check (Aadhaar OTP / DigiLocker) is /verify/id. */
import { ApiError, request } from './apiClient';

export interface PayoutSummary {
  readyPaise: number; onHoldPaise: number; minPaise: number;
  upi: { vpa: string; nameMatched: boolean | null } | null;
  kycStatus: 'none' | 'pending' | 'verified';
  isInfluencer?: boolean;
}

async function authed<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) throw new ApiError(401, 'no_session');
  return request<T>(path, { method, auth: token, body, timeoutMs: 25_000 });
}

export const fetchPayoutSummary = (): Promise<PayoutSummary> => authed<PayoutSummary>('GET', '/api/hf/payouts/summary');
export const saveUpi = (vpa: string) => authed<{ ok: true; upi: { vpa: string; nameMatched: boolean | null } }>('PUT', '/api/hf/payouts/upi', { vpa });

/** Same rule as the worker (UPI_RE), so the form can say "invalid" before sending. */
export const UPI_RE = /^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$/;
export const cleanUpi = (v: string) => v.trim().toLowerCase();

/** "as****@okhdfc": first two letters of the name and the bank handle; the rest hidden. Used everywhere the saved UPI is shown. */
export function maskUpi(v: string): string {
  const [n = '', h = ''] = v.split('@');
  return `${n.length <= 2 ? n.slice(0, 1) : n.slice(0, 2)}${'*'.repeat(Math.max(2, n.length - 2))}@${h}`;
}

export function upiSaveMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { error?: string; message?: string };
    if (b.error === 'invalid_upi') return 'Enter a valid UPI ID, like name@bank.';
    if (e.status === 429) return 'Too many tries. Please wait a while and try again.';
    if (e.status === 404) return 'Withdrawals open soon.';
    if (e.status === 401) return 'Please sign in to continue.';
    if (b.message) return b.message;
  }
  return 'We could not save your UPI ID. Please check your internet and try again.';
}
export { ApiError };
