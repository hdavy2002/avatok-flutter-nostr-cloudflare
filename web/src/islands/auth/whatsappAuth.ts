/* [WA-WEB-1 2026-09-28] WhatsApp as a first-class sign-in method.
 *
 * Owner decision (2026-09-28): every user must have a verified WhatsApp
 * number to do anything signed-in on the site. Login is a choice of email
 * code / WhatsApp code / Google. This module is the client side of the new,
 * UNauthenticated WhatsApp endpoints — the ones that can sign someone in
 * before any Clerk session exists — kept separate from passwordless.ts
 * (email) and the existing authed /api/account/phone/* + /api/me/phone/*
 * routes (which attach/change a WhatsApp number on an ALREADY signed-in
 * account, and now take any international +<E.164>, not just +91).
 *
 * Flow:
 *   1. sendWhatsAppCode(phone) -> a 6-digit code on WhatsApp.
 *   2. verifyWhatsAppCode(phone, code) ->
 *        status: 'signed_in'   — this number already has an account. `ticket`
 *                                 redeems a real Clerk session via
 *                                 redeemWhatsAppTicket below.
 *        status: 'needs_email' — a brand-new number. `proof` must be handed
 *                                 to claimWhatsAppProof once an email
 *                                 sign-up/sign-in has produced a session, so
 *                                 the number attaches WITHOUT asking for a
 *                                 second WhatsApp code.
 * `proof` is short-lived (server-side) and is kept in sessionStorage here so
 * it survives the redirect through Clerk's own email flow.
 */
import { capture, captureException } from '../../lib/analytics';
import { request, ApiError } from '../../lib/apiClient';
import { PasswordlessError } from './passwordless';

export interface WaSendResult {
  ok: boolean;
  phone_masked: string;
  expires_in_s: number;
  resend_after_s: number;
}

export interface WaVerifySignedIn {
  ok: boolean;
  status: 'signed_in';
  ticket: string;
  /** [HF-AUTH-WA-1] Present only while the server's phone-only sign-up flag is on. */
  isNew?: boolean;
  /** [HF-AUTH-WA-1] true = a new phone-only account that has not yet confirmed 18+. */
  needs18Plus?: boolean;
}
export interface WaVerifyNeedsEmail {
  ok: boolean;
  status: 'needs_email';
  proof: string;
  phone_masked: string;
}
export type WaVerifyResult = WaVerifySignedIn | WaVerifyNeedsEmail;

/** The Worker's short error code ("invalid_phone", "not_on_whatsapp", …) or ''. */
export function waApiCode(e: unknown): string {
  return e instanceof ApiError ? e.error : '';
}

/** The human sentence from the Worker's error body, else `fallback`. */
export function waApiMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: unknown } | null;
    if (b && typeof b === 'object' && typeof b.message === 'string' && b.message.trim()) return b.message;
  }
  return fallback;
}

/** POST /api/auth/whatsapp/send — no auth. `phone` must already be E.164. */
export async function sendWhatsAppCode(phone: string): Promise<WaSendResult> {
  try {
    const r = await request<WaSendResult>('/api/auth/whatsapp/send', { method: 'POST', body: { phone } });
    capture('auth_whatsapp_send', { ok: true });
    return r;
  } catch (e) {
    capture('auth_whatsapp_send', { ok: false, error: waApiCode(e) || 'unknown' });
    if (!(e instanceof ApiError)) captureException(e, { where: 'auth_whatsapp_send' });
    throw e;
  }
}

/** POST /api/auth/whatsapp/verify — no auth. */
export async function verifyWhatsAppCode(phone: string, code: string): Promise<WaVerifyResult> {
  try {
    const r = await request<WaVerifyResult>('/api/auth/whatsapp/verify', { method: 'POST', body: { phone, code, client: 'web' } });
    capture('auth_whatsapp_verify', { status: r.status });
    return r;
  } catch (e) {
    capture('auth_whatsapp_verify', { error: waApiCode(e) || 'unknown' });
    if (!(e instanceof ApiError)) captureException(e, { where: 'auth_whatsapp_verify' });
    throw e;
  }
}

/** Minimal shape of Clerk's `signIn` resource this needs — see passwordless.ts's PwlSignIn. */
export interface TicketSignIn {
  create(p: { strategy: 'ticket'; ticket: string }): Promise<{ status: string | null; createdSessionId?: string | null }>;
}

/** Redeem a `status: 'signed_in'` ticket against Clerk, minting a real session. */
export async function redeemWhatsAppTicket(
  // Typed `unknown` on purpose: callers pass the same Clerk `signIn` resource they
  // hand passwordless.ts (typed there as the narrower PwlSignIn), and the real
  // resource does support strategy:'ticket'.
  signInResource: unknown,
  setActive: ((p: { session: string }) => Promise<unknown>) | undefined,
  ticket: string,
): Promise<void> {
  const signIn = signInResource as TicketSignIn | null | undefined;
  if (!signIn || !setActive) throw new PasswordlessError('Sign-in is still loading. Try again in a moment.', 'signin_unavailable');
  const res = await signIn.create({ strategy: 'ticket', ticket });
  if (res.status !== 'complete' || !res.createdSessionId) {
    throw new PasswordlessError('That didn’t complete sign-in. Please try again.', 'ticket_incomplete');
  }
  await setActive({ session: res.createdSessionId });
}

/* ── carrying `proof` through the email hand-off ─────────────────────────── */

const PROOF_KEY = 'wa_email_proof';
const PROOF_TTL_MS = 30 * 60 * 1000;
interface StoredProof { proof: string; phone_masked: string; at: number }

export function storeWaProof(proof: string, phoneMasked: string): void {
  try {
    sessionStorage.setItem(PROOF_KEY, JSON.stringify({ proof, phone_masked: phoneMasked, at: Date.now() }));
  } catch { /* best-effort — worst case the person is asked to re-verify */ }
}

export function readWaProof(): StoredProof | null {
  try {
    const raw = sessionStorage.getItem(PROOF_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredProof;
    if (!p?.proof || Date.now() - p.at > PROOF_TTL_MS) { sessionStorage.removeItem(PROOF_KEY); return null; }
    return p;
  } catch { return null; }
}

export function clearWaProof(): void {
  try { sessionStorage.removeItem(PROOF_KEY); } catch { /* best-effort */ }
}

/**
 * POST /api/account/phone/claim {proof} (auth) — attaches the WhatsApp
 * number the `needs_email` step verified to the account that just signed up
 * or signed in by email. Never asks for a second WhatsApp code.
 */
export async function claimWhatsAppProof(proof: string, auth: string): Promise<{ ok: boolean; verified: true; phone: string }> {
  try {
    const r = await request<{ ok: boolean; verified: true; phone: string }>('/api/account/phone/claim', {
      method: 'POST', auth, body: { proof },
    });
    capture('phone_claim', { ok: true });
    clearWaProof();
    return r;
  } catch (e) {
    capture('phone_claim', { ok: false, error: waApiCode(e) || 'unknown' });
    if (!(e instanceof ApiError)) captureException(e, { where: 'phone_claim' });
    throw e;
  }
}

/**
 * [HF-AUTH-WA-1] POST /api/hf/account/age-confirm (auth) — stores the "I'm 18 or over"
 * tick for a phone-only account (the server asks for it with needs18Plus:true).
 */
export async function confirmAge18(auth: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hf/account/age-confirm', {
    method: 'POST', auth, body: { confirmed: true, client: 'web' },
  });
}
