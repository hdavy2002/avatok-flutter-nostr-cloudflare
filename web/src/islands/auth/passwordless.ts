/* [WEB-PWLESS-1 2026-09-06] The one email-code flow, shared by every web surface.
 *
 * ── WHAT WENT WRONG, AND WHY IT LIVED SO LONG ────────────────────────────────
 * Checkout, /sign-in and /sign-up each grew their OWN version of "email the
 * person a code", and each one worked around the same missing piece differently.
 * The piece: on the production Clerk instance, **"Sign-in with email → Email
 * verification code" was switched OFF**. `email_address.first_factors` came back
 * `[]` from `/v1/environment`, and a `POST /v1/client/sign_ins` for a real
 * account advertised only `reset_password_email_code`.
 *
 * So for anyone who ALREADY had an account:
 *   • checkout threw a bare Error, which carries no `errors[]`, so the UI printed
 *     its fallback — "Could not send the code. Check the address and try again."
 *     The address was never the problem. Nobody with an account could pay.
 *   • /sign-in fell back to attempting a password, and the elaborate
 *     HIBP / needs_new_password / relist-the-factors machinery in LoginIsland
 *     existed entirely to survive that.
 *
 * It was a dashboard toggle, not a code bug, and no amount of client code could
 * have fixed it. It is now ON, password is DISABLED instance-wide, and first/last
 * name are no longer required at sign-up (they were: a signup carrying only an
 * email came back `missing_requirements` and never minted a session, which would
 * have broken the NEW-user half of checkout the moment the old half was fixed).
 *
 * ── THE RULE THIS FILE ENCODES ───────────────────────────────────────────────
 * One box, one code, one account. We do NOT ask whether someone already has an
 * account — asking is a wasted step and an account-enumeration oracle. Try
 * sign-UP; when Clerk says the identifier is taken, switch to sign-IN. Same email
 * box, same 6-digit code, either way.
 *
 * ── DO NOT REINTRODUCE A PASSWORD PATH ───────────────────────────────────────
 * `password` is disabled on the instance (owner decision 2026-09-06). A password
 * field would fail at Clerk, not in the browser, so it would look like a broken
 * site rather than a missing feature.
 */
import { capture } from '../../lib/analytics';
import { getActiveTokenWaited } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';

/** Which half of the flow a code belongs to. Verify must use the same one. */
export type PwlMode = 'signUp' | 'signIn';

/* Structural types for the slices of Clerk's resources we touch. `@clerk/types`
 * is not a dependency here (only @clerk/clerk-react is), so these are declared
 * narrowly enough that an unrelated Clerk field change cannot break the build. */
export interface PwlFactor { strategy: string; emailAddressId?: string }
export interface PwlResult { status: string | null; createdSessionId?: string | null }
export interface PwlSignUp {
  create(p: Record<string, unknown>): Promise<PwlResult>;
  prepareEmailAddressVerification(p: { strategy: 'email_code' }): Promise<unknown>;
  attemptEmailAddressVerification(p: { code: string }): Promise<PwlResult>;
}
export interface PwlSignIn {
  create(p: { identifier: string }): Promise<{ supportedFirstFactors?: PwlFactor[] | null }>;
  prepareFirstFactor(p: { strategy: 'email_code'; emailAddressId: string }): Promise<unknown>;
  attemptFirstFactor(p: { strategy: 'email_code'; code: string }): Promise<PwlResult>;
  authenticateWithRedirect(p: {
    strategy: string; redirectUrl: string; redirectUrlComplete: string;
  }): Promise<unknown>;
}

/** Clerk errors arrive as { errors: [{ code, message, longMessage }] }. */
export function clerkErrors(e: unknown): { code: string; message: string }[] {
  const raw = (e as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return { code: String(r.code ?? ''), message: String(r.longMessage ?? r.message ?? '') };
  });
}

/**
 * One line a person can act on, and a `reason` for telemetry.
 *
 * [WEB-PWLESS-1] The old code called a helper that returned ONLY the Clerk
 * message and fell back to a generic string. Errors we raise ourselves carry no
 * `errors[]`, so every one of them printed the generic line — which is exactly
 * how "email codes are switched off for this instance" reached the owner
 * disguised as "check the address". Our own failures now carry their own text.
 */
export function pwlError(e: unknown, fallback: string): { message: string; reason: string } {
  if (e instanceof PasswordlessError) return { message: e.message, reason: e.reason };
  const first = clerkErrors(e)[0];
  if (first?.message?.trim()) return { message: first.message, reason: first.code || 'clerk_error' };
  return { message: fallback, reason: 'unknown' };
}

/** A failure we diagnosed ourselves, with words worth showing. */
export class PasswordlessError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'PasswordlessError';
    this.reason = reason;
  }
}

/** "This email already has an account" — the signal to switch to sign-in. */
function isAlreadyExists(e: unknown): boolean {
  return clerkErrors(e).some(
    (x) => x.code === 'form_identifier_exists' || x.code === 'identifier_already_signed_in',
  );
}

/**
 * Materialise the avaTOK-side account.
 *
 * [WEB-PWLESS-1] Until now ONLY /sign-up did this, so an account created at
 * checkout existed to Clerk and was invisible to avaTOK — no `users` row, no
 * AvaTOK number, nothing to attach a booking or a later app sign-in to. Every
 * path that creates an account calls it now.
 *
 * Never throws: the Clerk session is already live by the time we get here, so a
 * failure must not strand somebody who has successfully signed in. The route is
 * idempotent, so the next page that calls it finishes the job.
 */
export async function bootstrapAccount(body: {
  phone?: string; country?: string; display_name?: string;
} = {}): Promise<{ ok: boolean; message?: string }> {
  try {
    const token = await getActiveTokenWaited();
    if (!token) return { ok: false, message: 'Your session isn’t ready yet. Please try again.' };
    await request('/api/account/bootstrap', {
      method: 'POST', auth: token,
      body: { country: 'IN', ...body },
    });
    capture('web_account_bootstrap_client', { outcome: 'ok' });
    return { ok: true };
  } catch (e) {
    capture('web_account_bootstrap_client', { outcome: 'error' });
    return { ok: false, message: apiMessage(e, 'We couldn’t open your account just now. Please try again.') };
  }
}

/* ── [WEB-PHONE-OTP-1 2026-09-10] Phone OTP (2Factor, via the Worker) ───── */

/** The human sentence from a Worker error body ({ message }), else `fallback`. */
export function apiMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: unknown } | null;
    if (b && typeof b === 'object' && typeof b.message === 'string' && b.message.trim()) return b.message;
  }
  return fallback;
}

/** The Worker's short error code ("phone_taken", "too_soon", …) or ''. */
export function apiCode(e: unknown): string {
  return e instanceof ApiError ? e.error : '';
}

export interface PhoneStatus { verified: boolean; phone: string | null; has_account: boolean; needs_phone: boolean }

async function authed<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const token = await getActiveTokenWaited();
  if (!token) throw new PasswordlessError('Your session isn’t ready yet. Please try again.', 'no_session');
  return request<T>(path, { method, auth: token, body });
}

export function sendPhoneCode(phone: string) {
  return authed<{ ok: boolean; phone: string; already_verified?: boolean; resend_after_s?: number }>(
    '/api/account/phone/send', 'POST', { phone },
  );
}
export function verifyPhoneCode(code: string) {
  return authed<{ ok: boolean; verified: boolean; phone: string }>('/api/account/phone/verify', 'POST', { code });
}
export function getPhoneStatus() {
  return authed<PhoneStatus>('/api/account/phone/status', 'GET');
}

/**
 * Every web sign-in lands via /sign-up?finish=1 so a new account (email code on
 * /sign-in, or Google anywhere) cannot skip phone verification. Existing
 * accounts pass straight through to `next`; see phoneOtpStatus in the Worker.
 */
export function finishUrl(next: string, role?: string): string {
  const q = new URLSearchParams({ finish: '1', next });
  if (role) q.set('role', role);
  return `/sign-up?${q.toString()}`;
}

/**
 * Email a 6-digit code to `email`, creating the account if there isn't one.
 * Returns the mode the eventual `verifyPasswordlessCode` must be given.
 *
 * `extra` is merged into the sign-up create call (unsafeMetadata, names) and is
 * ignored when the address turns out to be an existing account — by then those
 * fields are already on the user and a sign-in cannot set them.
 */
export async function sendPasswordlessCode(opts: {
  signUp: PwlSignUp | null | undefined;
  signIn: PwlSignIn | null | undefined;
  email: string;
  extra?: Record<string, unknown>;
}): Promise<PwlMode> {
  const { signUp, signIn, extra } = opts;
  const email = opts.email.trim().toLowerCase();

  try {
    if (!signUp) throw new PasswordlessError('Sign-up is still loading. Try again in a moment.', 'signup_unavailable');
    await signUp.create({ emailAddress: email, ...(extra ?? {}) });
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return 'signUp';
  } catch (e) {
    // An existing account is not an error — it is the other half of the flow.
    if (!isAlreadyExists(e)) throw e;
  }

  if (!signIn) throw new PasswordlessError('Sign-in is still loading. Try again in a moment.', 'signin_unavailable');
  const attempt = await signIn.create({ identifier: email });
  const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === 'email_code' && f.emailAddressId);

  // [WEB-PWLESS-1] THE FAILURE THAT STARTED ALL THIS. If this ever fires again,
  // the cause is almost certainly the instance-level toggle, not this account:
  //   Clerk → Configure → User & authentication → Email → Sign-in with email
  //   → "Email verification code"
  // Check it with:
  //   curl -s https://clerk.avatok.ai/v1/environment \
  //     | jq '.user_settings.attributes.email_address.first_factors'
  // An empty array there means no sign-in strategy is enabled AT ALL and nobody
  // with an existing account can get in by any route. Say so plainly rather than
  // blaming the address, which is what cost a whole debugging session.
  if (!factor?.emailAddressId) {
    throw new PasswordlessError(
      'This account can’t be sent a sign-in code right now. This is a setting on our side, not a problem with your email — please contact support.',
      'no_email_code_factor',
    );
  }

  await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
  return 'signIn';
}

/**
 * Confirm the code and activate the session.
 * Returns true when the account was newly created (so the caller can decide
 * where a brand-new person should land).
 */
export async function verifyPasswordlessCode(opts: {
  mode: PwlMode;
  signUp: PwlSignUp | null | undefined;
  signIn: PwlSignIn | null | undefined;
  setActive: (p: { session: string }) => Promise<unknown>;
  code: string;
  /** Passed to /api/account/bootstrap when this call creates the account. */
  bootstrap?: { phone?: string; display_name?: string };
}): Promise<{ created: boolean }> {
  const code = opts.code.trim();

  if (opts.mode === 'signUp') {
    if (!opts.signUp) throw new PasswordlessError('Sign-up is still loading. Try again in a moment.', 'signup_unavailable');
    const res = await opts.signUp.attemptEmailAddressVerification({ code });
    if (res.status !== 'complete' || !res.createdSessionId) {
      // [WEB-PWLESS-1] `missing_requirements` here means Clerk wants a field the
      // form never collected. First/last name were `required` on this instance
      // until 2026-09-06 and would have landed exactly here.
      throw new PasswordlessError(
        res.status === 'missing_requirements'
          ? 'Your email is verified but the account needs one more detail. Please contact support — this is a configuration problem on our side.'
          : 'That code didn’t complete sign-up. Check it and try again.',
        res.status === 'missing_requirements' ? 'missing_requirements' : 'signup_incomplete',
      );
    }
    await opts.setActive({ session: res.createdSessionId });
    await bootstrapAccount(opts.bootstrap ?? {});
    return { created: true };
  }

  if (!opts.signIn) throw new PasswordlessError('Sign-in is still loading. Try again in a moment.', 'signin_unavailable');
  const res = await opts.signIn.attemptFirstFactor({ strategy: 'email_code', code });
  if (res.status !== 'complete' || !res.createdSessionId) {
    throw new PasswordlessError('That code didn’t complete sign-in. Check it and try again.', 'signin_incomplete');
  }
  await opts.setActive({ session: res.createdSessionId });
  return { created: false };
}

/**
 * Hand off to Google. Returns only if the redirect could not be started.
 *
 * `oauth_google` is the one social provider enabled on the instance (verified
 * against /v1/environment). `/sso-callback` is the page that completes it — see
 * pages/sso-callback.astro; without that page Clerk lands the user on a route
 * that cannot finish the handshake and the sign-in silently evaporates.
 */
export async function continueWithGoogle(
  signIn: PwlSignIn | null | undefined,
  next: string,
): Promise<void> {
  if (!signIn) throw new PasswordlessError('Sign-in is still loading. Try again in a moment.', 'signin_unavailable');
  capture('auth_signin_start', { method: 'oauth_google' });
  await signIn.authenticateWithRedirect({
    strategy: 'oauth_google',
    redirectUrl: `/sso-callback?next=${encodeURIComponent(next)}`,
    redirectUrlComplete: next,
  });
}
