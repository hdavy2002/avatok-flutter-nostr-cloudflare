/* /sign-up — avaTOK create account.
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
 *    invisible challenge and can reject the attempt. The empty <div> near the
 *    submit button is that mount point — it is not dead markup, do not remove it.
 *
 * NAME: two real fields rather than guessing a surname from one string.
 * [WEB-PWLESS-1 2026-09-06] They are no longer REQUIRED by Clerk — first/last
 * name were `required=true` on the instance until then, which meant a sign-up
 * carrying only an email (checkout does exactly that) came back
 * `missing_requirements` and never minted a session. This form still asks for
 * them, because a marketplace needs a name to show; checkout does not, and now
 * doesn't have to.
 *
 * [WEB-PWLESS-1] NO PASSWORD. `password` is disabled instance-wide (owner
 * decision 2026-09-06) — a password box here would fail at Clerk rather than in
 * the browser, which reads as a broken site. Verification by emailed code IS the
 * credential now, so the code step below is the whole of authentication rather
 * than a confirmation on top of one.
 *
 * ROLE: stored as `unsafeMetadata.role`. "unsafe" is Clerk's name for
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
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { capture, withTrace } from '../../lib/analytics';
import {
  Field, Button, CheckRow, Divider, GoogleButton, RolePicker,
  validateEmail, validateRequired, clerkError,
  useClerkStalled, STALLED_MESSAGE,
  type FieldErrors, type Role,
} from './AuthKit';
import {
  bootstrapAccount, continueWithGoogle, pwlError, finishUrl, clerkErrors,
  sendPhoneCode, verifyPhoneCode, getPhoneStatus, apiMessage, apiCode,
  type PwlSignIn,
} from './passwordless';

/* [WEB-PHONE-OTP-1 2026-09-10] ONE SCREEN, TWO INLINE CODES (owner decision).
 * The separate "Check your email" step is gone. Now:
 *   1. Name + email, tap Verify -> the email code box slides out under the
 *      email field. Six digits auto-check. Confirming it creates the Clerk
 *      account and makes the session live (no users row yet).
 *   2. The phone row unlocks. +91 only (2Factor.in is Indian SMS). Send OTP ->
 *      a second box slides out, checked by the Worker (/api/account/phone/*),
 *      which writes contact_verification.
 *   3. Both fields turn green; Create my account runs /api/account/bootstrap,
 *      which now REFUSES a phone that has not been OTP-verified.
 * FINISH MODE (?finish=1): every web sign-in and every Google return lands here
 * first. A signed-in account that owes a phone (Worker phoneOtpStatus) resumes
 * at step 2 with its email already green; anyone else goes straight on to ?next.
 */

type Step = 'idle' | 'sending' | 'code' | 'verifying' | 'verified';

/** Creators go to the studio; friends go browsing. */
function landingFor(role: Role): string {
  return role === 'creator' ? '/dashboard' : '/marketplace';
}

function readParams(): { finish: boolean; next: string | null; role: Role | null } {
  try {
    const q = new URLSearchParams(location.search);
    const n = q.get('next');
    const r = q.get('role');
    return {
      finish: q.get('finish') === '1',
      next: n && n.startsWith('/') && !n.startsWith('//') ? n : null,
      role: r === 'creator' || r === 'friend' ? r : null,
    };
  } catch {
    return { finish: false, next: null, role: null };
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

/* ── The slide-out code box ─────────────────────────────────────────────── */
function CodeReveal({
  open, label, sentTo, value, onChange, onSubmit, error, busy, onResend, resendIn, codeLength,
}: {
  open: boolean;
  label: string;
  sentTo: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (code: string) => void;
  error?: string;
  busy: boolean;
  onResend: () => void;
  resendIn: number;
  codeLength: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errId = `${label.replace(/\W+/g, '-').toLowerCase()}-err`;
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 220);
  }, [open]);

  return (
    <div className={`auth-reveal${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <div className="auth-reveal-inner">
        <div className="auth-otp">
          <label className="auth-label" htmlFor={errId + '-input'}>{label}</label>
          <p className="auth-otp-sent">Sent to <strong>{sentTo}</strong></p>
          <input
            ref={inputRef}
            id={errId + '-input'}
            className="auth-box auth-box--otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={'•'.repeat(codeLength)}
            value={value}
            disabled={busy || !open}
            tabIndex={open ? 0 : -1}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
              onChange(digits);
              if (digits.length === codeLength) onSubmit(digits);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (value.length >= 4) onSubmit(value);
            }}
          />
          {error && <p className="auth-err" id={errId} role="alert">{error}</p>}
          <p className="auth-otp-foot">
            {busy ? 'Checking…' : resendIn > 0 ? `Resend in ${resendIn}s` : (
              <button type="button" className="auth-linkbtn" onClick={onResend} tabIndex={open ? 0 : -1}>
                Resend code
              </button>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── A field with an inline action / verified badge ─────────────────────── */
function VerifyField({
  id, label, children, verified, action, error, hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  verified: boolean;
  action?: ReactNode;
  error?: string;
  hint?: ReactNode;
}) {
  return (
    <div className={`auth-field${verified ? ' is-verified' : ''}`}>
      <label className="auth-label" htmlFor={id}>{label}</label>
      <div className="auth-boxwrap">
        {children}
        {verified
          ? <span className="auth-verified" aria-label="Verified">✓ Verified</span>
          : action}
      </div>
      {error && <p className="auth-err" id={`${id}-err`} role="alert">{error}</p>}
      {hint}
    </div>
  );
}

function Inner() {
  const { isLoaded, signUp, setActive } = useSignUp();
  // Google lives on the sign-in resource even when the person has no account —
  // Clerk creates one from the OAuth identity on the way through.
  const { signIn } = useSignIn();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const params = useMemo(readParams, []);

  const [boot, setBoot] = useState<'checking' | 'form' | 'leaving'>('checking');
  const [resume, setResume] = useState(false);

  const [role, setRole] = useState<Role>(params.role ?? 'friend'); // README: Friend preselected
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);

  // Email verification (Clerk).
  const [emailStep, setEmailStep] = useState<Step>('idle');
  const [emailCode, setEmailCode] = useState('');
  const [emailResendAt, setEmailResendAt] = useState(0);

  // Phone verification (Worker -> 2Factor). Ten digits; +91 is fixed.
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
  const phoneInputRef = useRef<HTMLInputElement | null>(null);
  const decided = useRef(false);

  const emailResendIn = useCountdown(emailResendAt);
  const phoneResendIn = useCountdown(phoneResendAt);

  const destination = () => params.next ?? landingFor(role);

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
    if (!params.role && (r === 'creator' || r === 'friend')) setRole(r);
  }, [resume, user, params.role]);

  /** Hand off to Google. Comes back through the phone gate on this page. */
  async function google() {
    if (!isLoaded || submitting) return;
    setFormError(null);
    try {
      await continueWithGoogle(signIn as unknown as PwlSignIn, finishUrl(landingFor(role), role));
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  /* ── Email ─────────────────────────────────────────────────────────────── */
  async function sendEmail() {
    if (!isLoaded || !signUp || emailStep === 'sending' || emailStep === 'verifying') return;
    const next: FieldErrors = {
      firstName: validateRequired(firstName, 'First name'),
      lastName: validateRequired(lastName, 'Last name'),
      email: validateEmail(email),
    };
    setErrors((e) => ({ ...e, ...next, emailCode: undefined }));
    if (Object.values(next).some(Boolean)) return;

    setFormError(null);
    setEmailStep('sending');
    try {
      await withTrace(async () => {
        await signUp.create({
          emailAddress: email.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          unsafeMetadata: { role, signedUpVia: 'web' },
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
        setTimeout(() => phoneInputRef.current?.focus(), 250);
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

  /* ── Phone ─────────────────────────────────────────────────────────────── */
  function onPhoneChange(v: string) {
    const digits = v.replace(/\D/g, '').replace(/^91(?=\d{10})/, '').slice(0, 10);
    setPhone(digits);
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
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setErrors((e) => ({ ...e, phone: 'Enter your 10-digit mobile number.' }));
      return;
    }
    clearErr('phone', 'phoneCode');
    const prevStep = phoneStep;
    setPhoneStep('sending');
    try {
      const r = await sendPhoneCode(`+91${phone}`);
      if (r.already_verified) {
        setVerifiedPhone(r.phone);
        setPhoneStep('verified');
        return;
      }
      setPhoneCode('');
      setPhoneStep('code');
      setPhoneResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      capture('auth_code_sent', { surface: 'sign_up', channel: 'sms' });
    } catch (err) {
      // A resend that fails keeps the open code box; a first send that fails closes it.
      // too_soon means a code already went out moments ago, so show the box for it.
      setPhoneStep(prevStep === 'code' || apiCode(err) === 'too_soon' ? 'code' : 'idle');
      setErrors((e) => ({ ...e, phone: apiMessage(err, 'We couldn’t send the SMS. Please try again.') }));
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

  /* ── Open the account ──────────────────────────────────────────────────── */
  const bothVerified = emailStep === 'verified' && phoneStep === 'verified' && !!verifiedPhone;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const next: FieldErrors = {
      firstName: validateRequired(firstName, 'First name'),
      lastName: validateRequired(lastName, 'Last name'),
      email: emailStep === 'verified' ? undefined : 'Verify your email to continue.',
      phone: phoneStep === 'verified' ? undefined : 'Verify your phone to continue.',
      // README: submit is blocked until the terms box is checked.
      terms: agreed ? undefined : 'Please accept the terms to continue.',
    };
    setErrors((cur) => ({ ...cur, ...next }));
    if (Object.values(next).some(Boolean) || !verifiedPhone) return;

    setSubmitting(true);
    setFormError(null);
    // Names or role may have been edited after the email code was sent (or come
    // from Google in finish mode) — best effort, never blocks opening the account.
    try {
      if (user) {
        await user.update({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          unsafeMetadata: { ...(user.unsafeMetadata ?? {}), role },
        });
      }
    } catch { /* cosmetic */ }

    const res = await bootstrapAccount({
      phone: verifiedPhone,
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
    location.href = destination();
  }

  if (boot === 'checking' || boot === 'leaving') {
    return <p className="auth-footline">{boot === 'leaving' ? 'You’re signed in — taking you through…' : 'One sec…'}</p>;
  }

  const emailLocked = emailStep !== 'idle';
  const emailBusy = emailStep === 'sending' || emailStep === 'verifying';
  const phoneBusy = phoneStep === 'sending' || phoneStep === 'verifying';
  const phoneUnlocked = emailStep === 'verified';

  return (
    <form className="auth-form auth-form--signup" onSubmit={onSubmit} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow">{resume ? 'One last step' : 'Two minutes, that’s all'}</p>
        <h1 className="auth-h2">{resume ? 'Verify your phone' : 'Create my account'}</h1>
      </div>

      {(formError || stalled) && (
        <p className="auth-formerr" role="alert">{formError ?? STALLED_MESSAGE}</p>
      )}

      <RolePicker value={role} onChange={setRole} />

      <div className="auth-namepair">
        <Field
          label="First name" name="firstName" autoComplete="given-name"
          placeholder="What should we call you?"
          value={firstName} onChange={(v) => { setFirstName(v); clearErr('firstName'); }} error={errors.firstName}
        />
        <Field
          label="Last name" name="lastName" autoComplete="family-name"
          placeholder="Your surname"
          value={lastName} onChange={(v) => { setLastName(v); clearErr('lastName'); }} error={errors.lastName}
        />
      </div>

      {/* ── Email + slide-out code ── */}
      <VerifyField
        id="su-email" label="Email" verified={emailStep === 'verified'} error={errors.email}
        action={
          emailStep === 'idle' || emailStep === 'sending' ? (
            <button
              type="button" className="auth-inline-btn"
              onClick={() => void sendEmail()} disabled={!isLoaded || emailBusy}
            >
              {emailStep === 'sending' ? 'Sending…' : 'Verify'}
            </button>
          ) : (
            <button
              type="button" className="auth-inline-btn auth-inline-btn--ghost"
              onClick={() => { setEmailStep('idle'); setEmailCode(''); clearErr('emailCode'); }}
              disabled={emailBusy}
            >
              Change
            </button>
          )
        }
      >
        <input
          id="su-email" name="email" type="email" inputMode="email" autoComplete="email"
          placeholder="you@email.com"
          className={`auth-box auth-box--action${emailStep === 'verified' ? ' is-verified' : ''}`}
          value={email}
          readOnly={emailLocked}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? 'su-email-err' : undefined}
          onChange={(e) => { setEmail(e.target.value); clearErr('email'); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (emailStep === 'idle') void sendEmail();
          }}
        />
      </VerifyField>
      <CodeReveal
        open={emailStep === 'code' || emailStep === 'verifying'}
        label="Email code"
        sentTo={email.trim()}
        value={emailCode}
        onChange={(v) => { setEmailCode(v); clearErr('emailCode'); }}
        onSubmit={(c) => void verifyEmail(c)}
        error={errors.emailCode}
        busy={emailStep === 'verifying'}
        onResend={() => void resendEmail()}
        resendIn={emailResendIn}
        codeLength={6}
      />

      {/* Clerk smart-CAPTCHA mount point — required for custom sign-up flows. */}
      <div id="clerk-captcha" />

      {/* ── Phone + slide-out code ── */}
      <VerifyField
        id="su-phone" label="Mobile number · India" verified={phoneStep === 'verified'} error={errors.phone}
        action={
          <button
            type="button" className="auth-inline-btn"
            onClick={() => void sendPhone()}
            disabled={!phoneUnlocked || phoneBusy || phone.length !== 10 || phoneStep === 'code' && phoneResendIn > 0}
          >
            {phoneStep === 'sending' ? 'Sending…' : phoneStep === 'code' || phoneStep === 'verifying' ? 'Sent' : 'Send OTP'}
          </button>
        }
        hint={
          <p className="auth-hint">
            {phoneUnlocked
              ? 'We text you a code to confirm it. Your AvaTOK number is what other people see, so your real number stays private.'
              : 'Verify your email first, then we’ll text a code to your phone.'}
          </p>
        }
      >
        <span className="auth-prefix" aria-hidden="true">+91</span>
        <input
          ref={phoneInputRef}
          id="su-phone" name="phone" type="tel" inputMode="numeric" autoComplete="tel-national"
          placeholder="98765 43210"
          className={`auth-box auth-box--action auth-box--prefixed${phoneStep === 'verified' ? ' is-verified' : ''}`}
          value={phone}
          maxLength={14}
          disabled={!phoneUnlocked}
          readOnly={phoneBusy}
          aria-invalid={errors.phone ? true : undefined}
          aria-describedby={errors.phone ? 'su-phone-err' : undefined}
          onChange={(e) => onPhoneChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (phoneStep === 'idle') void sendPhone();
          }}
        />
      </VerifyField>
      <CodeReveal
        open={phoneStep === 'code' || phoneStep === 'verifying'}
        label="SMS code"
        sentTo={`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`}
        value={phoneCode}
        onChange={(v) => { setPhoneCode(v); clearErr('phoneCode'); }}
        onSubmit={(c) => void verifyPhone(c)}
        error={errors.phoneCode}
        busy={phoneStep === 'verifying'}
        onResend={() => void sendPhone()}
        resendIn={phoneResendIn}
        codeLength={6}
      />

      <CheckRow
        className="auth-terms" large checked={agreed}
        onChange={(v) => { setAgreed(v); clearErr('terms'); }}
        error={errors.terms}
      >
        I&rsquo;m 18 or over and I agree to the <a href="/terms">terms</a> and{' '}
        <a href="/community-guidelines">safety rules</a>.
      </CheckRow>

      {!bothVerified && (
        <p className="auth-gatehint">Verify your email and phone to continue.</p>
      )}

      {/* See LoginIsland: never clickable-but-dead while Clerk is loading. */}
      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled || !bothVerified}>
        {resume ? 'Finish and continue' : 'Create my account'}
      </Button>

      {!resume && (
        <>
          <Divider label="Ya phir" />
          <GoogleButton onClick={() => void google()} disabled={stalled || submitting || emailLocked} />
          <div className="auth-foot">
            <p className="auth-footline">
              Already with us?<a href="/sign-in">Log in</a>
            </p>
          </div>
        </>
      )}
    </form>
  );
}

export function SignUpIsland() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="auth-form">
        <p className="auth-formerr">
          Sign-up isn’t configured on this build. Set PUBLIC_CLERK_PUBLISHABLE_KEY.
        </p>
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
