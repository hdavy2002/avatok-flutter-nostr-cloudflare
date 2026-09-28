import { UiMessage } from "../../lib/i18n/react";
import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* /sign-in — Saa Thum log in. Email, a 6-digit code, done. Or Google.
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Custom Clerk flow, NOT the prebuilt <SignIn/>
 * component: the design is a bespoke form (truck-art palette, solid ink shadows)
 * that Clerk's drop-in cannot be themed to, so we drive the API directly.
 *
 * ── [WEB-PWLESS-1 2026-09-06] WHAT THIS REPLACED, AND WHY IT WAS SO BIG ──────
 * This file used to be 547 lines, almost all of it survival tactics around a
 * password. It tried `create({identifier, password})`, then re-attempted the
 * password as an explicit first factor (because Clerk returns
 * `needs_first_factor` while still offering `password`), then re-listed the
 * factors with an identifier-only call (because a create() carrying a password
 * comes back with `supportedFirstFactors` EMPTY), then handled
 * `form_password_pwned` and `needs_new_password` — Clerk refusing a CORRECT
 * password because it appears in a breach corpus — then finally offered an
 * emailed code that could never work anyway, because
 * `email_address.first_factors` was `[]` on the instance.
 *
 * All of that machinery was in service of a credential the product no longer
 * has. Passwords are disabled instance-wide (owner decision 2026-09-06) and
 * "Sign-in with email → Email verification code" is now ON. What is left is the
 * flow the owner actually asked for: enter an email, get an OTP, verify, in.
 *
 * The shared logic lives in ./passwordless.ts — the same module the checkout
 * panel uses, so the two can no longer drift apart. That drift is what let one
 * surface print "Could not send the code. Check the address and try again." for
 * every existing account while another surface did something different.
 *
 * Sign-in and sign-up are the SAME ACT here: an unknown email is signed up, a
 * known one is signed in, and the person types their address exactly once. That
 * is deliberate — asking "do you have an account?" is a wasted step and an
 * account-enumeration oracle.
 */
import { useRef, useState } from 'react';
import { useSignIn, useSignUp, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { capture, withTrace } from '../../lib/analytics';
import { postLoginTarget } from '../../lib/authRedirect';
import {
  Field, Button, Divider, GoogleButton, CodeStep,
  validateEmail, useFormReady, useClerkStalled, useRedirectIfSignedIn, STALLED_MESSAGE,
  type FieldErrors,
} from './AuthKit';
import {
  sendPasswordlessCode, verifyPasswordlessCode, continueWithGoogle, pwlError, finishUrl,
  type PwlMode, type PwlSignIn, type PwlSignUp,
} from './passwordless';
import {
  sendWhatsAppCode, verifyWhatsAppCode, redeemWhatsAppTicket, waApiMessage,
  storeWaProof, readWaProof, clearWaProof, claimWhatsAppProof,
} from './whatsappAuth';
import { WhatsAppNumberInput } from './WhatsAppNumberInput';
import { getActiveTokenWaited } from '../../lib/clerk';
import { DEFAULT_COUNTRY, toE164 } from '../../lib/countries';

/** Where to land after a successful sign-in. Honours ?redirect_url= / ?next= (same-origin only).
 *
 * [WEB-AUTH-LANDING-1 2026-08-28] Signing in lands on the DASHBOARD, not the
 * public marketplace. [DASH2-FOUNDATION 2026-09-25, owner decision] ALWAYS
 * /dashboard (Book events) — the old IN-country detour to /india is gone —
 * unless the visitor was sent here from a specific page (e.g. checkout).
 * lib/authRedirect.ts also closes the `next=//evil.example` open redirect the
 * old `startsWith('/')` check allowed. */
function nextUrl(): string {
  return postLoginTarget();
}

function Inner() {
  const {t:uiT}=useUiTranslation("web-auth");

  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const { user } = useUser();

  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [mode, setMode] = useState<PwlMode>('signIn');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);

  // [WA-WEB-1 2026-09-28] Login method choice: email code / WhatsApp code
  // (Google keeps its own button below, unaffected by this choice).
  const [method, setMethodState] = useState<'email' | 'whatsapp'>('email');
  const [waStage, setWaStage] = useState<'number' | 'code' | 'needs_email'>('number');
  const [waCountry, setWaCountry] = useState(DEFAULT_COUNTRY.code);
  const [waNational, setWaNational] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waResendAt, setWaResendAt] = useState(0);
  const [waPhoneMasked, setWaPhoneMasked] = useState('');

  function setMethod(m: 'email' | 'whatsapp') {
    setMethodState(m);
    setFormError(null);
    capture('login_method_chosen', { method: m, surface: 'sign_in' });
  }

  const isLoaded = signInLoaded && signUpLoaded;
  const stalled = useClerkStalled(isLoaded);
  // Already signed in? Go where they were headed. Nothing on this form can
  // succeed for them — see useRedirectIfSignedIn.
  const leaving = useRedirectIfSignedIn(nextUrl);
  useFormReady(isLoaded && !leaving, 'sign_in');
  // §2.2 auth_signin_start/_result — startRef anchors the `ms` on the result.
  const startRef = useRef<number>(0);

  function set<T>(setter: (v: T) => void, key: string) {
    return (v: T) => {
      setter(v);
      // README §Validation: editing a field clears that field's error.
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    };
  }

  async function onSubmitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;

    const err = validateEmail(email);
    setErrors({ email: err });
    if (err) return;

    setSubmitting(true);
    setFormError(null);
    startRef.current = Date.now();
    capture('auth_signin_start', { method: 'email_code' });
    try {
      const m = await withTrace(() => sendPasswordlessCode({
        signUp: signUp as unknown as PwlSignUp,
        signIn: signIn as unknown as PwlSignIn,
        email,
        extra: { unsafeMetadata: { signedUpVia: 'web_signin' } },
      }));
      setMode(m);
      setStage('code');
      capture('auth_code_sent', { surface: 'sign_in', mode: m });
    } catch (err) {
      // [WEB-PWLESS-1] The message is the diagnosis, not a shrug. See
      // passwordless.ts — a self-raised error carries its own words, so an
      // instance misconfiguration can never again be reported to the user as
      // "check the address".
      const { message, reason } = pwlError(err, 'We couldn’t email a code just now. Please try again.');
      setFormError(message);
      capture('auth_signin_result', {
        method: 'email_code', outcome: 'error', reason, ms: Date.now() - startRef.current,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;
    if (code.trim().length < 6) {
      setErrors({ code: 'Enter the 6-digit code.' });
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const { created } = await withTrace(() => verifyPasswordlessCode({
        mode,
        signUp: signUp as unknown as PwlSignUp,
        signIn: signIn as unknown as PwlSignIn,
        setActive: setActive as unknown as (p: { session: string }) => Promise<unknown>,
        code,
      }));
      capture('auth_signin_result', {
        method: 'email_code', outcome: 'ok', created,
        ms: Date.now() - startRef.current,
      });
      // [WEB-PHONE-OTP-1] via the phone gate — a brand-new account made here must verify a phone.
      const savedCountry = String((user?.unsafeMetadata as { country?: unknown } | undefined)?.country ?? '').toUpperCase();
      if (user && !savedCountry) {
        try { await user.update({ unsafeMetadata: { ...(user.unsafeMetadata ?? {}), country: 'GLOBAL' } }); } catch { /* routing still succeeds */ }
      }
      // [WA-WEB-1] If this email step finished a "Continue with WhatsApp" ->
      // needs_email hand-off, attach the verified number now — the person is
      // never asked for a second WhatsApp code.
      await claimPendingWaProof();
      location.href = finishUrl(nextUrl());
    } catch (err) {
      const { message, reason } = pwlError(err, 'That code didn’t work. Check it and try again.');
      setFormError(message);
      capture('auth_signin_result', {
        method: 'email_code', outcome: 'error', reason, ms: Date.now() - startRef.current,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    if (!isLoaded || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const m = await sendPasswordlessCode({
        signUp: signUp as unknown as PwlSignUp,
        signIn: signIn as unknown as PwlSignIn,
        email,
      });
      setMode(m);
      setResent(true);
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t resend the code. Please try again.').message);
    } finally {
      setSubmitting(false);
    }
  }

  async function google() {
    if (!isLoaded || submitting) return;
    setFormError(null);
    try {
      capture('login_method_chosen', { method: 'google', surface: 'sign_in' });
      await continueWithGoogle(signIn as unknown as PwlSignIn, finishUrl(nextUrl())); // [WEB-PHONE-OTP-1]
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  /* ── WhatsApp login (owner decision 2026-09-28) ──────────────────────── */
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
      if (r.status === 'signed_in') {
        await redeemWhatsAppTicket(signIn as unknown as PwlSignIn, setActive, r.ticket);
        location.href = finishUrl(nextUrl());
        return;
      }
      // needs_email: a brand-new number. Keep the proof for after the email
      // step, and hand off to the same one-box email flow used elsewhere.
      storeWaProof(r.proof, r.phone_masked);
      setWaPhoneMasked(r.phone_masked);
      setWaStage('needs_email');
      setMethodState('email');
      setStage('email');
    } catch (err) {
      setFormError(waApiMessage(err, 'That code didn’t work. Check it and try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  /** After an email code completes sign-up/sign-in, attach a pending WhatsApp proof, if any. */
  async function claimPendingWaProof() {
    const pending = readWaProof();
    if (!pending) return;
    try {
      const token = await getActiveTokenWaited();
      if (token) await claimWhatsAppProof(pending.proof, token);
    } catch {
      clearWaProof(); // the phone gate will ask again rather than looping forever
    }
  }

  if (leaving) {
    return <p className="auth-footline"><UiText id="web-auth.85a4acfc80f40e78" source="You’re already signed in — taking you through…" /></p>;
  }

  if (stage === 'code') {
    return (
      <CodeStep
        eyebrow={uiT("web-auth.4e897b88efea4f9f","One last check")}
        heading={<><UiText id="web-auth.46546a0764fe7aeb" source="Check your" /><br /><UiText id="web-auth.82244417f956ac7c" source="email" /></>}
        sentTo={email.trim().toLowerCase()}
        code={code}
        onCode={set(setCode, 'code')}
        error={errors.code}
        formError={formError}
        submitting={submitting}
        onSubmit={onSubmitCode}
        onResend={() => void resend()}
        resent={resent}
        cta={uiT("web-auth.1f1ecba8f9a619cf","Verify and log in")}
      >
        <button
          type="button"
          className="auth-forgot"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => { setStage('email'); setCode(''); setErrors({}); setFormError(null); }}
        ><UiText id="web-auth.b7337027ef1f69f1" source="Use a different email" />{" "}</button>
      </CodeStep>
    );
  }

  const methodTabs = (
    <div className="auth-row" role="tablist" aria-label="Sign-in method" style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
      <button type="button" role="tab" aria-selected={method === 'email'} className={`auth-btn auth-btn--${method === 'email' ? 'ghost' : 'ink'}`}
        onClick={() => setMethod('email')} disabled={waStage === 'needs_email'}>
        Continue with email
      </button>
      <button type="button" role="tab" aria-selected={method === 'whatsapp'} className={`auth-btn auth-btn--${method === 'whatsapp' ? 'ghost' : 'ink'}`}
        onClick={() => setMethod('whatsapp')}>
        Continue with WhatsApp
      </button>
    </div>
  );

  if (method === 'whatsapp') {
    return (
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void (waStage === 'number' ? sendWa() : verifyWa()); }} noValidate>
        <div className="auth-desktop-head">
          <p className="auth-eyebrow"><UiText id="web-auth.6621249514b7887c" source="Welcome back" /></p>
          <h1 className="auth-h2">Good to see you</h1>
        </div>
        {methodTabs}
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
            <p className="auth-hint">We’ll send a 6-digit code on WhatsApp to sign you in.</p>
            <Button type="submit" loading={submitting}>Send code on WhatsApp</Button>
          </>
        )}
        {waStage === 'code' && (
          <>
            <p className="auth-footline" style={{ textAlign: 'left' }}>We sent a 6-digit code on WhatsApp to <strong>{waPhoneMasked}</strong>.</p>
            <Field label="Verification code" name="waCode" inputMode="numeric" maxLength={6}
              autoComplete="one-time-code" placeholder="123456" value={waCode} onChange={setWaCode} />
            <Button type="submit" loading={submitting}>Verify and log in</Button>
            <div className="auth-foot">
              <p className="auth-footline">
                {waResendIn > 0 ? `Resend in ${waResendIn}s` : (
                  <a href="#resend" onClick={(ev) => { ev.preventDefault(); void sendWa(); }}>Resend code</a>
                )}
                {' '}
                <a href="#change" onClick={(ev) => { ev.preventDefault(); setWaStage('number'); setWaCode(''); setFormError(null); }}>Use a different number</a>
              </p>
            </div>
          </>
        )}
        <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
        <GoogleButton onClick={() => void google()} disabled={!isLoaded || stalled || submitting} />
        <div className="auth-foot">
          <p className="auth-footline"><UiText id="web-auth.38c1c4457cd164cc" source="New here?" /><a href="/sign-up"><UiText id="web-auth.86033f75a4c0876a" source="Create an account" /></a>
          </p>
        </div>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmitEmail} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow"><UiText id="web-auth.6621249514b7887c" source="Welcome back" /></p>
        <h1 className="auth-h2"><UiText id="web-auth.c3854d65cd242a9e" source="Good to" /> <UiText id="web-auth.10c91675b679b066" source="see you" /></h1>
      </div>

      {waStage === 'needs_email' && (
        <p className="auth-hint">Add your email — we need it for receipts and event links. You won’t be asked for a second WhatsApp code.</p>
      )}
      {waStage !== 'needs_email' && methodTabs}

      {(formError || stalled) && (
        <p className="auth-formerr" role="alert"><UiMessage namespace="web-auth" value={formError ?? STALLED_MESSAGE} /></p>
      )}

      <Field
        label={uiT("web-auth.969ccbd3cf6300ec","Email")} name="email" type="email" inputMode="email"
        autoComplete="email" placeholder={uiT("web-auth.8d12b7f58c0d3fc8","you@email.com")}
        value={email} onChange={set(setEmail, 'email')} error={errors.email}
      />
      <p className="auth-hint"><UiText id="web-auth.b079d8697ba95cab" source="No password. We’ll email you a 6-digit code — new here or not, this is the way in." />{" "}</p>

      {/* Clerk smart-CAPTCHA mount point. `captcha_enabled` is on for this
          instance and this form can create an account, so a custom flow MUST
          provide id="clerk-captcha" or Clerk falls back to an invisible
          challenge and can reject the attempt. Not dead markup — do not remove. */}
      <div id="clerk-captcha" />

      {/* Never clickable-but-dead: while Clerk is still loading the button shows
          its loading state, and if loading fails the message above explains it. */}
      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled}><UiText id="web-auth.88d420398edd3a06" source="Email me a code" />{" "}</Button>

      {waStage !== 'needs_email' && (
        <>
          <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
          <GoogleButton onClick={() => void google()} disabled={!isLoaded || stalled || submitting} />
        </>
      )}

      <div className="auth-foot">
        <p className="auth-aside"><UiText id="web-auth.147f03f49b15afba" source="Time for chai?" /><br /><UiText id="web-auth.eef3540404312d17" source="That's sorted too." /></p>
        <p className="auth-footline"><UiText id="web-auth.38c1c4457cd164cc" source="New here?" /><a href="/sign-up"><UiText id="web-auth.86033f75a4c0876a" source="Create an account" /></a>
        </p>
      </div>
    </form>
  );
}

export function LoginIsland() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="auth-form">
        <p className="auth-formerr"><UiText id="web-auth.a85f365b9695e2dd" source="Sign-in isn’t configured on this build. Set PUBLIC_CLERK_PUBLISHABLE_KEY." />{" "}</p>
      </div>
    );
  }
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default LoginIsland;
