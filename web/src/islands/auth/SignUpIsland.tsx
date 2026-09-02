/* /sign-up — avaTOK create account.
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Custom Clerk flow via `useSignUp()`.
 *
 * TWO THINGS THE DESIGN DOES NOT COVER, both verified against the live Clerk
 * instance (public environment endpoint) and both hard blockers:
 *
 * 1. EMAIL VERIFICATION IS MANDATORY. `email_address.verify_at_sign_up` is true
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
 * NAME: the instance requires first_name AND last_name (both required=true), so
 * per the owner's decision the single NAME box in the handoff is split into two
 * real fields rather than guessing a surname from one string.
 *
 * ROLE: stored as `unsafeMetadata.role`. "unsafe" is Clerk's name for
 * client-writable metadata, not a security warning about the value — it is the
 * only metadata a browser may set during sign-up. It is readable everywhere
 * immediately (app included) via the session claims. If the role ever gates
 * money or permissions, promote it to publicMetadata from the Worker, because a
 * determined client can set unsafeMetadata to anything.
 */
import { useRef, useState } from 'react';
import { useSignUp } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { capture, withTrace } from '../../lib/analytics';
import {
  Field, Button, CheckRow, Divider, SocialPair, SOCIAL_ENABLED, RolePicker, CodeStep,
  validateEmail, validatePassword, validateRequired, clerkError,
  useClerkStalled, STALLED_MESSAGE,
  type FieldErrors, type Role,
} from './AuthKit';

/** Creators go to the studio; friends go browsing. */
function landingFor(role: Role): string {
  return role === 'creator' ? '/dashboard' : '/marketplace';
}

function Inner() {
  const { isLoaded, signUp, setActive } = useSignUp();

  const [stage, setStage] = useState<'form' | 'verify'>('form');
  const [role, setRole] = useState<Role>('friend'); // README: Friend preselected
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState('');

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  const stalled = useClerkStalled(isLoaded);
  // §2.2 auth_signup_result — startRef anchors the `ms` on the eventual result.
  const signupStartRef = useRef<number>(0);

  function set<T>(setter: (v: T) => void, key: string) {
    return (v: T) => {
      setter(v);
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;

    const next: FieldErrors = {
      firstName: validateRequired(firstName, 'First name'),
      lastName: validateRequired(lastName, 'Last name'),
      email: validateEmail(email),
      password: validatePassword(password),
      // README: submit is blocked until the terms box is checked.
      terms: agreed ? undefined : 'Please accept the terms to continue.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    setFormError(null);
    signupStartRef.current = Date.now();
    try {
      await withTrace(async () => {
        await signUp.create({
          emailAddress: email.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          unsafeMetadata: { role, signedUpVia: 'web' },
        });
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      });
      setStage('verify');
    } catch (err) {
      setFormError(clerkError(err));
      capture('auth_signup_result', {
        outcome: 'error', reason: clerkError(err), ms: Date.now() - signupStartRef.current,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;
    if (code.trim().length < 6) {
      setErrors({ code: 'Enter the 6-digit code.' });
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await withTrace(() => signUp.attemptEmailAddressVerification({ code: code.trim() }));
      if (res.status === 'complete') {
        await setActive({ session: res.createdSessionId });
        capture('auth_signup_result', {
          outcome: 'ok', ms: Date.now() - signupStartRef.current,
        });
        location.href = landingFor(role);
        return;
      }
      setFormError('That didn’t complete sign-up. Please check the code and try again.');
      capture('auth_signup_result', {
        outcome: 'error', reason: 'code_incomplete', ms: Date.now() - signupStartRef.current,
      });
    } catch (err) {
      setFormError(clerkError(err));
      capture('auth_signup_result', {
        outcome: 'error', reason: clerkError(err), ms: Date.now() - signupStartRef.current,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    if (!isLoaded) return;
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setResent(true);
    } catch (err) {
      setFormError(clerkError(err));
    }
  }

  /* ── Step 2: email code ─────────────────────────────────────────────── */
  if (stage === 'verify') {
    return (
      <CodeStep
        eyebrow="One last thing"
        heading={<>Check your<br />email</>}
        sentTo={email}
        code={code}
        onCode={set(setCode, 'code')}
        error={errors.code}
        formError={formError}
        submitting={submitting}
        onSubmit={onVerify}
        onResend={() => void resend()}
        resent={resent}
        cta="Verify and finish"
      />
    );
  }

  /* ── Step 1: the designed form ──────────────────────────────────────── */
  return (
    <form className="auth-form auth-form--signup" onSubmit={onSubmit} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow">Two minutes, that&rsquo;s all</p>
        <h1 className="auth-h2">Create my account</h1>
      </div>

      {(formError || stalled) && (
        <p className="auth-formerr" role="alert">{formError ?? STALLED_MESSAGE}</p>
      )}

      <RolePicker value={role} onChange={setRole} />

      <div className="auth-namepair">
        <Field
          label="First name" name="firstName" autoComplete="given-name"
          placeholder="What should we call you?"
          value={firstName} onChange={set(setFirstName, 'firstName')} error={errors.firstName}
        />
        <Field
          label="Last name" name="lastName" autoComplete="family-name"
          placeholder="Your surname"
          value={lastName} onChange={set(setLastName, 'lastName')} error={errors.lastName}
        />
      </div>

      <Field
        label="Email" name="email" type="email" inputMode="email"
        autoComplete="email" placeholder="you@email.com"
        value={email} onChange={set(setEmail, 'email')} error={errors.email}
      />
      <Field
        label="Password · 8+ characters" name="password" type="password"
        autoComplete="new-password" placeholder="Make it a good one"
        value={password} onChange={set(setPassword, 'password')} error={errors.password}
      />

      <CheckRow
        className="auth-terms" large checked={agreed}
        onChange={(v) => { setAgreed(v); setErrors((e) => ({ ...e, terms: undefined })); }}
        error={errors.terms}
      >
        I&rsquo;m 18 or over and I agree to the <a href="/terms">terms</a> and{' '}
        <a href="/community-guidelines">safety rules</a>.
      </CheckRow>

      {/* Clerk smart-CAPTCHA mount point — required for custom sign-up flows. */}
      <div id="clerk-captcha" />

      {/* See LoginIsland: never clickable-but-dead while Clerk is loading. */}
      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled}>
        Create my account
      </Button>

      {SOCIAL_ENABLED && <Divider label="Ya phir" />}
      <SocialPair />

      <div className="auth-foot">
        <p className="auth-footline">
          Already with us?<a href="/sign-in">Log in</a>
        </p>
      </div>
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
