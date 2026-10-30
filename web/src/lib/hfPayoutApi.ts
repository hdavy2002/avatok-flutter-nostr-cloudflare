/* [HF-CLOSE-UPI-1] Withdrawal setup on the website: the person's UPI ID and the one-time ID check state.
 * Worker: GET /api/hf/payouts/summary, PUT /api/hf/payouts/upi {vpa} (the same endpoints the app uses; anyone signed in, fans too).
 * There is no UPI name check on save (nameMatched stays null); the ID check (Aadhaar OTP / DigiLocker) is /verify/id. */
import { ApiError, request } from './apiClient';
import { cachedFetch } from './hfCallsApi'; // [HF-DASH-CACHE-1]

export interface PayoutSummary {
  readyPaise: number; onHoldPaise: number; minPaise: number;
  upi: { vpa: string; nameMatched: boolean | null } | null;
  kycStatus: 'none' | 'pending' | 'verified';
  isInfluencer?: boolean;
  /** [HF-WITHDRAW-1] split of readyPaise: own wallet money (purchase lots) and matured influencer earnings. */
  walletReadyPaise?: number; earningsReadyPaise?: number;
  history?: Array<{ id: string; at: number; amountPaise: number; status: 'checking' | 'paid' | 'rejected'; utr?: string }>;
}

/** [HF-WITHDRAW-1] One withdrawal request as GET /api/hosts/me/payouts returns it (works for fans too; amount is whole rupees). */
export interface WithdrawalRequest {
  id: string; amount: number; status: 'requested' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  utr: string | null; reason: string | null; createdAt: number; paidAt: number | null; exit?: boolean;
}
export interface WithdrawalList { enabled: boolean; maxPerWeek: number; requests: WithdrawalRequest[] }

async function authed<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) throw new ApiError(401, 'no_session');
  return request<T>(path, { method, auth: token, body, headers, timeoutMs: 25_000 });
}

// [HF-DASH-CACHE-1] Wallet mounts Withdraw and Payout details together and each asked for the summary: concurrent calls now share one request
// (ttl 0 = nothing is kept once it lands, so a later call always reads fresh).
export const fetchPayoutSummary = (): Promise<PayoutSummary> => cachedFetch('payouts:summary', () => authed<PayoutSummary>('GET', '/api/hf/payouts/summary'), 0);
export const saveUpi = (vpa: string) => authed<{ ok: true; upi: { vpa: string; nameMatched: boolean | null } }>('PUT', '/api/hf/payouts/upi', { vpa });

/** [HF-WITHDRAW-1] Fan + influencer withdrawal list (raw statuses, so "approved" and "cancelled" can be shown). */
export const fetchWithdrawals = (): Promise<WithdrawalList> => authed<WithdrawalList>('GET', '/api/hosts/me/payouts');
/** POST /api/hf/payouts {amountPaise} + Idempotency-Key. Whole rupees only. One key per attempt, reused on a retry. */
export const requestWithdrawal = (rupees: number, idempotencyKey: string) =>
  authed<{ ok: true; id: string; status: 'requested'; amount: number }>('POST', '/api/hf/payouts', { amountPaise: Math.round(rupees) * 100 }, { 'Idempotency-Key': idempotencyKey });
export const cancelWithdrawal = (id: string) => authed<{ ok: true; status: string }>('POST', `/api/hosts/me/payouts/${encodeURIComponent(id)}/cancel`);

/** Friendly text for a failed withdrawal request or cancel; never a raw code. */
export function withdrawErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { error?: string; message?: string };
    switch (b.error ?? e.error) {
      case 'upi_required': return 'Add your UPI ID first, then try again.';
      case 'kyc_required': return 'Please finish the one-time ID check first, then try again.';
      case 'invalid_amount': return 'Enter a whole number of rupees.';
      case 'below_minimum': return b.message || 'That is below the smallest withdrawal for now.';
      case 'weekly_limit': return 'You have used all the withdrawal requests allowed this week. Please try again later.';
      case 'insufficient_withdrawable': return 'That is more than you can withdraw right now. Please check the amount and try again.';
      case 'not_enabled': return 'Withdrawals open soon.';
      case 'not_cancellable': return 'This request was just approved, so it can no longer be cancelled.';
      case 'wallet_error': return 'We could not set that money aside. Nothing was taken. Please try again.';
    }
    if (e.status === 429) return 'Too many tries. Please wait a while and try again.';
    if (e.status === 404) return 'Withdrawals open soon.';
    if (e.status === 401) return 'Please sign in to continue.';
  }
  return 'We could not send that request. Please check your internet and try again.';
}

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
