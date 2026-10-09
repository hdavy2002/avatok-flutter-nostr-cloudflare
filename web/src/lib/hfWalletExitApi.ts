/* [HF-WALLET-EXIT-1] Client for wallet refunds and pay-out-first account closure.
 * Worker: GET/POST /api/hf/wallet/refunds, POST .../:id/cancel; GET/POST/DELETE /api/hf/account/exit. Contract: Specs/HF-CALLS-CONTRACT.md. */
import { ApiError, request } from './apiClient';

export interface RefundItem { id: string; amount: number; status: 'requested' | 'processing' | 'refunded' | 'rejected' | 'cancelled'; reason: string | null; utr: string | null; exit: boolean; createdAt: number; refundedAt: number | null }
export interface RefundInfo { enabled: boolean; windowDays?: number; refundable?: number; eligible?: number; requests: RefundItem[] }

export interface ExitInfo {
  gateEnabled: boolean;
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
export const requestRefund = (amount?: number) =>
  authed<{ ok: true; id: string; amount: number }>('POST', '/api/hf/wallet/refunds', amount ? { amount } : {}, { 'Idempotency-Key': crypto.randomUUID() });
export const cancelRefund = (id: string) => authed<{ ok: true }>('POST', `/api/hf/wallet/refunds/${encodeURIComponent(id)}/cancel`, {});

export const fetchExit = (): Promise<ExitInfo> => authed<ExitInfo>('GET', '/api/hf/account/exit');
export const startExit = (forfeit: boolean) =>
  authed<{ ok: true; status: string; payoutId: string | null; refundId: string | null }>('POST', '/api/hf/account/exit', { forfeit }, { 'Idempotency-Key': crypto.randomUUID() });
export const cancelExit = () => authed<{ ok: true }>('DELETE', '/api/hf/account/exit');
/** Existing platform deletion request (30-day grace). Answers 409 {deferred:true} while real money still has to be paid out. */
export const deleteAccountNow = () => authed<{ scheduled: boolean; grace_ends_at?: number }>('POST', '/api/account/delete', {});

export function walletExitMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body && typeof e.body === 'object' ? e.body : {}) as { message?: string };
    if (e.status === 401) return 'Please sign in to continue.';
    if (e.status === 429) return 'Too many attempts. Please try again in a while.';
    if (b.message) return b.message;
  }
  return 'Something went wrong. Please check your internet and try again.';
}
export { ApiError };
