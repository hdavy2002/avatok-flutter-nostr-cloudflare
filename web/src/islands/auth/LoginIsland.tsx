/* /sign-in — avaTOK log in. Email, a 6-digit code, done. Or Google.
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
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { capture, withTrace } from '../../lib/analytics';
import {
  Field, Button, Divider, GoogleButton, CodeStep,
  validateEmail, useClerkStalled, useRedirectIfSignedIn, STALLED_MESSAGE,
  type FieldErrors,
} from './AuthKit';
import {
  sendPasswordlessCode, verifyPasswordlessCode, continueWithGoogle, pwlError, finishUrl,
  type PwlMode, type PwlSignIn, type PwlSignUp,
} from './passwordless';

/** Where to land after a successful sign-in. Honours ?next=/some/path. */
function nextUrl(): string {
  try {
    const n = new URLSearchParams(location.search).get('next');
    if (n && n.startsWith('/')) return n;
  } catch { /* SSR */ }
  // [WEB-AUTH-LANDING-1 2026-08-28] Signing in lands on the DASHBOARD, not the
  // public marketplace. /marketplace is a static design comp with a painted-in
  // "Log in / Sign up" header and no Clerk island, so a freshly signed-in user
  // landed on a page that still looked signed-out — which reads as "the login
  // silently failed".
  return '/dashboard';
}

function Inner() {
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();

  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [mode, setMode] = useState<PwlMode>('signIn');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);

  const isLoaded = signInLoaded && signUpLoaded;
  const stalled = useClerkStalled(isLoaded);
  // Already signed in? Go where they were headed. Nothing on this form can
  // succeed for them — see useRedirectIfSignedIn.
  const leaving = useRedirectIfSignedIn(nextUrl);
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
      await continueWithGoogle(signIn as unknown as PwlSignIn, finishUrl(nextUrl())); // [WEB-PHONE-OTP-1]
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  if (leaving) {
    return <p className="auth-footline">You’re already signed in — taking you through…</p>;
  }

  if (stage === 'code') {
    return (
      <CodeStep
        eyebrow="One last check"
        heading={<>Check your<br />email</>}
        sentTo={email.trim().toLowerCase()}
        code={code}
        onCode={set(setCode, 'code')}
        error={errors.code}
        formError={formError}
        submitting={submitting}
        onSubmit={onSubmitCode}
        onResend={() => void resend()}
        resent={resent}
        cta="Verify and log in"
      >
        <button
          type="button"
          className="auth-forgot"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => { setStage('email'); setCode(''); setErrors({}); setFormError(null); }}
        >
          Use a different email
        </button>
      </CodeStep>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmitEmail} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow">Welcome back</p>
        <h1 className="auth-h2">Good to<br />see you</h1>
      </div>

      {(formError || stalled) && (
        <p className="auth-formerr" role="alert">{formError ?? STALLED_MESSAGE}</p>
      )}

      <Field
        label="Email" name="email" type="email" inputMode="email"
        autoComplete="email" placeholder="you@email.com"
        value={email} onChange={set(setEmail, 'email')} error={errors.email}
      />
      <p className="auth-hint">
        No password. We&rsquo;ll email you a 6-digit code — new here or not, this is the way in.
      </p>

      {/* Clerk smart-CAPTCHA mount point. `captcha_enabled` is on for this
          instance and this form can create an account, so a custom flow MUST
          provide id="clerk-captcha" or Clerk falls back to an invisible
          challenge and can reject the attempt. Not dead markup — do not remove. */}
      <div id="clerk-captcha" />

      {/* Never clickable-but-dead: while Clerk is still loading the button shows
          its loading state, and if loading fails the message above explains it. */}
      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled}>
        Email me a code
      </Button>

      <Divider label="Ya phir" />

      <GoogleButton onClick={() => void google()} disabled={stalled || submitting} />

      <div className="auth-foot">
        <p className="auth-aside">Chai ho jaye?<br />Woh bhi ho jayega.</p>
        <p className="auth-footline">
          New here?<a href="/sign-up">Create an account</a>
        </p>
      </div>
    </form>
  );
}

export function LoginIsland() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="auth-form">
        <p className="auth-formerr">
          Sign-in isn’t configured on this build. Set PUBLIC_CLERK_PUBLISHABLE_KEY.
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

export default LoginIsland;
