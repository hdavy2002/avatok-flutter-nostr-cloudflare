import { UiMessage } from "../../lib/i18n/react";
import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* /sign-up — Saa Thum create account.
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Custom Clerk flow via `useSignUp()`.
 *
 * TWO THINGS THE DESIGN DOES NOT COVER, both verified against the live Clerk
 * instance (public environment endpoint) and both hard blockers:
 *
 * 1. EMAIL VERIFICATION IS MANDATORY. ([WEB-PHONE-OTP-1] It is now an inline
 *    slide-out box on the same screen, not a second step — see below.) `email_address.verify_at_sign_up` is true
 *    and the strategy is `email_code`. `signUp.create()` therefore returns
 *    status 'missing_requirements', NOT 'complete', and the account does not
 *    exist until a 6-digit code is confirmed. The handoff has no such screen, so
 *    the second step below is an addition — without it sign-up cannot finish at
 *    all. It reuses the same tokens so it reads as part of the set.
 *
 * 2. BOT PROTECTION IS ON (`captcha_enabled`, smart widget). A custom flow must
 *    provide a mount point with id="clerk-captcha" or Clerk falls back to an
 *    invisible challenge and can reject the attempt. The empty <div> on the
 *    details screen is that mount point — it is not dead markup, do not remove
 *    it (it only needs to exist for the one screen that calls `signUp.create`).
 *
 * NAME: one "Your name" field, split on the first space into first/last for
 * Clerk (which requires both non-empty on this instance) — see `splitName`.
 * A single word is reused as both, rather than sending an empty required field.
 *
 * [WEB-PWLESS-1 2026-09-06] NO PASSWORD. `password` is disabled instance-wide
 * (owner decision 2026-09-06) — a password box here would fail at Clerk rather
 * than in the browser, which reads as a broken site. Verification by emailed
 * code IS the credential now, so the code step below is the whole of
 * authentication rather than a confirmation on top of one.
 *
 * ROLE: [SIGNUP-EMAIL-STEPS-1 2026-09-28, owner decision] Every web sign-up is
 * a customer — creators sign up in the app. The role picker is gone from this
 * screen; `role` stays 'friend' (AuthKit's id for "Customer") unless resume
 * mode finds an existing creator account, in which case it is left alone.
 * Stored as `unsafeMetadata.role`. "unsafe" is Clerk's name for
 * client-writable metadata, not a security warning about the value — it is the
 * only metadata a browser may set during sign-up. It is readable everywhere
 * immediately (app included) via the session claims. If the role ever gates
 * money or permissions, promote it to publicMetadata from the Worker, because a
 * determined client can set unsafeMetadata to anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth, useSignIn, useSignUp, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { capture, captureException, withTrace } from '../../lib/analytics';
import {
  Field, Button, CheckRow, Divider, GoogleButton,
  validateEmail, validateRequired, clerkError,
  useClerkStalled, STALLED_MESSAGE,
  type FieldErrors, type Role,
} from './AuthKit';
import {
  bootstrapAccount, continueWithGoogle, pwlError, finishUrl, clerkErrors,
  sendPhoneCode, verifyPhoneCode, getPhoneStatus, apiMessage, apiCode,
  type PwlSignIn,
} from './passwordless';
import {
  sendWhatsAppCode, verifyWhatsAppCode, redeemWhatsAppTicket, waApiMessage,
  storeWaProof, readWaProof, claimWhatsAppProof, confirmAge18,
} from './whatsappAuth';
import { WhatsAppNumberInput } from './WhatsAppNumberInput';
import { DEFAULT_COUNTRY, toE164 } from '../../lib/countries';
import { getActiveTokenWaited } from '../../lib/clerk';
import { DEFAULT_LANDING, safeSameOriginPath } from '../../lib/authRedirect';

/* [SIGNUP-EMAIL-STEPS-1 2026-09-28, owner decision "Short steps"] The email
 * path is now four short screens, one thing per screen, same feel as the
 * WhatsApp path in this same file:
 *   1. details      — name, email, the 18+/terms box, "Email me a code".
 *   2. email_code    — the 6-digit email code, "Verify and continue".
 *   3. whatsapp      — the WhatsApp number, "Send code on WhatsApp".
 *   4. whatsapp_code — the 6-digit WhatsApp code, "Verify and finish".
 * Screens 3-4 are skipped when a WhatsApp proof is already pending (someone
 * who tried "Continue with WhatsApp" first and got bounced to email because
 * the number was new) — verifyEmail claims that proof and finishes straight
 * away. FINISH MODE (?finish=1, reached after an email/Google login whose
 * account has no verified WhatsApp) is just screens 3-4, reworded.
 * The old long form (role picker, both fields verified inline on one scrolling
 * page) is gone; `sendPhone`/`verifyPhone` below are unchanged — only the
 * screens around them are new.
 */

type Step = 'idle' | 'sending' | 'code' | 'verifying' | 'verified';

/** [DASH2-FOUNDATION 2026-09-25, owner decision] Everyone lands on /dashboard
 * (Book events). Customers used to go to /marketplace; `role` is kept in the
 * signature so the Google hand-off still carries it through finishUrl. */
function landingFor(_role: Role): string {
  return DEFAULT_LANDING;
}

function readParams(): { finish: boolean; next: string | null; role: Role | null; country: string | null } {
  try {
    const q = new URLSearchParams(location.search);
    const n = q.get('next');
    const r = q.get('role');
    return {
      finish: q.get('finish') === '1',
      // [DASH2-FOUNDATION] redirect_url (preferred) or next; same-origin only.
      next: safeSameOriginPath(q.get('redirect_url')) ?? safeSameOriginPath(n),
      role: r === 'creator' || r === 'friend' ? r : null,
      country: (q.get('country') || '').toUpperCase() || null,
    };
  } catch {
    return { finish: false, next: null, role: null, country: null };
  }
}

/** Seconds left until `at`, ticking once a second while positive. */
function useCountdown(at: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** Split "Your name" on the first space. A single word is reused for both —
 * Clerk requires first AND last name non-empty on this instance, so an empty
 * required field is worse than a repeated one. */
function splitName(full: string): { first: string; last: string } {
  const trimmed = full.replace(/\s+/g, ' ').trim();
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { first: trimmed, last: trimmed };
  const first = trimmed.slice(0, idx);
  const last = trimmed.slice(idx + 1).trim() || first;
  return { first, last };
}

function Inner() {
  const {t:uiT}=useUiTranslation("web-auth");

  const { isLoaded, signUp, setActive } = useSignUp();
  // Google lives on the sign-in resource even when the person has no account —
  // Clerk creates one from the OAuth identity on the way through.
  const { signIn } = useSignIn();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const params = useMemo(readParams, []);

  const [boot, setBoot] = useState<'checking' | 'form' | 'leaving'>('checking');
  const [resume, setResume] = useState(false);

  // [SIGNUP-EMAIL-STEPS-1] No role picker on the web any more — every sign-up
  // here is a customer ('friend' is AuthKit's id for that). Resume mode may
  // still correct this from an existing creator account (see the prefill
  // effect below); `role` only otherwise affects the Google hand-off URL.
  const [role, setRole] = useState<Role>('friend');
  const [name, setName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);

  // Email verification (Clerk).
  const [emailStep, setEmailStep] = useState<Step>('idle');
  const [emailCode, setEmailCode] = useState('');
  const [emailResendAt, setEmailResendAt] = useState(0);

  // Phone verification (Worker -> 2Factor). Any country; +91 is the default.
  const [phone, setPhone] = useState('');
  const [phoneStep, setPhoneStep] = useState<Step>('idle');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneResendAt, setPhoneResendAt] = useState(0);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stalled = useClerkStalled(isLoaded);
  const startRef = useRef<number>(Date.now());
  const decided = useRef(false);

  // [WA-WEB-1 2026-09-28] Method choice for a fresh sign-up (not shown in
  // finish/resume mode — that screen exists only to collect the WhatsApp
  // number of an account that already exists).
  // [CHECKOUT-LOGIN-CHOICE-1 2026-09-28, owner] WhatsApp first and default.
  const [method, setMethod] = useState<'email' | 'whatsapp'>(() => (readWaProof() ? 'email' : 'whatsapp'));
  const [waStage, setWaStage] = useState<'number' | 'code' | 'age'>('number');
  // [HF-AUTH-WA-1] A brand-new phone-only account holds its ticket here until the 18+ tick is given.
  const [waTicket, setWaTicket] = useState<string | null>(null);
  const [waAgree, setWaAgree] = useState(false);
  const [waCountry, setWaCountry] = useState(DEFAULT_COUNTRY.code);
  const [waNational, setWaNational] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waResendAt, setWaResendAt] = useState(0);
  const [waPhoneMasked, setWaPhoneMasked] = useState('');

  const emailResendIn = useCountdown(emailResendAt);
  const phoneResendIn = useCountdown(phoneResendAt);

  const destination = () => {
    // [DASH2-FOUNDATION 2026-09-25] No more IN-country detour to /india: the
    // owner rule is "login always lands on /dashboard unless sent from a page".
    if (params.next) return params.next;
    return landingFor(role);
  };

  function clearErr(...keys: string[]) {
    setErrors((e) => {
      if (!keys.some((k) => e[k])) return e;
      const n = { ...e };
      for (const k of keys) n[k] = undefined;
      return n;
    });
  }

  /* ── First load: already signed in? Decide ONCE — the session this page
   *    itself creates on email verification must not re-trigger it. ──────── */
  useEffect(() => {
    if (!authLoaded || decided.current) return;
    decided.current = true;
    if (!isSignedIn) { setBoot('form'); return; }
    void (async () => {
      let st: Awaited<ReturnType<typeof getPhoneStatus>> | null = null;
      try { st = await getPhoneStatus(); } catch { st = null; }
      capture('auth_phone_gate', {
        outcome: st == null ? 'status_failed' : st.needs_phone ? 'resume' : 'pass',
        finish: params.finish, has_account: st?.has_account, verified: st?.verified,
      });
      // A failed status read lets the person in rather than trapping a signed-in
      // user on a form; bootstrap still refuses an unverified phone server-side.
      // [WA-CLAIM-RACE-1] A WhatsApp number verified moments ago (needs_email
      // hand-off) whose claim didn't land: claim it here instead of asking again.
      if (st && st.needs_phone) {
        const pending = readWaProof();
        if (pending) {
          try {
            const token = await getActiveTokenWaited();
            if (token) {
              await claimWhatsAppProof(pending.proof, token);
              capture('auth_phone_gate', { outcome: 'claimed_pending_proof' });
              setBoot('leaving');
              location.href = destination();
              return;
            }
          } catch (e) {
            captureException(e, { where: 'signup_finish_claim' });
          }
        }
      }
      if (!st || !st.needs_phone) {
        setBoot('leaving');
        location.href = destination();
        return;
      }
      setResume(true);
      setEmailStep('verified');
      if (st.verified && st.phone) {
        setVerifiedPhone(st.phone);
        setPhone(st.phone.replace(/^\+91/, ''));
        setPhoneStep('verified');
      }
      setBoot('form');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn]);

  // Resume mode: prefill from the Clerk user (Google gives us name + email).
  useEffect(() => {
    if (!resume || !user) return;
    setEmail((v) => v || user.primaryEmailAddress?.emailAddress || '');
    setFirstName((v) => v || user.firstName || '');
    setLastName((v) => v || user.lastName || '');
    const r = (user.unsafeMetadata as { role?: unknown } | undefined)?.role;
    if (r === 'creator' || r === 'friend') setRole(r);
  }, [resume, user]);

  /** Hand off to Google. Comes back through the phone gate on this page. */
  async function google() {
    if (!isLoaded || submitting) return;
    setFormError(null);
    try {
      capture('login_method_chosen', { method: 'google', surface: 'sign_up' });
      await continueWithGoogle(signIn as unknown as PwlSignIn, finishUrl(params.next ?? landingFor(role), role));
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  /* ── WhatsApp sign-up (owner decision 2026-09-28) ────────────────────── */
  function chooseMethod(m: 'email' | 'whatsapp') {
    setMethod(m);
    setFormError(null);
    capture('login_method_chosen', { method: m, surface: 'sign_up' });
  }
  const waE164 = () => toE164(waCountry, waNational);
  const waResendIn = Math.max(0, Math.ceil((waResendAt - Date.now()) / 1000));

  async function sendWa() {
    if (submitting || waNational.replace(/\D/g, '').length < 4) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const r = await sendWhatsAppCode(waE164());
      setWaPhoneMasked(r.phone_masked);
      setWaCode('');
      setWaStage('code');
      setWaResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
    } catch (err) {
      setFormError(waApiMessage(err, 'We couldn’t send the code on WhatsApp. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyWa() {
    if (submitting || waCode.trim().length < 4) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const r = await verifyWhatsAppCode(waE164(), waCode.trim());
      if (r.status === 'signed_in' && r.needs18Plus) {
        // [HF-AUTH-WA-1] New phone-only account: ask for the 18+ tick before opening the session.
        setWaTicket(r.ticket);
        setWaStage('age');
        return;
      }
      if (r.status === 'signed_in') {
        await redeemWhatsAppTicket(signIn as unknown as PwlSignIn, setActive as unknown as (p: { session: string }) => Promise<unknown>, r.ticket);
        location.href = destination();
        return;
      }
      // needs_email: a brand-new number. Keep the proof for after the email
      // step (verifyEmail claims it), and switch to the ordinary sign-up form.
      storeWaProof(r.proof, r.phone_masked);
      setWaPhoneMasked(r.phone_masked);
      setMethod('email');
    } catch (err) {
      setFormError(waApiMessage(err, 'That code didn’t work. Check it and try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  /** [HF-AUTH-WA-1] The 18+ tick for a phone-only account: open the session, record the tick, go. */
  async function confirmWaAge() {
    if (submitting || !waTicket) return;
    if (!waAgree) { setFormError('Please confirm that you are 18 or over to continue.'); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      await redeemWhatsAppTicket(signIn as unknown as PwlSignIn, setActive as unknown as (p: { session: string }) => Promise<unknown>, waTicket);
      const token = await getActiveTokenWaited();
      if (!token) throw new Error('no_token');
      await confirmAge18(token);
      location.href = destination();
    } catch (err) {
      setFormError(waApiMessage(err, 'We couldn’t finish that. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Open the account — the finishing move for every path (fresh email +
   *    phone, a claimed WhatsApp proof, or finish/resume mode). Terms are
   *    already accepted on the details screen, so a verified phone is the
   *    only remaining gate; nothing else asks the person to press "submit"
   *    a second time. ───────────────────────────────────────────────────── */
  async function finishAccount(phoneForBootstrap: string) {
    setSubmitting(true);
    setFormError(null);
    // Names or role may have been edited after the email code was sent (or come
    // from Google in finish mode) — best effort, never blocks opening the account.
    try {
      if (user) {
        await user.update({
          firstName: firstName.trim() || user.firstName || '',
          lastName: lastName.trim() || user.lastName || '',
          unsafeMetadata: { ...(user.unsafeMetadata ?? {}), role, country: params.country ?? (user.unsafeMetadata as { country?: string } | undefined)?.country ?? 'GLOBAL' },
        });
      }
    } catch { /* cosmetic */ }

    try {
      const res = await bootstrapAccount({
        phone: phoneForBootstrap,
        display_name: `${firstName.trim()} ${lastName.trim()}`.trim(),
      });
      capture('auth_signup_result', {
        outcome: res.ok ? 'ok' : 'error', stage: 'bootstrap', reason: res.message,
        finish: resume, email: (user?.primaryEmailAddress?.emailAddress ?? email).toLowerCase(),
        ms: Date.now() - startRef.current,
      });
      if (!res.ok) {
        setFormError(res.message ?? 'We couldn’t open your account just now. Please try again.');
        setSubmitting(false);
        return;
      }
      capture('signup_step', { method: 'email', step: 'done' });
      location.href = destination();
    } catch (err) {
      captureException(err, { where: 'signup_finish' });
      setFormError('We couldn’t open your account just now. Please try again.');
      setSubmitting(false);
    }
  }

  /* ── Email ─────────────────────────────────────────────────────────────── */
  async function sendEmail() {
    if (!isLoaded || !signUp || emailStep === 'sending' || emailStep === 'verifying') return;
    const { first, last } = splitName(name);
    const next: FieldErrors = {
      name: validateRequired(name, 'Your name'),
      email: validateEmail(email),
      terms: agreed ? undefined : 'Please accept the terms to continue.',
    };
    setErrors((e) => ({ ...e, ...next, emailCode: undefined }));
    if (Object.values(next).some(Boolean)) return;

    setFirstName(first);
    setLastName(last);
    setFormError(null);
    setEmailStep('sending');
    try {
      await withTrace(async () => {
        await signUp.create({
          emailAddress: email.trim(),
          firstName: first,
          lastName: last,
          unsafeMetadata: { role, country: params.country ?? 'GLOBAL', signedUpVia: 'web' },
        });
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      });
      setEmailCode('');
      setEmailStep('code');
      setEmailResendAt(Date.now() + 30_000);
      capture('auth_code_sent', { surface: 'sign_up', channel: 'email' });
    } catch (err) {
      setEmailStep('idle');
      const exists = clerkErrors(err).some((x) => x.code === 'form_identifier_exists');
      setErrors((e) => ({
        ...e,
        email: exists ? 'This email already has an account — log in instead.' : clerkError(err),
      }));
      capture('auth_signup_result', { outcome: 'error', stage: 'email_send', reason: clerkError(err) });
    }
  }

  async function resendEmail() {
    if (!signUp) return;
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setEmailResendAt(Date.now() + 30_000);
      clearErr('emailCode');
    } catch (err) {
      setErrors((e) => ({ ...e, emailCode: clerkError(err) }));
    }
  }

  async function verifyEmail(code: string) {
    if (!signUp || emailStep !== 'code') return;
    setEmailStep('verifying');
    clearErr('emailCode');
    try {
      const res = await withTrace(() => signUp.attemptEmailAddressVerification({ code }));
      if (res.status === 'complete' && res.createdSessionId) {
        await setActive({ session: res.createdSessionId });
        setEmailStep('verified');
        capture('auth_email_verified', { surface: 'sign_up', email: email.trim().toLowerCase() });
        // [WA-WEB-1 2026-09-28] "Continue with WhatsApp" -> needs_email left a
        // proof waiting: attach it now and skip screens 3-4 entirely — the
        // person is never asked for a second WhatsApp code.
        const pending = readWaProof();
        if (pending) {
          try {
            const token = await getActiveTokenWaited();
            if (token) {
              const claimed = await claimWhatsAppProof(pending.proof, token);
              setVerifiedPhone(claimed.phone);
              setPhoneStep('verified');
              await finishAccount(claimed.phone);
              return;
            }
          } catch (err) {
            captureException(err, { where: 'signup_wa_proof_claim' });
            /* falls through to the ordinary WhatsApp screen below */
          }
        }
        return;
      }
      setEmailStep('code');
      setErrors((e) => ({ ...e, emailCode: 'That didn’t complete. Check the code and try again.' }));
    } catch (err) {
      setEmailStep('code');
      setEmailCode('');
      setErrors((e) => ({ ...e, emailCode: clerkError(err) }));
    }
  }

  /* ── Phone (screens 3-4, and finish/resume mode) ─────────────────────────
   * Shared by a fresh sign-up (once email is verified) and finish/resume mode
   * (which lands here directly — its session already exists). Unchanged from
   * the long form except that verifying now finishes the account itself. ── */
  const [phoneCountry, setPhoneCountry] = useState(DEFAULT_COUNTRY.code);
  function onPhoneChange(v: string, c: string) {
    setPhone(v);
    setPhoneCountry(c);
    clearErr('phone', 'phoneCode');
    // Editing the number after a code was sent (or after verifying) starts over.
    if (phoneStep === 'code' || phoneStep === 'verified') {
      setPhoneStep('idle');
      setPhoneCode('');
      setVerifiedPhone(null);
    }
  }

  async function sendPhone() {
    if (phoneStep === 'sending' || phoneStep === 'verifying') return;
    if (emailStep !== 'verified') {
      setErrors((e) => ({ ...e, phone: 'Verify your email first.' }));
      return;
    }
    if (phone.replace(/\D/g, '').length < 4) {
      setErrors((e) => ({ ...e, phone: 'Enter your WhatsApp number.' }));
      return;
    }
    clearErr('phone', 'phoneCode');
    const prevStep = phoneStep;
    setPhoneStep('sending');
    try {
      const r = await sendPhoneCode(toE164(phoneCountry, phone));
      if (r.already_verified) {
        setVerifiedPhone(r.phone);
        setPhoneStep('verified');
        await finishAccount(r.phone);
        return;
      }
      setPhoneCode('');
      setPhoneStep('code');
      setPhoneResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      capture('auth_code_sent', { surface: 'sign_up', channel: 'whatsapp' });
    } catch (err) {
      // A resend that fails keeps the open code box; a first send that fails closes it.
      // too_soon means a code already went out moments ago, so show the box for it.
      setPhoneStep(prevStep === 'code' || apiCode(err) === 'too_soon' ? 'code' : 'idle');
      setErrors((e) => ({ ...e, phone: apiMessage(err, 'We couldn’t send the code on WhatsApp. Please try again.') }));
      capture('auth_signup_result', { outcome: 'error', stage: 'phone_send', reason: apiCode(err) || 'unknown' });
    }
  }

  async function verifyPhone(code: string) {
    if (phoneStep !== 'code') return;
    setPhoneStep('verifying');
    clearErr('phoneCode');
    try {
      const r = await verifyPhoneCode(code);
      setVerifiedPhone(r.phone);
      setPhoneStep('verified');
      clearErr('phone', 'phoneCode');
      capture('auth_phone_verified', { surface: resume ? 'sign_up_finish' : 'sign_up' });
      await finishAccount(r.phone);
    } catch (err) {
      const c = apiCode(err);
      setPhoneStep('code');
      setPhoneCode('');
      if (c === 'phone_taken') {
        setPhoneStep('idle');
        setErrors((e) => ({ ...e, phone: apiMessage(err, 'This number is already in use.') }));
      } else {
        if (c === 'code_expired' || c === 'too_many_attempts') setPhoneResendAt(0);
        setErrors((e) => ({ ...e, phoneCode: apiMessage(err, 'That code didn’t work. Please try again.') }));
      }
    }
  }

  /* [SIGNUP-EMAIL-STEPS-1] Fires once per screen actually shown to a person on
   * the email path (the WhatsApp-first tab has its own events already). */
  const emailScreen: 'details' | 'email_code' | 'whatsapp' | 'whatsapp_code' | null = (() => {
    if (!resume && method !== 'email') return null;
    if (!resume) {
      if (emailStep === 'idle' || emailStep === 'sending') return 'details';
      if (emailStep === 'code' || emailStep === 'verifying') return 'email_code';
    }
    if (phoneStep === 'code' || phoneStep === 'verifying') return 'whatsapp_code';
    if (phoneStep === 'verified') return null; // finishing or done
    return 'whatsapp';
  })();
  useEffect(() => {
    if (!emailScreen) return;
    capture('signup_step', { method: 'email', step: emailScreen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailScreen]);

  if (boot === 'checking' || boot === 'leaving') {
    return <p className="auth-footline">{boot === 'leaving' ? uiT("web-auth.02d310528cc61f61","You’re signed in — taking you through…") : uiT("web-auth.4152c1296fa27021","One sec…")}</p>;
  }

  /* ── Screens 3-4: WhatsApp number, then its code. Shared by the email path
   *    (once the email is verified) and finish/resume mode. ──────────────── */
  function phoneScreens(eyebrow: string, heading: string): ReactNode {
    if (phoneStep === 'verified') {
      // Bootstrap is in flight, or failed and can be retried — there is
      // nothing else to fill in, terms were accepted on the details screen.
      return (
        <div className="auth-form auth-form--signup">
          <div className="auth-desktop-head">
            <p className="auth-eyebrow">{eyebrow}</p>
            <h1 className="auth-h2">{heading}</h1>
          </div>
          {formError && <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError} /></p>}
          <Button loading={submitting} onClick={() => void finishAccount(verifiedPhone ?? toE164(phoneCountry, phone))}>
            Try again
          </Button>
        </div>
      );
    }
    if (phoneStep === 'code' || phoneStep === 'verifying') {
      return (
        <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void verifyPhone(phoneCode); }} noValidate>
          <div className="auth-desktop-head">
            <p className="auth-eyebrow">{eyebrow}</p>
            <h1 className="auth-h2">{heading}</h1>
          </div>
          {(formError || stalled) && (
            <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
          )}
          <p className="auth-footline" style={{ textAlign: 'left' }}>We sent a 6-digit code on WhatsApp to <strong>{toE164(phoneCountry, phone)}</strong>.</p>
          <Field
            label="Verification code" name="phoneCode" inputMode="numeric" maxLength={6}
            autoComplete="one-time-code" placeholder="123456"
            value={phoneCode} onChange={(v) => { setPhoneCode(v); clearErr('phoneCode'); }} error={errors.phoneCode}
          />
          <Button type="submit" loading={phoneStep === 'verifying' || submitting}>Verify and finish</Button>
          <div className="auth-foot">
            <p className="auth-footline">
              {phoneResendIn > 0 ? `Resend in ${phoneResendIn}s` : (
                <a href="#resend" onClick={(ev) => { ev.preventDefault(); void sendPhone(); }}>Resend code</a>
              )}
            </p>
          </div>
        </form>
      );
    }
    return (
      <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void sendPhone(); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">{eyebrow}</p>
          <h1 className="auth-h2">{heading}</h1>
        </div>
        {(formError || stalled) && (
          <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
        )}
        <WhatsAppNumberInput
          value={phone} countryCode={phoneCountry}
          onChange={onPhoneChange}
          label="WhatsApp number" autoFocus
        />
        {errors.phone && <p className="auth-err" role="alert"><UiMessage namespace="web-auth" value={errors.phone} /></p>}
        <p className="auth-hint">We’ll send a code on WhatsApp to verify your number.</p>
        <Button type="submit" loading={phoneStep === 'sending'} disabled={phone.replace(/\D/g, '').length < 4}>
          Send code on WhatsApp
        </Button>
      </form>
    );
  }

  // [SIGNUP-EMAIL-STEPS-1] Finish/resume mode is JUST the WhatsApp screens,
  // reworded — no name, email or role fields, that account already exists.
  if (resume) {
    return <>{phoneScreens(uiT("web-auth.be98b10d2db32b3f","One last step"), "Verify your WhatsApp")}</>;
  }

  // [WA-WEB-1 2026-09-28] The WhatsApp-first sign-up path — only offered on a
  // fresh sign-up, never in finish/resume mode.
  if (method === 'whatsapp') {
    return (
      <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void (waStage === 'number' ? sendWa() : waStage === 'age' ? confirmWaAge() : verifyWa()); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">{uiT("web-auth.6b6ad3ba72651b98","Two minutes, that’s all")}</p>
          <h1 className="auth-h2">Create my account</h1>
        </div>
        <div className="auth-row" role="tablist" aria-label="Sign-up method" style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <button type="button" role="tab" aria-selected className="auth-btn auth-btn--ink" onClick={() => chooseMethod('whatsapp')}>Continue with WhatsApp</button>
          <button type="button" role="tab" aria-selected={false} className="auth-btn auth-btn--ghost" onClick={() => chooseMethod('email')}>Continue with email</button>
        </div>
        {(formError || stalled) && (
          <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
        )}
        {waStage === 'number' && (
          <>
            <WhatsAppNumberInput
              value={waNational} countryCode={waCountry}
              onChange={(n, c) => { setWaNational(n); setWaCountry(c); }}
              label="WhatsApp number" autoFocus
            />
            <p className="auth-hint">We’ll send a 6-digit code on WhatsApp to create your account.</p>
            <Button type="submit" loading={submitting}>Send code on WhatsApp</Button>
          </>
        )}
        {waStage === 'age' && (
          <>
            <CheckRow className="auth-terms" large checked={waAgree} onChange={setWaAgree}>
              I’m 18 or over and I agree to the <a href="/terms">terms</a> and <a href="/community-guidelines">safety rules</a>.
            </CheckRow>
            <Button type="submit" loading={submitting}>Continue</Button>
          </>
        )}
        {waStage === 'code' && (
          <>
            <p className="auth-footline" style={{ textAlign: 'left' }}>We sent a 6-digit code on WhatsApp to <strong>{waPhoneMasked}</strong>.</p>
            <Field label="Verification code" name="waCode" inputMode="numeric" maxLength={6}
              autoComplete="one-time-code" placeholder="123456" value={waCode} onChange={setWaCode} />
            <Button type="submit" loading={submitting}>Verify and continue</Button>
            <div className="auth-foot">
              <p className="auth-footline">
                {waResendIn > 0 ? `Resend in ${waResendIn}s` : (
                  <a href="#resend" onClick={(ev) => { ev.preventDefault(); void sendWa(); }}>Resend code</a>
                )}
              </p>
            </div>
          </>
        )}
        <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
        <GoogleButton onClick={() => void google()} disabled={stalled || submitting} />
        <div className="auth-foot">
          <p className="auth-footline"><UiText id="web-auth.7016769c24191247" source="Already with us?" /><a href="/sign-in"><UiText id="web-auth.c189840cf7e2d6f6" source="Log in" /></a>
          </p>
        </div>
      </form>
    );
  }

  // [SIGNUP-EMAIL-STEPS-1] method === 'email': screen 1, "details" — name,
  // email, terms, one button. Nothing else — the long form's role picker and
  // inline-verify fields are gone.
  if (emailStep === 'idle' || emailStep === 'sending') {
    return (
      <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void sendEmail(); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">{uiT("web-auth.6b6ad3ba72651b98","Two minutes, that’s all")}</p>
          <h1 className="auth-h2">{uiT("web-auth.862d3b2696cfbc19","Create my account")}</h1>
        </div>
        <div className="auth-row" role="tablist" aria-label="Sign-up method" style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <button type="button" role="tab" aria-selected={false} className="auth-btn auth-btn--ghost" onClick={() => chooseMethod('whatsapp')}>Continue with WhatsApp</button>
          <button type="button" role="tab" aria-selected className="auth-btn auth-btn--ink" onClick={() => chooseMethod('email')}>Continue with email</button>
        </div>
        {(formError || stalled) && (
          <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
        )}
        <Field
          label="Your name" name="name" autoComplete="name"
          placeholder={uiT("web-auth.d82e5fe24eed3db4","What should we call you?")}
          value={name} onChange={(v) => { setName(v); clearErr('name'); }} error={errors.name}
        />
        <Field
          label={uiT("web-auth.969ccbd3cf6300ec","Email")} name="email" type="email" inputMode="email" autoComplete="email"
          placeholder={uiT("web-auth.8d12b7f58c0d3fc8","you@email.com")}
          value={email} onChange={(v) => { setEmail(v); clearErr('email'); }} error={errors.email}
        />

        {/* Clerk smart-CAPTCHA mount point — required for custom sign-up flows.
            Only this screen calls signUp.create, so only this screen needs it. */}
        <div id="clerk-captcha" />

        <CheckRow
          className="auth-terms" large checked={agreed}
          onChange={(v) => { setAgreed(v); clearErr('terms'); }}
          error={errors.terms}
        ><UiText id="web-auth.4dca6ceb76d0fbcf" source="I’m 18 or over and I agree to the" />{" "}<a href="/terms"><UiText id="web-auth.51d2361f4faea3bc" source="terms" /></a>{" "}<UiText id="web-auth.6201111b83a0cb5b" source="and" />{' '}
          <a href="/community-guidelines"><UiText id="web-auth.1ce806cb5268307a" source="safety rules" /></a>.
        </CheckRow>

        <Button type="submit" loading={emailStep === 'sending' || (!isLoaded && !stalled)} disabled={stalled}>
          Email me a code
        </Button>

        <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
        <GoogleButton onClick={() => void google()} disabled={stalled || submitting} />
        <div className="auth-foot">
          <p className="auth-footline"><UiText id="web-auth.7016769c24191247" source="Already with us?" /><a href="/sign-in"><UiText id="web-auth.c189840cf7e2d6f6" source="Log in" /></a>
          </p>
        </div>
      </form>
    );
  }

  // Screen 2, "email_code" — the 6-digit email code, mirroring the WhatsApp
  // code screen: one field, one button, a countdown resend link.
  if (emailStep === 'code' || emailStep === 'verifying') {
    return (
      <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void verifyEmail(emailCode); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">{uiT("web-auth.6b6ad3ba72651b98","Two minutes, that’s all")}</p>
          <h1 className="auth-h2">{uiT("web-auth.862d3b2696cfbc19","Create my account")}</h1>
        </div>
        {(formError || stalled) && (
          <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
        )}
        <p className="auth-footline" style={{ textAlign: 'left' }}>We sent a 6-digit code to <strong>{email.trim()}</strong>.</p>
        <Field
          label={uiT("web-auth.3ee75029c70e284c","Verification code")} name="emailCode" inputMode="numeric" maxLength={6}
          autoComplete="one-time-code" placeholder="123456"
          value={emailCode} onChange={(v) => { setEmailCode(v); clearErr('emailCode'); }} error={errors.emailCode}
        />
        <Button type="submit" loading={emailStep === 'verifying'}>Verify and continue</Button>
        <div className="auth-foot">
          <p className="auth-footline">
            {emailResendIn > 0 ? `Resend in ${emailResendIn}s` : (
              <a href="#resend" onClick={(ev) => { ev.preventDefault(); void resendEmail(); }}>Resend code</a>
            )}
          </p>
        </div>
      </form>
    );
  }

  // Screens 3-4: email is verified, the account exists — only the WhatsApp
  // number (and its code) stand between here and the dashboard.
  return <>{phoneScreens(uiT("web-auth.6b6ad3ba72651b98","Two minutes, that’s all"), uiT("web-auth.862d3b2696cfbc19","Create my account"))}</>;
}

export function SignUpIsland() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="auth-form">
        <p className="auth-formerr"><UiText id="web-auth.84f1a2e898fba3ac" source="Sign-up isn’t configured on this build. Set PUBLIC_CLERK_PUBLISHABLE_KEY." />{" "}</p>
      </div>
    );
  }
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default SignUpIsland;
