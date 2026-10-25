
import { UiMessage } from "../../lib/i18n/react";
import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* /sign-up — create an account: Name, Email, WhatsApp number, and a code for EACH.
 *
 * [HF-AUTH-WA-ONLY-1 2026-10-24, owner decision] Sign-in is WhatsApp-only, and an account is
 * only created once BOTH the email and the WhatsApp number have been proven by a 6-digit code.
 * [HF-AUTH-GOOGLE-BACK-1 2026-10-25] Google is back as a button under the form; its return lands in RESUME / FINISH MODE
 * below (signed in, WhatsApp not verified yet), which verifies a number and bootstraps the account.
 * The code path itself has no Clerk sign-up resource, no session until the very end:
 *
 *   1. details  — name, email, WhatsApp number, the 18+/terms box. "Send codes" emails a code
 *                 (POST /api/auth/signup/email/send) and sends one on WhatsApp.
 *   2. codes    — both codes on one screen. "Verify and create my account" checks the email code
 *                 (-> single-use email proof), then posts the WhatsApp code WITH the proof, name
 *                 and 18+ tick (POST /api/auth/whatsapp/verify). Only that call creates the
 *                 account, with the name and the verified email on it, and answers a Clerk ticket
 *                 that redeemWhatsAppTicket turns into the session.
 * A wrong WhatsApp code leaves the email proof usable (30 min), so only the bad code is retyped.
 * An email that already has an account is refused at step 1 with "sign in with your WhatsApp".
 *
 * RESUME / FINISH MODE (?finish=1 or a signed-in account with no verified WhatsApp): the older
 * accounts made by email. They are signed in already, so the page only asks them to verify a
 * WhatsApp number (the authed /api/account/phone/* routes) and then opens the account. Nobody is
 * locked out by this change.
 *
 * Brand names come from the central config, never typed here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth, useSignIn, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { capture, captureException } from '../../lib/analytics';
import {
  Field, Button, CheckRow, Divider, GoogleButton,
  validateEmail, validateRequired,
  useClerkStalled, STALLED_MESSAGE,
  type FieldErrors,
} from './AuthKit';
import {
  bootstrapAccount, continueWithGoogle, pwlError, finishUrl, getPhoneStatus, sendPhoneCode, verifyPhoneCode, apiMessage, apiCode,
  type PwlSignIn,
} from './passwordless';
import {
  sendWhatsAppCode, verifyWhatsAppCode, redeemWhatsAppTicket, waApiMessage, waApiCode,
  sendSignupEmailCode, verifySignupEmailCode,
} from './whatsappAuth';
import { WhatsAppNumberInput } from './WhatsAppNumberInput';
import { DEFAULT_COUNTRY, toE164 } from '../../lib/countries';
import { DEFAULT_LANDING, safeSameOriginPath } from '../../lib/authRedirect';

type Step = 'idle' | 'sending' | 'code' | 'verifying' | 'verified';

function readParams(): { next: string | null; country: string | null } {
  try {
    const q = new URLSearchParams(location.search);
    return {
      // [DASH2-FOUNDATION] redirect_url (preferred) or next; same-origin only.
      next: safeSameOriginPath(q.get('redirect_url')) ?? safeSameOriginPath(q.get('next')),
      country: (q.get('country') || '').toUpperCase() || null,
    };
  } catch {
    return { next: null, country: null };
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

function Inner() {
  const {t:uiT}=useUiTranslation("web-auth");

  const { signIn, setActive } = useSignIn();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const params = useMemo(readParams, []);

  const [boot, setBoot] = useState<'checking' | 'form' | 'leaving'>('checking');
  /** Signed-in account that still needs a verified WhatsApp number (older email accounts). */
  const [resume, setResume] = useState(false);

  // New-account form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState(DEFAULT_COUNTRY.code);
  const [national, setNational] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [stage, setStage] = useState<'details' | 'codes'>('details');
  const [emailCode, setEmailCode] = useState('');
  const [waCode, setWaCode] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [emailProof, setEmailProof] = useState<{ email: string; proof: string } | null>(null);
  const [emailResendAt, setEmailResendAt] = useState(0);
  const [waResendAt, setWaResendAt] = useState(0);
  const [waMasked, setWaMasked] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Resume mode (WhatsApp only)
  const [phone, setPhone] = useState('');
  const [phoneCountry, setPhoneCountry] = useState(DEFAULT_COUNTRY.code);
  const [phoneStep, setPhoneStep] = useState<Step>('idle');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneResendAt, setPhoneResendAt] = useState(0);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const stalled = useClerkStalled(authLoaded);
  const startRef = useRef<number>(Date.now());
  const decided = useRef(false);

  const emailResendIn = useCountdown(emailResendAt);
  const waResendIn = useCountdown(waResendAt);
  const phoneResendIn = useCountdown(phoneResendAt);

  const destination = () => params.next ?? DEFAULT_LANDING;
  const waE164 = () => toE164(country, national);

  function clearErr(...keys: string[]) {
    setErrors((e) => {
      if (!keys.some((k) => e[k])) return e;
      const n = { ...e };
      for (const k of keys) n[k] = undefined;
      return n;
    });
  }

  /* ── First load: already signed in? Decide ONCE. ──────────────────────── */
  useEffect(() => {
    if (!authLoaded || decided.current) return;
    decided.current = true;
    if (!isSignedIn) { setBoot('form'); return; }
    void (async () => {
      let st: Awaited<ReturnType<typeof getPhoneStatus>> | null = null;
      try { st = await getPhoneStatus(); } catch { st = null; }
      capture('auth_phone_gate', {
        outcome: st == null ? 'status_failed' : st.needs_phone ? 'resume' : 'pass',
        has_account: st?.has_account, verified: st?.verified,
      });
      // A failed status read lets the person in rather than trapping a signed-in user on a form.
      if (!st || !st.needs_phone) {
        setBoot('leaving');
        location.href = destination();
        return;
      }
      setResume(true);
      if (st.verified && st.phone) {
        setVerifiedPhone(st.phone);
        setPhone(st.phone.replace(/^\+91/, ''));
        setPhoneStep('verified');
      }
      setBoot('form');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn]);

  /* ── New account: step 1 — send both codes ─────────────────────────────── */
  async function sendCodes() {
    if (submitting) return;
    const digits = national.replace(/\D/g, '');
    const next: FieldErrors = {
      name: validateRequired(name, 'Your name'),
      email: validateEmail(email),
      phone: digits.length < 4 ? 'Enter your WhatsApp number.' : undefined,
      terms: agreed ? undefined : 'Please accept the terms to continue.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    const cleanEmail = email.trim().toLowerCase();
    setSubmitting(true);
    setFormError(null);
    startRef.current = Date.now();
    try {
      // Email first: it is the one that can be refused ("already has an account").
      if (emailSentTo !== cleanEmail) {
        const r = await sendSignupEmailCode(cleanEmail);
        setEmailSentTo(cleanEmail);
        setEmailProof(null);
        setEmailCode('');
        setEmailResendAt(Date.now() + (r.resend_after_s ?? 60) * 1000);
      }
    } catch (err) {
      setErrors((e) => ({ ...e, email: waApiMessage(err, 'We couldn’t email a code just now. Please try again.') }));
      capture('auth_signup_result', { outcome: 'error', stage: 'email_send', reason: waApiCode(err) || 'unknown' });
      setSubmitting(false);
      return;
    }
    try {
      const r = await sendWhatsAppCode(waE164());
      setWaMasked(r.phone_masked);
      setWaCode('');
      setWaResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      setStage('codes');
      capture('signup_step', { method: 'whatsapp_email', step: 'codes' });
    } catch (err) {
      // The email code is already out; the person fixes the number and presses again (the email is not re-sent).
      setErrors((e) => ({ ...e, phone: waApiMessage(err, 'We couldn’t send the code on WhatsApp. Please try again.') }));
      capture('auth_signup_result', { outcome: 'error', stage: 'phone_send', reason: waApiCode(err) || 'unknown' });
    } finally {
      setSubmitting(false);
    }
  }

  async function resendEmailCode() {
    if (submitting || emailResendIn > 0) return;
    setSubmitting(true);
    clearErr('emailCode');
    try {
      const r = await sendSignupEmailCode(email.trim().toLowerCase());
      setEmailResendAt(Date.now() + (r.resend_after_s ?? 60) * 1000);
    } catch (err) {
      setErrors((e) => ({ ...e, emailCode: waApiMessage(err, 'We couldn’t email a code just now. Please try again.') }));
    } finally {
      setSubmitting(false);
    }
  }

  async function resendWaCode() {
    if (submitting || waResendIn > 0) return;
    setSubmitting(true);
    clearErr('waCode');
    try {
      const r = await sendWhatsAppCode(waE164());
      setWaResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
    } catch (err) {
      setErrors((e) => ({ ...e, waCode: waApiMessage(err, 'We couldn’t send the code on WhatsApp. Please try again.') }));
    } finally {
      setSubmitting(false);
    }
  }

  /* ── New account: step 2 — check both codes, create the account ───────── */
  async function createAccount() {
    if (submitting) return;
    const cleanEmail = email.trim().toLowerCase();
    const next: FieldErrors = {
      emailCode: emailProof?.email === cleanEmail || /^\d{6}$/.test(emailCode.trim()) ? undefined : 'Enter the 6-digit code from your email.',
      waCode: waCode.trim().length >= 4 ? undefined : 'Enter the 6-digit code from WhatsApp.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    setFormError(null);
    try {
      let proof = emailProof && emailProof.email === cleanEmail ? emailProof.proof : null;
      if (!proof) {
        try {
          proof = await verifySignupEmailCode(cleanEmail, emailCode.trim());
          setEmailProof({ email: cleanEmail, proof });
        } catch (err) {
          setEmailCode('');
          setErrors((e) => ({ ...e, emailCode: waApiMessage(err, 'That email code didn’t work. Check it and try again.') }));
          return;
        }
      }
      let r;
      try {
        r = await verifyWhatsAppCode(waE164(), waCode.trim(), { name: name.trim(), email_proof: proof, age_confirmed: true });
      } catch (err) {
        const c = waApiCode(err);
        if (c === 'email_proof_invalid') {
          setEmailProof(null);
          setEmailCode('');
          setErrors((e) => ({ ...e, emailCode: 'Your email check has expired. Ask for a new email code and enter it again.' }));
        } else if (c === 'email_taken') {
          setErrors((e) => ({ ...e, email: waApiMessage(err, 'This email already has an account. Sign in with your WhatsApp number instead.') }));
          setStage('details');
        } else {
          setWaCode('');
          setErrors((e) => ({ ...e, waCode: waApiMessage(err, 'That WhatsApp code didn’t work. Check it and try again.') }));
        }
        capture('auth_signup_result', { outcome: 'error', stage: 'create', reason: c || 'unknown', ms: Date.now() - startRef.current });
        return;
      }
      if (r.status !== 'signed_in') {
        setFormError('We couldn’t create your account just now. Please try again.');
        return;
      }
      await redeemWhatsAppTicket(signIn as unknown as PwlSignIn, setActive as unknown as (p: { session: string }) => Promise<unknown>, r.ticket);
      // Country is cosmetic profile data — never blocks the redirect.
      capture('auth_signup_result', { outcome: 'ok', stage: 'create', is_new: r.isNew !== false, ms: Date.now() - startRef.current });
      capture('signup_step', { method: 'whatsapp_email', step: 'done' });
      location.href = destination();
    } catch (err) {
      captureException(err, { where: 'signup_create' });
      setFormError('We couldn’t finish creating your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Resume mode: verify a WhatsApp number on a signed-in older account ─ */
  async function finishAccount(phoneForBootstrap: string) {
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await bootstrapAccount({
        phone: phoneForBootstrap,
        display_name: `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim(),
      });
      capture('auth_signup_result', { outcome: res.ok ? 'ok' : 'error', stage: 'bootstrap', reason: res.message, finish: true, ms: Date.now() - startRef.current });
      if (!res.ok) {
        setFormError(res.message ?? 'We couldn’t open your account just now. Please try again.');
        setSubmitting(false);
        return;
      }
      location.href = destination();
    } catch (err) {
      captureException(err, { where: 'signup_finish' });
      setFormError('We couldn’t open your account just now. Please try again.');
      setSubmitting(false);
    }
  }

  /** [HF-AUTH-GOOGLE-BACK-1] Hand off to Google; it comes back through the WhatsApp gate on this page (?finish=1). */
  async function google() {
    if (submitting) return;
    setFormError(null);
    try {
      capture('login_method_chosen', { method: 'google', surface: 'sign_up' });
      await continueWithGoogle(signIn as unknown as PwlSignIn, finishUrl(destination()));
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  function onPhoneChange(v: string, c: string) {
    setPhone(v);
    setPhoneCountry(c);
    clearErr('phone', 'phoneCode');
    if (phoneStep === 'code' || phoneStep === 'verified') {
      setPhoneStep('idle');
      setPhoneCode('');
      setVerifiedPhone(null);
    }
  }

  async function sendPhone() {
    if (phoneStep === 'sending' || phoneStep === 'verifying') return;
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
      capture('auth_phone_verified', { surface: 'sign_up_finish' });
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

  if (boot === 'checking' || boot === 'leaving') {
    return <p className="auth-footline">{boot === 'leaving' ? uiT("web-auth.02d310528cc61f61","You’re signed in — taking you through…") : uiT("web-auth.4152c1296fa27021","One sec…")}</p>;
  }

  /* ── Resume mode screens ──────────────────────────────────────────────── */
  function phoneScreens(eyebrow: string, heading: string): ReactNode {
    if (phoneStep === 'verified') {
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

  if (resume) {
    return <>{phoneScreens(uiT("web-auth.be98b10d2db32b3f","One last step"), "Verify your WhatsApp")}</>;
  }

  /* ── Screen 2: both codes ─────────────────────────────────────────────── */
  if (stage === 'codes') {
    const emailDone = !!emailProof && emailProof.email === email.trim().toLowerCase();
    return (
      <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void createAccount(); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">Almost there</p>
          <h1 className="auth-h2">Enter your two codes</h1>
        </div>
        {(formError || stalled) && (
          <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
        )}
        {emailDone ? (
          <p className="auth-footline" style={{ textAlign: 'left' }}>Email <strong>{email.trim()}</strong> is verified.</p>
        ) : (
          <>
            <p className="auth-footline" style={{ textAlign: 'left' }}>We emailed a 6-digit code to <strong>{email.trim()}</strong>.</p>
            <Field
              label="Email code" name="emailCode" inputMode="numeric" maxLength={6}
              autoComplete="one-time-code" placeholder="123456"
              value={emailCode} onChange={(v) => { setEmailCode(v); clearErr('emailCode'); }} error={errors.emailCode}
            />
            <p className="auth-footline" style={{ textAlign: 'left' }}>
              {emailResendIn > 0 ? `Resend email code in ${emailResendIn}s` : (
                <a href="#resend-email" onClick={(ev) => { ev.preventDefault(); void resendEmailCode(); }}>Resend email code</a>
              )}
            </p>
          </>
        )}
        <p className="auth-footline" style={{ textAlign: 'left' }}>We sent a 6-digit code on WhatsApp to <strong>{waMasked}</strong>.</p>
        <Field
          label="WhatsApp code" name="waCode" inputMode="numeric" maxLength={6}
          autoComplete="one-time-code" placeholder="123456"
          value={waCode} onChange={(v) => { setWaCode(v); clearErr('waCode'); }} error={errors.waCode}
        />
        <p className="auth-footline" style={{ textAlign: 'left' }}>
          {waResendIn > 0 ? `Resend WhatsApp code in ${waResendIn}s` : (
            <a href="#resend-wa" onClick={(ev) => { ev.preventDefault(); void resendWaCode(); }}>Resend WhatsApp code</a>
          )}
        </p>
        <Button type="submit" loading={submitting}>Verify and create my account</Button>
        <div className="auth-foot">
          <p className="auth-footline">
            <a href="#back" onClick={(ev) => { ev.preventDefault(); setStage('details'); setFormError(null); setErrors({}); }}>Change my details</a>
          </p>
        </div>
      </form>
    );
  }

  /* ── Screen 1: details ────────────────────────────────────────────────── */
  return (
    <form className="auth-form auth-form--signup" onSubmit={(e) => { e.preventDefault(); void sendCodes(); }} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow">{uiT("web-auth.6b6ad3ba72651b98","Two minutes, that’s all")}</p>
        <h1 className="auth-h2">{uiT("web-auth.862d3b2696cfbc19","Create my account")}</h1>
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
      <WhatsAppNumberInput
        value={national} countryCode={country}
        onChange={(n, c) => { setNational(n); setCountry(c); clearErr('phone'); }}
        label="WhatsApp number" error={errors.phone}
      />
      <p className="auth-hint">We’ll send one code to your email and one on WhatsApp. You need both to create your account.</p>
      <CheckRow
        className="auth-terms" large checked={agreed}
        onChange={(v) => { setAgreed(v); clearErr('terms'); }}
        error={errors.terms}
      ><UiText id="web-auth.4dca6ceb76d0fbcf" source="I’m 18 or over and I agree to the" />{" "}<a href="/terms"><UiText id="web-auth.51d2361f4faea3bc" source="terms" /></a>{" "}<UiText id="web-auth.6201111b83a0cb5b" source="and" />{' '}
        <a href="/community-guidelines"><UiText id="web-auth.1ce806cb5268307a" source="safety rules" /></a>.
      </CheckRow>
      <Button type="submit" loading={submitting || (!authLoaded && !stalled)} disabled={stalled}>
        Send my codes
      </Button>
      <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
      <GoogleButton onClick={() => void google()} disabled={!authLoaded || stalled || submitting} />
      <div className="auth-foot">
        <p className="auth-footline"><UiText id="web-auth.7016769c24191247" source="Already with us?" /><a href="/sign-in"><UiText id="web-auth.c189840cf7e2d6f6" source="Log in" /></a>
        </p>
      </div>
    </form>
  );
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
