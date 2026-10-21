/* [HF-CALLS-1] Typed calls + small helpers for the masked-call UI (call flow, notify-me, reviews, host dashboard).
 * Contract: Specs/HF-CALLS-CONTRACT.md ("Web agent"). Money on this surface is whole rupees (test credits for now). */
import { ApiError, request } from './apiClient';
import { explicitAgeRecovery } from './hfAgeRecovery';
import { activeSessionSignedOut } from './clerk';

export type HostPresence = 'online' | 'busy' | 'offline';
export type CallStatus =
  | 'ringing_host' | 'host_declined' | 'no_answer' | 'ringing_caller' | 'caller_no_answer' | 'connected' | 'completed' | 'failed' | 'blocked';
export const TERMINAL: CallStatus[] = ['host_declined', 'no_answer', 'caller_no_answer', 'completed', 'failed', 'blocked'];
export const isTerminal = (s: string): boolean => (TERMINAL as string[]).includes(s);

export interface CallInfo {
  id: string; status: CallStatus; hostSlug?: string; hostName?: string; rate?: number;
  connectedAt?: number | string | null; endedAt?: number | string | null;
  billedMinutes?: number | null; chargedRupees?: number | null; endReason?: string | null; canReview?: boolean;
  /** [HF-TOK-CALLS-1] token mode (caller only): seconds billed and tokens spent, 2 decimals. */
  billableSeconds?: number; tokensSpent?: string;
  /** [HF-STD-PLAN-1] Caller: what the call cost, in rupees, with one line per rate band (the lines add up to chargedPaise). */
  chargedPaise?: number; charged?: string; plan?: string; tiers?: CallTierLine[];
  /** [HF-STD-PLAN-1] Host: only their own earning for the call. */
  earningPaise?: number; earning?: string;
}
export interface CallTierLine { fromMin: number; toMin: number | null; paisePerMin: number; seconds: number; amountPaise: number }

export type HfResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; body: Record<string, unknown> };

/** Active-session hint; unknown Clerk readiness waits for the real token API. */
export function looksSignedOut(): boolean {
  return activeSessionSignedOut();
}
export function signInUrl(back?: string): string {
  const here = back ?? (typeof location !== 'undefined' ? location.pathname + location.search : '/');
  return `/sign-in?redirect_url=${encodeURIComponent(here)}`;
}

/** JSON call to the worker. `auth` (default true) attaches the Clerk bearer token; a missing session answers 401 `no_session`. */
export async function hfCall<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number; isCurrent?: () => boolean } = {}): Promise<HfResult<T>> {
  let auth: string | null = null;
  if (opts.auth !== false) {
    const { getActiveTokenWaited } = await import('./clerk');
    auth = await getActiveTokenWaited(6000);
    if (!auth) return { ok: false, status: 401, code: 'no_session', message: 'Please sign in to continue.', body: {} };
  }
  if (opts.isCurrent && !opts.isCurrent()) return { ok: false, status: 0, code: 'stale_session', message: '', body: {} };
  try {
    const data = await request<T>(path, { method, auth, body, timeoutMs: opts.timeoutMs ?? 20_000 });
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) {
      const b = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
      const message = e.error === 'age_confirmation_required'
        ? await recoverAgeConfirmation()
        : typeof b.message === 'string' ? b.message : '';
      return { ok: false, status: e.status, code: e.error, message, body: b };
    }
    return { ok: false, status: 0, code: 'network', message: 'We could not reach the server. Check your internet and try again.', body: {} };
  }
}

let cfgPromise: Promise<boolean> | null = null;
/** hfCallsEnabled from /api/config (one request per page). Any failure counts as off. */
export function callsEnabled(): Promise<boolean> {
  if (!cfgPromise) {
    cfgPromise = request<{ hfCallsEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
      .then(c => c?.hfCallsEnabled === true).catch(() => false);
  }
  return cfgPromise;
}

/** Server timestamps may be epoch seconds or milliseconds, or ISO strings. */
export function toMs(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return v < 1e12 ? v * 1000 : v;
}
export const mmss = (sec: number): string => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
/** Billed per started minute (never less than one once connected). */
export const soFar = (sec: number, rate: number): number => Math.max(1, Math.ceil(sec / 60)) * rate;
export const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
/** [HF-TOK-CALLS-1] rupees with paise, for host earnings in token mode (Rs 10.80 a minute must not show as Rs 11). */
export const inr2 = (n: number): string => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const firstName = (n: string | null | undefined): string => (n || '').trim().split(/\s+/)[0] || 'the influencer';

export function relDate(v: number | string | null | undefined): string {
  const ms = toMs(v); if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days >= 14 ? 's' : ''} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${days >= 60 ? 's' : ''} ago`;
  return 'Over a year ago';
}

/* [HF-WALLET-1] GET /api/hf/wallet. paidBalance is withdrawable money; testBalance is spend-only test credits (never withdrawable).
 * `host` is present only for hosts. `history` merges test-credit grants with completed calls (as caller and as host). */
export interface WalletHistoryItem {
  at: number; kind: 'test_credit' | 'test_credit_removed' | 'call_spent' | 'call_earned' | 'purchase' | 'call_refund' | string; rupees?: number; tokens?: string; label: string; callId?: string;
  /** [HF-STD-PLAN-1] rupee mode: signed paise, a ready string ("-₹22.47"), and the three-way split for a purchase. */
  amountPaise?: number; amount?: string; purchase?: PurchaseSplit;
}
/** [HF-STD-PLAN-1] Host earnings in paise from either the new or the older response shape. */
export function hostPaise(h: NonNullable<WalletInfo['host']>) {
  return {
    pending: h.pendingPaise ?? Math.round((h.heldRupees ?? 0) * 100),
    available: h.availablePaise ?? Math.round((h.availableRupees ?? 0) * 100),
    total: h.totalEarnedPaise ?? Math.round((h.lifetimePaidEarnings ?? 0) * 100),
    test: h.testEarningsPaise ?? Math.round((h.testEarningsRupees ?? 0) * 100),
    openPayout: h.openPayoutPaise ?? 0,
    paidOut: h.paidOutPaise ?? 0,
  };
}
/** [HF-TOK-CALLS-1] Token mode (hfTokensEnabled): callers see tokens, hosts see rupees with paise. Absent in the old mode. */
export interface TokenWallet {
  balance: string; available: string; testTokens: string;
  byValue: Array<{ valuePaisePerToken: number; valueRupees: string; tokens: string }>;
  debt: { tokens: string; valuePaise: number; open: boolean };
}
export interface HostInrWallet {
  currency: 'INR'; pendingPaise: number; availablePaise: number; totalEarnedPaise: number; testEarningsPaise: number;
  /** [HF-STD-PLAN-1] withdrawals asked for / already paid out, in paise. */
  openPayoutPaise?: number; paidOutPaise?: number;
  perCall: Array<{ callId: string; at: number; earnedPaise: number; paidPaise: number; testPaise: number; availableAt: number | null }>;
  payouts: Array<{ id: string; amountPaise: number; status: string; createdAt: number; paidAt: number | null }>;
}
/** [HF-STD-PLAN-1] mode "rupees": the wallet is plain rupees (integer paise + ready-made strings). */
export interface RupeeWallet {
  currency: 'INR'; balancePaise: number; availablePaise: number; reservedPaise: number; paidPaise: number; testPaise: number; debtPaise: number;
  balance: string; available: string; test: string; debt: string; debtOpen: boolean;
}
export interface StdPlanTier { fromMin: number; toMin: number | null; paisePerMin: number; rupeesPerMin?: string }
export interface StdPlanInfo { enabled?: boolean; startPaisePerMin?: number; gstBps?: number; gstInclusive?: boolean; influencerSetsRate?: boolean; tiers?: StdPlanTier[] }
export interface PurchaseSplit { paidPaise: number; gstPaise: number; walletPaise: number; orderId?: string }
export interface WalletInfo {
  paidBalance: number; testBalance: number; spendable: number;
  mode?: 'tokens' | 'rupees'; tokens?: TokenWallet;
  wallet?: RupeeWallet; plan?: StdPlanInfo;
  host?: { heldRupees?: number; availableRupees?: number; testEarningsRupees?: number; lifetimePaidEarnings?: number } & Partial<HostInrWallet>;
  history: WalletHistoryItem[];
  balanceRupees?: number;
}
export const fetchWallet = (): Promise<HfResult<WalletInfo>> => hfCall<WalletInfo>('GET', '/api/hf/wallet');

/** Explicit self-attestation only. Never replays a rejected call/booking. */
export function recoverAgeConfirmation(): Promise<string> {
  return explicitAgeRecovery(
    () => window.confirm('I am 18 or older. Confirm this to continue.'),
    () => hfCall('POST', '/api/hf/me/ack', { version: 'age-18-v1', ack18: true, client: 'web' }),
  );
}
