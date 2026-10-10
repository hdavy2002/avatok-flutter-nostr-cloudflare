/* [HF-CALLS-1] Typed calls + small helpers for the masked-call UI (call flow, notify-me, reviews, host dashboard).
 * Contract: Specs/HF-CALLS-CONTRACT.md ("Web agent"). Money on this surface is whole rupees (test credits for now). */
import { ApiError, request } from './apiClient';

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
}

export type HfResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; body: Record<string, unknown> };

/** Same test as the site head's auth hint: no live Clerk session cookie and no guest token means nobody is signed in. */
export function looksSignedOut(): boolean {
  try {
    const m = document.cookie.match(/(?:^|;\s*)__client_uat(?:_[A-Za-z0-9]+)?=([^;]*)/);
    if (m && m[1] && m[1] !== '0') return false;
    try { if (localStorage.getItem('saathum_guest_jwt')) return false; } catch { /* ignore */ }
    return true;
  } catch { return false; }
}
export function signInUrl(back?: string): string {
  const here = back ?? (typeof location !== 'undefined' ? location.pathname + location.search : '/');
  return `/sign-in?redirect_url=${encodeURIComponent(here)}`;
}

/** JSON call to the worker. `auth` (default true) attaches the Clerk bearer token; a missing session answers 401 `no_session`. */
export async function hfCall<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<HfResult<T>> {
  let auth: string | null = null;
  if (opts.auth !== false) {
    const { getActiveTokenWaited } = await import('./clerk');
    auth = await getActiveTokenWaited(6000);
    if (!auth) return { ok: false, status: 401, code: 'no_session', message: 'Please sign in to continue.', body: {} };
  }
  try {
    const data = await request<T>(path, { method, auth, body, timeoutMs: opts.timeoutMs ?? 20_000 });
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) {
      const b = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
      return { ok: false, status: e.status, code: e.error, message: typeof b.message === 'string' ? b.message : '', body: b };
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
export const firstName = (n: string | null | undefined): string => (n || '').trim().split(/\s+/)[0] || 'the host';

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
export interface WalletHistoryItem { at: number; kind: 'test_credit' | 'test_credit_removed' | 'call_spent' | 'call_earned' | string; rupees?: number; tokens?: string; label: string; callId?: string }
/** [HF-TOK-CALLS-1] Token mode (hfTokensEnabled): callers see tokens, hosts see rupees with paise. Absent in the old mode. */
export interface TokenWallet {
  balance: string; available: string; testTokens: string;
  byValue: Array<{ valuePaisePerToken: number; valueRupees: string; tokens: string }>;
  debt: { tokens: string; valuePaise: number; open: boolean };
}
export interface HostInrWallet {
  currency: 'INR'; pendingPaise: number; availablePaise: number; totalEarnedPaise: number; testEarningsPaise: number;
  perCall: Array<{ callId: string; at: number; earnedPaise: number; paidPaise: number; testPaise: number; availableAt: number | null }>;
  payouts: Array<{ id: string; amountPaise: number; status: string; createdAt: number; paidAt: number | null }>;
}
export interface WalletInfo {
  paidBalance: number; testBalance: number; spendable: number;
  mode?: 'tokens'; tokens?: TokenWallet;
  host?: { heldRupees: number; availableRupees: number; testEarningsRupees: number; lifetimePaidEarnings: number } & Partial<HostInrWallet>;
  history: WalletHistoryItem[];
  balanceRupees?: number;
  /** [HF-WALLET-LIMITS-1] Real-money spend so far against the caller's limits (IST day / month). Absent on an older worker. */
  limits?: { daily: number; monthly: number; spentToday: number; spentThisMonth: number; resetsAt: number };
}
export const fetchWallet = (): Promise<HfResult<WalletInfo>> => hfCall<WalletInfo>('GET', '/api/hf/wallet');
