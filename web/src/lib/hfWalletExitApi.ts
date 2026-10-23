/* [HF-WALLET-EXIT-1] Client for wallet refunds and pay-out-first account closure.
 * Worker: GET/POST /api/hf/wallet/refunds, POST .../:id/cancel; GET/POST/DELETE /api/hf/account/exit. Contract: Specs/HF-CALLS-CONTRACT.md. */
import { ApiError, request } from './apiClient';

export interface RefundItem { id: string; amount: number; status: 'requested' | 'processing' | 'refunded' | 'rejected' | 'cancelled'; reason: string | null; utr: string | null; exit: boolean; createdAt: number; refundedAt: number | null }
export interface RefundInfo { enabled: boolean; walletOnly?: boolean; message?: string; mode?: 'tokens' | 'rupees'; windowDays?: number; refundable?: number; eligible?: number; lots?: RefundLot[]; requests: RefundItem[] }
/** Token mode: one entry per Google Play purchase that still has unused tokens (money in rupees, fractional). */
export interface RefundLot { lotId: string; tokens: string; paid: number; refund: number; wholeOrder: boolean; boughtAt: number }
export interface TokenExitInfo {
  mode: 'tokens'; refundPaise: number; refundLots: number; partialLots: number; partialPaise: number; testValuePaise: number; debtValuePaise: number; availablePaise: number; pendingPaise: number;
  /** [HF-FIX-CLOSE-ACCOUNT-1] The wallet balance exactly as the Wallet page shows it (after GST); closing pays it out to the person's UPI in whole rupees. */
  walletPaise: number; walletPayoutPaise: number; /** [HF-CLOSE-UPI-1] the sub-rupee rest that is not paid out (retired at deletion). Absent on older worker answers. */ roundingPaise?: number; upiOk: boolean; kycOk: boolean; payoutReady: boolean; debtBlocked: boolean;
}

export interface ExitInfo {
  gateEnabled: boolean;
  mode?: 'tokens' | 'rupees';
  tokens?: TokenExitInfo;
  decision: 'delete' | 'exit';
  paidBalance: number; withdrawable: number; held: number; heldReleaseAt: number | null;
  refundable: number; manualRefund: number; forfeitRupees: number; bankOk: boolean; testCredits: number; testEarnings: number;
  exit: { status: 'waiting_hold' | 'waiting_payouts' | 'ready' | 'done' | 'cancelled'; payoutId: string | null; refundId: string | null; note: string | null; requestedAt: number } | null;
  payout: { id: string; amount: number; status: string; reason: string | null; utr: string | null } | null;
  refund: { id: string; amount: number; status: string; reason: string | null; utr: string | null } | null;
  deletion: { status: string; scheduledAt: number } | null;
}

async function authed<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const { getActiveTokenWaited } = await import('./clerk');
  const token = await getActiveTokenWaited(6000);
  if (!token) throw new ApiError(401, 'no_session');
  return request<T>(path, { method, auth: token, body, headers, timeoutMs: 25_000 });
}

export const fetchRefunds = (): Promise<RefundInfo> => authed<RefundInfo>('GET', '/api/hf/wallet/refunds');
export const requestRefund = (amount?: number, lotId?: string) =>
  authed<{ ok: true; id: string; amount: number }>('POST', '/api/hf/wallet/refunds', { ...(amount ? { amount } : {}), ...(lotId ? { lotId } : {}) }, { 'Idempotency-Key': crypto.randomUUID() });
export const cancelRefund = (id: string) => authed<{ ok: true }>('POST', `/api/hf/wallet/refunds/${encodeURIComponent(id)}/cancel`, {});

export const fetchExit = (): Promise<ExitInfo> => authed<ExitInfo>('GET', '/api/hf/account/exit');
export const startExit = (forfeit: boolean) =>
  authed<{ ok: true; status: string; payoutId: string | null; refundId: string | null }>('POST', '/api/hf/account/exit', { forfeit }, { 'Idempotency-Key': crypto.randomUUID() });
export const cancelExit = () => authed<{ ok: true }>('DELETE', '/api/hf/account/exit');
/** Existing platform deletion request (30-day grace). Answers 409 {deferred:true} while real money still has to be paid out. */
export const deleteAccountNow = () => authed<{ scheduled: boolean; grace_ends_at?: number }>('POST', '/api/account/delete', {});

/** [HF-WIRE-16] Where money leaves the wallet. Influencers withdraw on the web; fans use Withdraw in the app (Me, then Withdraw). */
export const PAYOUT_HREF = '/dashboard/wallet#withdraw'; // [HF-WITHDRAW-1] one Withdraw card on Wallet, for fans and influencers

/** The stable error code the worker sent (`withdraw_first`, `forfeit_required`, `refund_to_wallet_only`...), or ''. */
export function walletExitCode(e: unknown): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') { const c = (e.body as { error?: unknown }).error; if (typeof c === 'string') return c; }
  return '';
}

const CODE_TEXT: Record<string, string> = {
  upi_required: 'Add your UPI ID first (on the Wallet page, Withdrawal setup, or in the app: Me, then Withdraw). Your wallet money is paid out to it when you close your account.',
  kyc_required: 'We check your ID once, before your first withdrawal. Do that first, then close your account.',
  withdraw_first: 'Your wallet money does not go back to your card. Withdraw it to your UPI with the Withdraw button first, then close your account.',
  forfeit_required: 'Your wallet holds less than ₹1, which is too small to pay out. Tick the box to give it up and close your account.',
  refund_to_wallet_only: 'Refunds go to your wallet, not to your card. You can withdraw your wallet to your UPI with the Withdraw button.',
};

export function walletExitMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { message?: string };
    const code = walletExitCode(e);
    if (CODE_TEXT[code]) return CODE_TEXT[code];
    if (e.status === 401) return 'Please sign in to continue.';
    if (e.status === 429) return 'Too many attempts. Please try again in a while.';
    if (b.message) return b.message;
  }
  return 'Something went wrong. Please check your internet and try again.';
}
export { ApiError };
