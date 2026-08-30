/* [BUY-OTP-1] Sign in with an email and a 6-digit code. No password field, ever.
 *
 * ── THE BUG THIS REPLACES ─────────────────────────────────────────────────────────
 * `GuestGate` in lib/clerk.tsx is broken, and has been since it was written. Its own
 * header states the contract it relies on:
 *
 *     "requireGuestAuth() resolves the guest_token (a valid `requireUser` JWT)."
 *
 * It is not. `guestCreate` (worker/src/routes/ladder.ts) mints `g1.<uid>.<exp>.<hmac>`,
 * an HMAC handle-reservation token whose own file header says "Guests NEVER pass
 * requireUser". `requireUser` (worker/src/authz.ts) calls `verifyClerk`, which only
 * accepts a Clerk RS256 JWT — grep `auth.ts` for "guest" or "g1." and there are ZERO
 * hits. So `GuestGate` posts that token to `/api/id/email/start` and
 * `/api/id/email/verify`, both of which call `requireUser`, and both return 401.
 *
 * `BookingFlow.tsx` awaits `requireGuestAuth()` before its pay step. **Web checkout
 * cannot complete for a new visitor today** — with or without Cashfree, and regardless
 * of anything else in this project.
 *
 * ── WHY CLERK'S OWN FLOW, NOT A FIXED GUEST TOKEN ─────────────────────────────────
 * Owner decision 2026-08-29: buyers get a real account via email OTP. avaTOK's auth IS
 * Clerk; Clerk owns credentials. The alternative — teaching `requireUser` to accept a
 * second token type — means a second identity in the paid lane and four more places to
 * get authorization wrong (see the deleted issues in the Phase 4 spec).
 *
 * NO PASSWORD FIELD. The owner's first instinct was username + password; hand-rolling
 * credential storage would be a serious security regression, and one fewer field at the
 * moment someone is deciding whether to pay is worth real money in completed checkouts.
 *
 * ── SIGN-UP vs SIGN-IN ────────────────────────────────────────────────────────────
 * We cannot know in advance whether an email already has an account, and asking is both
 * a wasted step and an account-enumeration oracle. So: try sign-UP first; when Clerk
 * says the identifier is taken, silently switch to sign-IN. The person types their email
 * once and gets one code either way.
 */
import { useState } from 'react';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';

export interface EmailCodeSignInProps {
  /** Called once a real Clerk session is active. */
  onAuthed: () => void;
  onCancel?: () => void;
  /** Explains what they are signing in for, e.g. "to get your ticket". */
  reason?: string;
}

type Mode = 'signUp' | 'signIn';

/** Clerk errors arrive as { errors: [{ code, message, longMessage }] }. */
function clerkErrors(e: unknown): { code: string; message: string }[] {
  const raw = (e as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    return { code: String(r.code ?? ''), message: String(r.longMessage ?? r.message ?? '') };
  });
}

function firstMessage(e: unknown, fallback: string): string {
  const msg = clerkErrors(e)[0]?.message;
  return msg && msg.trim() ? msg : fallback;
}

/** "This email already has an account" — the signal to switch to sign-in. */
function isAlreadyExists(e: unknown): boolean {
  return clerkErrors(e).some((x) =>
    x.code === 'form_identifier_exists' || x.code === 'identifier_already_signed_in');
}

export function EmailCodeSignIn({ onAuthed, onCancel, reason }: EmailCodeSignInProps) {
  const { isLoaded: signUpLoaded, signUp, setActive: setActiveSignUp } = useSignUp();
  const { isLoaded: signInLoaded, signIn, setActive: setActiveSignIn } = useSignIn();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [mode, setMode] = useState<Mode>('signUp');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = signUpLoaded && signInLoaded;
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  /** Start the sign-IN factor. Also the fallback when sign-up says the email exists. */
  async function startSignIn(addr: string) {
    if (!signIn) throw new Error('sign-in unavailable');
    const attempt = await signIn.create({ identifier: addr });
    const factor = attempt.supportedFirstFactors?.find(
      (f) => f.strategy === 'email_code',
    ) as { strategy: 'email_code'; emailAddressId: string } | undefined;
    if (!factor) throw new Error('email code not available for this account');
    await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
    setMode('signIn');
  }

  async function submitEmail() {
    if (!ready || busy || !emailValid) return;
    setBusy(true); setError(null);
    const addr = email.trim().toLowerCase();
    try {
      try {
        if (!signUp) throw new Error('sign-up unavailable');
        await signUp.create({ emailAddress: addr });
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setMode('signUp');
      } catch (e) {
        // Existing account: not an error, just the other half of the same flow.
        if (!isAlreadyExists(e)) throw e;
        await startSignIn(addr);
      }
      setStep('code');
    } catch (e) {
      setError(firstMessage(e, 'Could not send the code. Check the address and try again.'));
    } finally { setBusy(false); }
  }

  async function submitCode() {
    if (!ready || busy || code.trim().length < 4) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'signUp') {
        if (!signUp) throw new Error('sign-up unavailable');
        const res = await signUp.attemptEmailAddressVerification({ code: code.trim() });
        if (res.status !== 'complete' || !res.createdSessionId) {
          throw new Error('That code did not complete sign-up.');
        }
        await setActiveSignUp({ session: res.createdSessionId });
      } else {
        if (!signIn) throw new Error('sign-in unavailable');
        const res = await signIn.attemptFirstFactor({ strategy: 'email_code', code: code.trim() });
        if (res.status !== 'complete' || !res.createdSessionId) {
          throw new Error('That code did not complete sign-in.');
        }
        await setActiveSignIn({ session: res.createdSessionId });
      }
      // A real Clerk session now exists, so getActiveToken() returns a JWT that
      // requireUser accepts — which is the entire point of this component.
      onAuthed();
    } catch (e) {
      setError(firstMessage(e, 'That code did not work. Check it and try again.'));
    } finally { setBusy(false); }
  }

  async function resend() {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'signUp' && signUp) {
        await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      } else {
        await startSignIn(email.trim().toLowerCase());
      }
    } catch (e) {
      setError(firstMessage(e, 'Could not resend the code.'));
    } finally { setBusy(false); }
  }

  if (!ready) return <p className="font-body font-bold text-[14px] text-inkSoft">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display font-semibold text-[20px] text-ink">
          {step === 'email' ? 'Your email' : 'Enter the code'}
        </h2>
        <p className="mt-1 font-body font-bold text-[13px] text-inkSoft">
          {step === 'email'
            ? `We'll send a 6-digit code${reason ? ` ${reason}` : ''}. No password needed.`
            : `We sent a 6-digit code to ${email.trim().toLowerCase()}.`}
        </p>
      </div>

      {step === 'email' ? (
        <>
          <Field label="Email" type="email" inputMode="email" autoComplete="email"
            placeholder="you@example.com" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitEmail(); }} />
          {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}
          <Button variant="lime" label="Send code" loading={busy} disabled={!emailValid} onClick={submitEmail} />
        </>
      ) : (
        <>
          <Field label="Code" inputMode="numeric" autoComplete="one-time-code"
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitCode(); }} />
          {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}
          <Button variant="lime" label="Continue" loading={busy} disabled={code.trim().length < 4} onClick={submitCode} />
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => void resend()} disabled={busy}
              className="font-body font-bold text-[13px] text-blueInk underline disabled:opacity-50">
              Resend code
            </button>
            <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null); }}
              className="font-body font-bold text-[13px] text-inkSoft underline">
              Use a different email
            </button>
          </div>
        </>
      )}

      {onCancel && (
        <button type="button" onClick={onCancel} className="self-start font-body font-bold text-[13px] text-inkSoft underline">
          Cancel
        </button>
      )}
    </div>
  );
}

export default EmailCodeSignIn;
