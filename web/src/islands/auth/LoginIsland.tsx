/* /sign-in — avaTOK log in.
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Custom Clerk flow via `useSignIn()`, NOT the
 * prebuilt <SignIn/> component. The design is a bespoke form (truck-art palette,
 * Silkscreen labels, solid ink shadows) that Clerk's drop-in cannot be themed
 * to, so we drive the API directly.
 *
 * [WEB-AUTH-FACTORS-1 2026-08-26] A password submit does NOT always come back
 * `complete`. Verified against the live instance: the owner's own account
 * returns `needs_first_factor` and advertises three strategies —
 *
 *     password · email_code · reset_password_email_code
 *
 * The first build treated anything that wasn't `complete` as an unsupported
 * dead end and told the user "this account needs an extra verification step
 * that isn't set up here yet", which stranded them on a page with nowhere to
 * go. Clerk was in fact offering a perfectly good route: email a code.
 *
 * So the flow now has these stages:
 *   1. password  -> complete                                    -> done
 *   2. password  -> needs_first_factor -> ATTEMPT PASSWORD FACTOR -> done
 *   3. only if that fails -> email a 6-digit code               -> complete
 * and `needs_second_factor` is handled too (currently no second factors are
 * enabled, but an account-level TOTP would otherwise strand the user again).
 *
 * [WEB-AUTH-PASSWORD-FIRST-1 2026-08-28] Stage 2 is new and it matters. Without
 * it, `needs_first_factor` went STRAIGHT to the emailed code, which meant a
 * correct password was never attempted and every single sign-in on this
 * instance turned into an OTP sign-in. `password` is in the offered first-factor
 * list; it just was not being used. See the block in `advance()`.
 *
 * The rule this encodes: never leave the user on a screen with no next action.
 */
import { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import {
  Field, Button, CheckRow, Divider, SocialPair, SOCIAL_ENABLED, CodeStep,
  validateEmail, validatePassword, clerkError, useClerkStalled, STALLED_MESSAGE,
  type FieldErrors,
} from './AuthKit';

/** Where to land after a successful sign-in. Honours ?next=/some/path. */
function nextUrl(): string {
  try {
    const n = new URLSearchParams(location.search).get('next');
    if (n && n.startsWith('/')) return n;
  } catch { /* SSR */ }
  return '/marketplace';
}

type Stage = 'password' | 'code';

/*
 * Minimal structural types for the bits of Clerk's sign-in resource we read.
 * `@clerk/types` is not a dependency of this project (only @clerk/clerk-react
 * is), so importing SignInResource from it fails to resolve. These describe
 * exactly the fields used below and nothing more — narrow enough that a Clerk
 * upgrade changing an unrelated field cannot silently break the build.
 */
interface Factor {
  strategy: string;
  emailAddressId?: string;
  phoneNumberId?: string;
}
interface SignInLike {
  status: string | null;
  createdSessionId: string | null;
  supportedFirstFactors?: Factor[] | null;
  supportedSecondFactors?: Factor[] | null;
}

/** Find a factor by strategy that also carries the id the prepare call needs. */
function factorWithId(
  factors: Factor[] | null | undefined,
  strategy: string,
  idKey: 'emailAddressId' | 'phoneNumberId',
): string | undefined {
  const f = factors?.find((x) => x.strategy === strategy && x[idKey]);
  return f?.[idKey];
}

function Inner() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [stage, setStage] = useState<Stage>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepMeIn, setKeepMeIn] = useState(true); // README: checked by default
  const [code, setCode] = useState('');
  const [codeKind, setCodeKind] = useState<'first' | 'second'>('first');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  const stalled = useClerkStalled(isLoaded);

  function set<T>(setter: (v: T) => void, key: string) {
    return (v: T) => {
      setter(v);
      // README §Validation: editing a field clears that field's error.
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    };
  }

  async function finish(res: SignInLike) {
    await setActive!({ session: res.createdSessionId });
    location.href = nextUrl();
  }

  /**
   * Decide what to do with a non-complete sign-in. Returns true when it has
   * moved the user somewhere useful, false when there is genuinely no route.
   */
  async function advance(res: SignInLike): Promise<boolean> {
    if (!signIn) return false;

    if (res.status === 'needs_first_factor') {
      // [WEB-AUTH-PASSWORD-FIRST-1 2026-08-28] TRY THE PASSWORD BEFORE EMAILING
      // A CODE. This is the fix for "why am I always asked for a 6-digit code
      // even though I typed the right password".
      //
      // `signIn.create({ identifier, password })` does not always CONSUME the
      // password. When it comes back `needs_first_factor` it is saying "I still
      // need a first factor, and here are the strategies you may use" — and on
      // this instance that list INCLUDES `password` (see the header note: the
      // owner's own account advertises password · email_code ·
      // reset_password_email_code). The previous code read that status as
      // "password didn't work" and jumped straight to email_code, so a correct
      // password was never actually attempted and EVERY sign-in became an OTP
      // sign-in.
      //
      // Attempting the password factor explicitly, with the password the person
      // already typed, is the intended Clerk call for this state. It is not a
      // bypass of anything: a wrong password still fails here, and if the
      // instance genuinely requires a second factor Clerk returns
      // needs_second_factor and the block below handles it.
      const passwordOffered = res.supportedFirstFactors?.some((f) => f.strategy === 'password');
      if (passwordOffered && password) {
        try {
          const pw = (await signIn.attemptFirstFactor({
            strategy: 'password', password,
          })) as unknown as SignInLike;
          if (pw.status === 'complete' && pw.createdSessionId) { await finish(pw); return true; }
          // Not complete, but possibly moved on to a second factor.
          if (pw.status === 'needs_second_factor') return await advance(pw);
        } catch {
          // A genuinely wrong password lands here. Fall through to email_code so
          // the person still has a way in — the rule this file already encodes:
          // never leave the user on a screen with no next action.
        }
      }

      let emailAddressId = factorWithId(res.supportedFirstFactors, 'email_code', 'emailAddressId');

      // [WEB-AUTH-CODE-2 2026-08-26] THE BUG BEHIND "we can't finish signing in
      // here". A create() carrying a password that does not complete comes back
      // WITHOUT `supportedFirstFactors` populated — Clerk only fills that list
      // on the identifier-only call. So the lookup above found nothing and the
      // flow dead-ended, even though the account plainly supports email_code
      // (confirmed by probing the live instance identifier-only).
      //
      // Re-asking with the identifier alone returns the factor list. It costs
      // one extra request on a path that was previously a dead end.
      if (!emailAddressId) {
        const relisted = await signIn.create({ identifier: email.trim() });
        emailAddressId = factorWithId(
          relisted.supportedFirstFactors as Factor[] | null | undefined,
          'email_code', 'emailAddressId',
        );
      }

      if (emailAddressId) {
        await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId });
        setCodeKind('first');
        setStage('code');
        return true;
      }
      return false;
    }

    if (res.status === 'needs_second_factor') {
      if (res.supportedSecondFactors?.some((f) => f.strategy === 'totp')) {
        // An authenticator app supplies the code; nothing to prepare.
        setCodeKind('second');
        setStage('code');
        return true;
      }
      const phoneNumberId = factorWithId(res.supportedSecondFactors, 'phone_code', 'phoneNumberId');
      if (phoneNumberId) {
        await signIn.prepareSecondFactor({ strategy: 'phone_code', phoneNumberId });
        setCodeKind('second');
        setStage('code');
        return true;
      }
      return false;
    }

    if (res.status === 'needs_new_password') {
      location.href = '/forgot-password';
      return true;
    }

    return false;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !setActive || submitting) return;

    const next: FieldErrors = {
      email: validateEmail(email),
      password: validatePassword(password),
    };
    setErrors(next);
    if (next.email || next.password) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await signIn.create({ identifier: email.trim(), password });
      if (res.status === 'complete' && res.createdSessionId) { await finish(res); return; }

      // Logged, not shown: the status means nothing to the person reading it,
      // but it is the one fact needed to diagnose this, and the web client has
      // no PostHog to send it to.
      console.warn('[avatok] sign-in did not complete on password', {
        status: res.status,
        createdSessionId: res.createdSessionId,
        firstFactors: res.supportedFirstFactors?.map((f: Factor) => f.strategy) ?? null,
        secondFactors: res.supportedSecondFactors?.map((f: Factor) => f.strategy) ?? null,
      });

      if (await advance(res)) return;

      // [WEB-AUTH-CODE-2] Last resort: whatever the status was, try the emailed
      // code. Getting the person in matters more than classifying why the
      // password path stopped, and this route depends on none of it. Only if
      // THIS also fails is there genuinely nothing left to offer.
      if (await sendEmailCode()) return;
      setFormError('We couldn’t sign you in or email you a code. Please check the email address, or use “Forgot password”.');
    } catch (err) {
      setFormError(clerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !setActive || submitting) return;
    if (code.trim().length < 6) {
      setErrors({ code: 'Enter the 6-digit code.' });
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = codeKind === 'first'
        ? await signIn.attemptFirstFactor({ strategy: 'email_code', code: code.trim() })
        : await signIn.attemptSecondFactor({ strategy: 'totp', code: code.trim() });
      if (res.status === 'complete') { await finish(res); return; }
      setFormError('That code didn’t complete sign-in. Please try again.');
    } catch (err) {
      setFormError(clerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Sign in with an emailed code and NO password.
   *
   * [WEB-AUTH-CODE-1 2026-08-26] This is a first-class route, not a fallback.
   * The password path can fail in ways the browser cannot fix — a password that
   * was never set, one Clerk rejects as breached (`enforce_hibp_on_sign_in` is
   * on for this instance), or a status we don't recognise. Any of those used to
   * mean no way in at all. `email_code` is offered by Clerk for these accounts
   * (verified live) and depends on none of it.
   */
  /**
   * Ask Clerk to email a 6-digit code and move to the code screen.
   * Returns false when this account can't be reached that way.
   * Throws nothing — callers treat false as "offer something else".
   */
  async function sendEmailCode(): Promise<boolean> {
    if (!signIn) return false;
    try {
      const res = await signIn.create({ identifier: email.trim() });
      const emailAddressId = factorWithId(
        res.supportedFirstFactors as Factor[] | null | undefined,
        'email_code', 'emailAddressId',
      );
      if (!emailAddressId) return false;
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId });
      setCodeKind('first');
      setStage('code');
      return true;
    } catch {
      return false;
    }
  }

  async function emailCodeInstead() {
    if (!isLoaded || !signIn || submitting) return;
    const err = validateEmail(email);
    if (err) { setErrors((e) => ({ ...e, email: err })); return; }

    setSubmitting(true);
    setFormError(null);
    try {
      if (!(await sendEmailCode())) {
        setFormError('We can’t email a code to that address. Check the email and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    if (!isLoaded || !signIn || codeKind !== 'first') return;
    try {
      const emailAddressId = factorWithId(
        signIn.supportedFirstFactors as Factor[] | null | undefined,
        'email_code', 'emailAddressId',
      );
      if (!emailAddressId) return;
      await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId });
      setResent(true);
    } catch (err) {
      setFormError(clerkError(err));
    }
  }

  if (stage === 'code') {
    return (
      <CodeStep
        eyebrow="One last check"
        heading={<>Check your<br />email</>}
        sentTo={email}
        code={code}
        onCode={set(setCode, 'code')}
        error={errors.code}
        formError={formError}
        submitting={submitting}
        onSubmit={onCodeSubmit}
        onResend={codeKind === 'first' ? resend : undefined}
        resent={resent}
        cta="Verify and log in"
      />
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
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
      <Field
        label="Password" name="password" type="password"
        autoComplete="current-password" placeholder="Your password"
        value={password} onChange={set(setPassword, 'password')} error={errors.password}
      />

      <div className="auth-row">
        <CheckRow checked={keepMeIn} onChange={setKeepMeIn}>Keep me in</CheckRow>
        <a className="auth-forgot" href="/forgot-password">Forgot password</a>
      </div>

      {/* Never clickable-but-dead: while Clerk is still loading the button shows
          its loading state, and if loading fails the message above explains it. */}
      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled}>
        Log in
      </Button>

      <Divider label="Ya phir" />

      {/* Password-free way in. Always visible — a person who has forgotten
          whether they ever set a password shouldn't have to fail first. */}
      <Button variant="ghost" onClick={() => void emailCodeInstead()} disabled={stalled || submitting}>
        Email me a code instead
      </Button>

      <SocialPair />

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
