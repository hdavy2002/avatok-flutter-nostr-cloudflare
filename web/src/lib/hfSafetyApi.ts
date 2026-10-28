/* [HF-CALL-SAFETY-WEB] Website side of call safety (Specs/HF-CALL-SAFETY-1.md; contract: HF-CALL-SAFETY-CONTRACT.md).
 * Fans: the pre-call notice (shown only while hfCallRecordingEnabled is on) and the post-call report.
 * Influencers: GET /api/hf/safety/me (strikes, paused state, held money), appeals and the one-time call-rules acceptance.
 * Admin calls live in hfSafetyAdminApi.ts so the dashboard bundle never pulls in admin code. */
import { request } from './apiClient';
import { hfCall, type HfResult } from './hfCallsApi';
import { currentDistinctUid } from './analytics';

/** The public call-rules page (legal copy is owned elsewhere; this is only the link). */
export const CALL_RULES_HREF = '/rules-of-engagement';
export const SAFETY_PAGE_HREF = '/dashboard/host/safety';
export const SAFETY_RULES_HREF = '/dashboard/host/safety#rules';

export type StrikeReason = 'selling' | 'outside_payment' | 'contact_sharing' | 'abuse' | 'sexual' | 'danger';
export type SafetyStatus = 'active' | 'paused' | 'banned';
export type AppealStatus = null | 'open' | 'accepted' | 'rejected';

export interface SafetyStrike {
  id: string; reason: StrikeReason; reasonText: string; callAt: number;
  /** The person's OWN words only (never the other side). */
  quote: string | null;
  expiresAt: number; removedAt: number | null; removedWhy: string | null;
  appealStatus: AppealStatus; canAppeal: boolean;
}
export interface SafetyMe {
  status: SafetyStatus; activeStrikes: number; strikesToPause: number; reviewDueAt: number | null; heldPaise: number;
  rulesAccepted: boolean; rulesVersion: number; recordingEnabled: boolean; strikes: SafetyStrike[];
}

/** Short names for the strike reasons. The server's reasonText wins when present. */
export const REASON_TITLE: Record<StrikeReason, string> = {
  selling: 'Selling on a call',
  outside_payment: 'Asked for payment outside the app',
  contact_sharing: 'Shared or asked for contact details',
  abuse: 'Abusive or rude talk',
  sexual: 'Sexual talk',
  danger: 'Threat or danger',
};

export const getSafetyMe = (): Promise<HfResult<SafetyMe>> => hfCall<SafetyMe>('GET', '/api/hf/safety/me');
export const appealStrike = (id: string, message: string) =>
  hfCall<{ ok: boolean; appealStatus: 'open' }>('POST', `/api/hf/safety/strikes/${encodeURIComponent(id)}/appeal`, { message });
export const acceptCallRules = (version: number) => hfCall<{ ok: boolean }>('POST', '/api/hf/safety/rules/accept', { version });

export type ReportReason = 'selling' | 'outside_payment' | 'asked_number' | 'abusive';
export const REPORT_REASONS: [ReportReason, string][] = [
  ['selling', 'Tried to sell me something'],
  ['outside_payment', 'Asked me to pay outside the app'],
  ['asked_number', 'Asked for my number'],
  ['abusive', 'Rude or abusive'],
];
export const reportCall = (callId: string, reasons: ReportReason[], note?: string) =>
  hfCall<{ ok: boolean }>('POST', `/api/hf/calls/${encodeURIComponent(callId)}/report`, { reasons, note: note || undefined });

/* ── config flag (one request per page, any failure counts as off) ───────── */
let recPromise: Promise<boolean> | null = null;
export function recordingEnabled(): Promise<boolean> {
  if (!recPromise) {
    recPromise = request<{ hfCallRecordingEnabled?: boolean }>('/api/config', { timeoutMs: 8000 })
      .then(c => c?.hfCallRecordingEnabled === true).catch(() => false);
  }
  return recPromise;
}

/* ── "Don't show this again", stored per account in this browser only ────── */
const noticeKey = () => `hf:safety-notice:v1:${currentDistinctUid() ?? 'unknown'}`;
export function noticeDismissed(): boolean {
  try { return localStorage.getItem(noticeKey()) === '1'; } catch { return false; }
}
export function dismissNoticeForever(): void {
  try { localStorage.setItem(noticeKey(), '1'); } catch { /* storage blocked: the notice just shows again next time */ }
}

/* ── 403 from going Online / calling / booking / joining a queue ─────────── */
export interface SafetyBlock { kind: 'paused' | 'rules'; text: string; href: string; label: string }
export function safetyBlock(code: string | undefined | null, audience: 'influencer' | 'fan' = 'influencer'): SafetyBlock | null {
  if (code === 'account_paused') {
    return audience === 'fan'
      ? { kind: 'paused', text: 'Your account is paused while a person checks it. You can’t call or book right now, but you can still log in and withdraw your wallet money.', href: SAFETY_PAGE_HREF, label: 'See details' }
      : { kind: 'paused', text: 'Your account is paused while a person checks your calls. Nothing can start until the check is done.', href: SAFETY_PAGE_HREF, label: 'See why and what to do' };
  }
  if (code === 'call_rules_required') return { kind: 'rules', text: 'Please read and agree to the call rules once before you go online.', href: SAFETY_RULES_HREF, label: 'Read the call rules' };
  return null;
}

/** Whole rupees from paise, no decimals when it is a round number. */
export const rupees = (paise: number | null | undefined): string => {
  const v = (paise ?? 0) / 100;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

/** Whole-day text like "10 Jan" in India time. */
export const safetyDay = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';

export const SAFETY_EVENTS = {
  page: 'hf_safety_page_view', appealOpen: 'hf_safety_appeal_open', appealSent: 'hf_safety_appeal_sent', appealFailed: 'hf_safety_appeal_failed',
  rulesView: 'hf_safety_rules_view', rulesAccepted: 'hf_safety_rules_accepted', rulesFailed: 'hf_safety_rules_failed',
  noticeShown: 'hf_safety_notice_shown', noticeOk: 'hf_safety_notice_ok', noticeCancel: 'hf_safety_notice_cancel',
  reportOpen: 'hf_safety_report_open', reportSent: 'hf_safety_report_sent', reportFailed: 'hf_safety_report_failed', reportGood: 'hf_safety_report_good',
  blocked: 'hf_safety_blocked_403',
} as const;
