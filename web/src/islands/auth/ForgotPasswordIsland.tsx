/* /forgot-password — password reset.
 *
 * [WEB-AUTH-FACTORS-1 2026-08-26] The log-in screen has always shown a "FORGOT
 * PASSWORD" link (README §1) but there was no page behind it — the link 404'd.
 * This is that page.
 *
 * Clerk models a reset as a sign-in attempt using the
 * `reset_password_email_code` first factor, which the live instance advertises
 * for the accounts checked:
 *
 *   1. signIn.create({ identifier })                    -> find the factor
 *   2. prepareFirstFactor({ strategy, emailAddressId }) -> emails a code
 *   3. attemptFirstFactor({ strategy, code, password }) -> sets the new password
 *      and returns `complete`, signing the user straight in.
 *
 * Step 3 sets the password and authenticates in one call, so there is no
 * separate "now log in again" step — the user lands signed in.
 *
 * PRIVACY: step 1 tells us whether an account exists. We deliberately do NOT
 * surface that. An unknown address gets the same "we sent a code" screen as a
 * real one, so this page cannot be used to test which emails have accounts.
 */
import { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import {
  Field, Button, CodeStep, validateEmail, validatePassword, clerkError,
  useClerkStalled, STALLED_MESSAGE, type FieldErrors,
} from './AuthKit';

function Inner() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [stage, setStage] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  /** False when no reset factor exists — the code screen is then a decoy. */
  const [live, setLive] = useState(true);
  const stalled = useClerkStalled(isLoaded);

  function set<T>(setter: (v: T) => void, key: string) {
    return (v: T) => {
      setter(v);
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    };
  }

  async function sendCode(): Promise<boolean> {
    if (!signIn) return false;
    const res = await signIn.create({ identifier: email.trim() });
    const factor = (res.supportedFirstFactors ?? []).find(
      (f) => f.strategy === 'reset_password_email_code' && 'emailAddressId' in f,
    ) as { emailAddressId?: string } | undefined;
    if (!factor?.emailAddressId) return false;
    await signIn.prepareFirstFactor({
      strategy: 'reset_password_email_code',
      emailAddressId: factor.emailAddressId,
    });
    return true;
  }

  async function onRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !setActive || submitting) return;
    const err = validateEmail(email);
    setErrors({ email: err });
    if (err) return;

    setSubmitting(true);
    setFormError(null);
    try {
      setLive(await sendCode());
    } catch {
      // An unknown address throws here. Swallow it on purpose — see PRIVACY.
      setLive(false);
    } finally {
      setStage('reset');
      setSubmitting(false);
    }
  }

  async function onReset(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signIn || !setActive || submitting) return;

    const next: FieldErrors = {
      code: code.trim().length < 6 ? 'Enter the 6-digit code.' : undefined,
      password: validatePassword(password),
    };
    setErrors(next);
    if (next.code || next.password) return;

    if (!live) {
      setFormError('That code didn’t work. Check the code and try again.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code: code.trim(),
        password,
      });
      if (res.status === 'complete') {
        await setActive!({ session: res.createdSessionId });
        location.href = '/marketplace';
        return;
      }
      setFormError('Your password was not reset. Please try again.');
    } catch (err) {
      setFormError(clerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    if (!isLoaded || !live) { setResent(true); return; }
    try {
      await sendCode();
      setResent(true);
    } catch (err) {
      setFormError(clerkError(err));
    }
  }

  if (stage === 'reset') {
    return (
      <CodeStep
        eyebrow="Almost there"
        heading={<>Set a new<br />password</>}
        sentTo={email}
        code={code}
        onCode={set(setCode, 'code')}
        error={errors.code}
        formError={formError}
        submitting={submitting}
        onSubmit={onReset}
        onResend={() => void resend()}
        resent={resent}
        cta="Reset password"
      >
        <Field
          label="New password · 8+ characters" name="password" type="password"
          autoComplete="new-password" placeholder="Make it a good one"
          value={password} onChange={set(setPassword, 'password')} error={errors.password}
        />
      </CodeStep>
    );
  }

  return (
    <form className="auth-form" onSubmit={onRequest} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow">It happens</p>
        <h1 className="auth-h2">Forgot your<br />password?</h1>
      </div>

      <p className="auth-footline" style={{ textAlign: 'left' }}>
        Give us the email you signed up with and we&rsquo;ll send a code to reset it.
      </p>

      {(formError || stalled) && (
        <p className="auth-formerr" role="alert">{formError ?? STALLED_MESSAGE}</p>
      )}

      <Field
        label="Email" name="email" type="email" inputMode="email"
        autoComplete="email" placeholder="you@email.com"
        value={email} onChange={set(setEmail, 'email')} error={errors.email}
      />

      <Button type="submit" loading={submitting || (!isLoaded && !stalled)} disabled={stalled}>
        Send reset code
      </Button>

      <div className="auth-foot">
        <p className="auth-footline">
          Remembered it?<a href="/sign-in">Log in</a>
        </p>
      </div>
    </form>
  );
}

export function ForgotPasswordIsland() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="auth-form">
        <p className="auth-formerr">
          Password reset isn’t configured on this build. Set PUBLIC_CLERK_PUBLISHABLE_KEY.
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

export default ForgotPasswordIsland;
