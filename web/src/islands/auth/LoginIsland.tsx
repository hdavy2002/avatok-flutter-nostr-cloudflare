/* /sign-in — avaTOK log in.
 *
 * [WEB-AUTH-DESIGN-1 2026-08-26] Custom Clerk flow via `useSignIn()`, NOT the
 * prebuilt <SignIn/> component that used to live here. The design is a bespoke
 * form (truck-art palette, Silkscreen labels, solid ink shadows) and Clerk's
 * drop-in cannot be themed that far, so we drive the API directly.
 *
 * The flow is deliberately the simplest Clerk supports:
 *   signIn.create({ identifier, password })  ->  status 'complete'  ->  setActive
 * The live instance has second_factor.required = false and email_address as the
 * only first factor (verified against the public Clerk environment endpoint), so
 * there is no MFA branch to handle. If MFA is ever switched on, `status` comes
 * back as 'needs_second_factor' and lands in the explicit fallback below rather
 * than silently doing nothing.
 */
import { useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import {
  Field, Button, CheckRow, Divider, SocialPair, SOCIAL_ENABLED,
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

function Inner() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keepMeIn, setKeepMeIn] = useState(true); // README: checked by default
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stalled = useClerkStalled(isLoaded);

  function set<T>(setter: (v: T) => void, key: string) {
    return (v: T) => {
      setter(v);
      // README §Validation: editing a field clears that field's error.
      setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;

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
      if (res.status === 'complete') {
        await setActive({ session: res.createdSessionId });
        location.href = nextUrl();
        return;
      }
      // Not complete and not an error — only reachable if MFA or another
      // factor gets enabled later. Say so plainly instead of hanging.
      setFormError('This account needs an extra verification step that isn’t set up here yet.');
    } catch (err) {
      setFormError(clerkError(err));
    } finally {
      setSubmitting(false);
    }
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

      {SOCIAL_ENABLED && <Divider label="Ya phir" />}
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

/**
 * Clerk is loaded lazily, so the form would otherwise pop in. We render the
 * static chrome immediately and only the form waits — the page never looks empty.
 */
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
