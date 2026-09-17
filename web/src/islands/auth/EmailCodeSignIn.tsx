import { UiMessage } from "../../lib/i18n/react";
import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* [BUY-OTP-1] Sign in with an email and a 6-digit code, inside checkout.
 * No password field, ever.
 *
 * ── THE BUG THIS REPLACED ─────────────────────────────────────────────────────
 * `GuestGate` in lib/clerk.tsx was broken from the day it was written. Its header
 * claimed "requireGuestAuth() resolves the guest_token (a valid `requireUser`
 * JWT)". It does not: `guestCreate` (worker/src/routes/ladder.ts) mints
 * `g1.<uid>.<exp>.<hmac>`, an HMAC handle-reservation token whose own file header
 * says "Guests NEVER pass requireUser". So the guest token was posted to routes
 * that call `requireUser` and every one returned 401. Buyers got a real account
 * via email OTP instead — owner decision 2026-08-29.
 *
 * ── AND THE BUG *THAT* HID ────────────────────────────────────────────────────
 * [WEB-PWLESS-1 2026-09-06] The OTP replacement then failed for anybody who
 * ALREADY had an account. Reproduced on the live page: `POST /v1/client/sign_ups`
 * → 422 `form_identifier_exists`, so the flow fell back to sign-in;
 * `POST /v1/client/sign_ins` → 200 but `supported_first_factors` was only
 * `["reset_password_email_code"]`. No `email_code`. The fallback threw a bare
 * `Error`, which carries no `errors[]`, so the UI printed its generic fallback:
 *
 *     "Could not send the code. Check the address and try again."
 *
 * The address was never the problem. **"Sign-in with email → Email verification
 * code" was switched OFF on the Clerk instance** — `first_factors: []` in
 * /v1/environment — and no client code could have fixed it. A new email sailed
 * through (sign-up verification was enabled), so the failure looked
 * account-specific and random. It is now on, and the whole flow lives in
 * ./passwordless.ts, shared with /sign-in so the two cannot drift again.
 *
 * ── SIGN-UP vs SIGN-IN ────────────────────────────────────────────────────────
 * We never ask whether the email has an account: asking is a wasted step at the
 * exact moment someone is deciding whether to pay, and an account-enumeration
 * oracle. Try sign-up, fall back to sign-in. One email box, one code, either way.
 */
import { useState } from 'react';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { capture } from '../../lib/analytics';
import { useFormReady } from './AuthKit';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import {
  sendPasswordlessCode, verifyPasswordlessCode, pwlError,
  type PwlMode, type PwlSignIn, type PwlSignUp,
} from './passwordless';

export interface EmailCodeSignInProps {
  /** Called once a real Clerk session is active. */
  onAuthed: () => void;
  onCancel?: () => void;
  /** Explains what they are signing in for, e.g. "to get your ticket". */
  reason?: string;
}

export function EmailCodeSignIn({ onAuthed, onCancel, reason }: EmailCodeSignInProps) {
  const {t:uiT}=useUiTranslation("web-auth");

  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [mode, setMode] = useState<PwlMode>('signUp');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = signUpLoaded && signInLoaded;
  useFormReady(ready, 'checkout');
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  const resources = () => ({
    signUp: signUp as unknown as PwlSignUp,
    signIn: signIn as unknown as PwlSignIn,
  });

  async function submitEmail() {
    if (!ready || busy || !emailValid) return;
    setBusy(true); setError(null);
    try {
      const m = await sendPasswordlessCode({
        ...resources(),
        email,
        extra: { unsafeMetadata: { signedUpVia: 'web_checkout' } },
      });
      setMode(m);
      setStep('code');
      capture('auth_code_sent', { surface: 'checkout', mode: m });
    } catch (e) {
      // [WEB-PWLESS-1] The failure now says what it is. The old generic line sent
      // the owner looking at an email address that was never wrong, and cost a
      // debugging session before anybody looked at the instance settings.
      const { message, reason: why } = pwlError(e, 'We couldn’t email a code just now. Please try again.');
      setError(message);
      capture('auth_code_sent', { surface: 'checkout', outcome: 'error', reason: why });
    } finally { setBusy(false); }
  }

  async function submitCode() {
    if (!ready || busy || code.trim().length < 4) return;
    setBusy(true); setError(null);
    try {
      await verifyPasswordlessCode({
        mode,
        ...resources(),
        setActive: setActive as unknown as (p: { session: string }) => Promise<unknown>,
        code,
      });
      // A real Clerk session now exists, so getActiveToken() returns a JWT that
      // requireUser accepts — which is the entire point of this component. And
      // for a new buyer the avaTOK `users` row and AvaTOK number now exist too
      // (verifyPasswordlessCode bootstraps), so the same person can sign in to
      // the app later and find their booking.
      capture('auth_signin_result', { method: 'email_code', surface: 'checkout', outcome: 'ok' });
      onAuthed();
    } catch (e) {
      const { message, reason: why } = pwlError(e, 'That code didn’t work. Check it and try again.');
      setError(message);
      capture('auth_signin_result', {
        method: 'email_code', surface: 'checkout', outcome: 'error', reason: why,
      });
    } finally { setBusy(false); }
  }

  async function resend() {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      setMode(await sendPasswordlessCode({ ...resources(), email }));
    } catch (e) {
      setError(pwlError(e, 'Could not resend the code.').message);
    } finally { setBusy(false); }
  }

  if (!ready) return <p className="font-body font-bold text-[14px] text-inkSoft"><UiText id="web-auth.ba3bbbe10d8bef66" source="Loading…" /></p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-display font-semibold text-[20px] text-ink">
          {step === 'email' ? uiT("web-auth.33fe95ce02091218","Your email") : uiT("web-auth.b0ed70c457e2eeee","Enter the code")}
        </h2>
        <p className="mt-1 font-body font-bold text-[13px] text-inkSoft">
          {step === 'email'
            ? uiT("web-auth.78608c3779b384a9","We'll send a 6-digit code{value0}. No password needed.",{value0:String(reason ? ` ${reason}` : '')})
            : uiT("web-auth.38469a011eff44a0","We sent a 6-digit code to {value0}.",{value0:String(email.trim().toLowerCase())})}
        </p>
      </div>

      {step === 'email' ? (
        <>
          <Field label={uiT("web-auth.969ccbd3cf6300ec","Email")} type="email" inputMode="email" autoComplete="email"
            placeholder={uiT("web-auth.53e6cdc30765aade","you@example.com")} value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitEmail(); }} />
          {error && <p className="font-body font-bold text-[14px] text-coral">⚠ <UiMessage namespace="web-auth" value={error} /></p>}
          {/* Clerk smart-CAPTCHA mount point — `captcha_enabled` is on and this
              form can create an account. Without id="clerk-captcha" Clerk falls
              back to an invisible challenge and can reject the attempt. */}
          <div id="clerk-captcha" />
          <Button variant="lime" label={uiT("web-auth.66a5b4090d14cb41","Send code")} loading={busy} disabled={!emailValid} onClick={submitEmail} />
        </>
      ) : (
        <>
          <Field label={uiT("web-auth.340f463033e0fd5d","Code")} inputMode="numeric" autoComplete="one-time-code"
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitCode(); }} />
          {error && <p className="font-body font-bold text-[14px] text-coral">⚠ <UiMessage namespace="web-auth" value={error} /></p>}
          <Button variant="lime" label={uiT("web-auth.31fbef162594de01","Continue")} loading={busy} disabled={code.trim().length < 4} onClick={submitCode} />
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => void resend()} disabled={busy}
              className="font-body font-bold text-[13px] text-blueInk underline disabled:opacity-50"><UiText id="web-auth.b97457409ab5b375" source="Resend code" />{" "}</button>
            <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null); }}
              className="font-body font-bold text-[13px] text-inkSoft underline"><UiText id="web-auth.b7337027ef1f69f1" source="Use a different email" />{" "}</button>
          </div>
        </>
      )}

      {onCancel && (
        <button type="button" onClick={onCancel} className="self-start font-body font-bold text-[13px] text-inkSoft underline"><UiText id="web-auth.19766ed6ccb2f4a3" source="Cancel" />{" "}</button>
      )}
    </div>
  );
}

export default EmailCodeSignIn;
