
import { UiMessage } from "../../lib/i18n/react";
import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* /sign-in — log in with a WhatsApp code, or with Google.
 *
 * [HF-AUTH-GOOGLE-BACK-1 2026-10-25, owner] Google is back (below the WhatsApp form). A Google sign-in still passes the
 * WhatsApp gate (/sign-up?finish=1) so a number gets verified. /sign-in?google=1 starts Google immediately.
 *
 * [HF-AUTH-WA-ONLY-1 2026-10-24, owner decision] Email codes and Google are gone
 * from sign-in. A person types their WhatsApp number, gets a 6-digit code on
 * WhatsApp, and is in. The Worker redeems the code into a Clerk ticket
 * (routes/whatsapp_auth.ts) and redeemWhatsAppTicket turns that into a session.
 *
 * A number with no account answers status "no_account" (the website never creates
 * an account from this page): we say so and point at /sign-up. Accounts are only
 * made on /sign-up, where the email is proven as well.
 *
 * Custom Clerk flow, NOT the prebuilt <SignIn/> component: the design is a bespoke
 * form that Clerk's drop-in cannot be themed to.
 */
import { useEffect, useRef, useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { capture } from '../../lib/analytics';
import { postLoginTarget, isFreeWatchTarget } from '../../lib/authRedirect';
import {
  Field, Button, CheckRow, Divider, GoogleButton,
  useFormReady, useClerkStalled, useRedirectIfSignedIn, STALLED_MESSAGE,
} from './AuthKit';
import { finishUrl, continueWithGoogle, pwlError, type PwlSignIn } from './passwordless';
import {
  sendWhatsAppCode, verifyWhatsAppCode, redeemWhatsAppTicket, waApiMessage, confirmAge18,
} from './whatsappAuth';
import { WhatsAppNumberInput } from './WhatsAppNumberInput';
import { getActiveTokenWaited } from '../../lib/clerk';
import { DEFAULT_COUNTRY, toE164 } from '../../lib/countries';

/** Where to land after a successful sign-in. Honours ?redirect_url= / ?next= (same-origin only).
 * [DASH2-FOUNDATION 2026-09-25] ALWAYS /dashboard unless the visitor was sent here from a specific page.
 * lib/authRedirect.ts also closes the `next=//evil.example` open redirect. */
function nextUrl(): string {
  return postLoginTarget();
}

/** Where a finished sign-in goes: through the WhatsApp gate (finishUrl) unless it is a free-event watch return. */
function afterSignInUrl(): string {
  const next = nextUrl();
  return isFreeWatchTarget(next) ? next : finishUrl(next);
}

/** [HF-SIGNIN-SPEED-1] Where a WhatsApp-code sign-in lands. The number was just proven by the code and the Worker only
 * mints a ticket for an account whose WhatsApp number is verified (routes/whatsapp_auth.ts verifiedAccountForPhone), so
 * the phone gate (/sign-up?finish=1: a whole extra page load + Clerk load + /api/account/phone/status) would always
 * pass straight through. Go directly to the destination. Google (no number proven) keeps afterSignInUrl(). */
function afterWhatsAppSignInUrl(): string {
  return nextUrl();
}

/** /sign-up, carrying the page the visitor was headed for. */
function signUpHref(): string {
  const n = nextUrl();
  return n && n !== '/dashboard' ? `/sign-up?next=${encodeURIComponent(n)}` : '/sign-up';
}

function Inner() {
  const {t:uiT}=useUiTranslation("web-auth");

  const { isLoaded, signIn, setActive } = useSignIn();
  // [HF-SIGNIN-SPEED-1] Latest Clerk handles, so a submit made before clerk-js finished loading can wait for it.
  const clerkRef = useRef({ isLoaded, signIn, setActive });
  clerkRef.current = { isLoaded, signIn, setActive };
  /** Resolves once Clerk is loaded (or after `ms`, then redeem reports its own "still loading" error). */
  async function clerkReady(ms = 10000) {
    const t0 = Date.now();
    while (!clerkRef.current.isLoaded && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
    return clerkRef.current;
  }

  const [waStage, setWaStage] = useState<'number' | 'code' | 'age' | 'no_account'>('number');
  // [HF-AUTH-WA-1] A phone-only account made by the app holds its ticket here until the 18+ tick is given.
  const [waTicket, setWaTicket] = useState<string | null>(null);
  const [waAgree, setWaAgree] = useState(false);
  const [waCountry, setWaCountry] = useState(DEFAULT_COUNTRY.code);
  const [waNational, setWaNational] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waResendAt, setWaResendAt] = useState(0);
  const [waPhoneMasked, setWaPhoneMasked] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const stalled = useClerkStalled(isLoaded);
  // Already signed in? Go where they were headed. Nothing on this form can succeed for them.
  const finishingRef = useRef(false); // holds the auto-redirect while we finish sign-in ourselves
  const leaving = useRedirectIfSignedIn(nextUrl, finishingRef);
  useFormReady(isLoaded && !leaving, 'sign_in');

  /** [HF-AUTH-GOOGLE-BACK-1] Hand off to Google; the return goes through the WhatsApp gate (finishUrl) via afterSignInUrl(). */
  async function google(surface = 'sign_in') {
    if (!isLoaded || submitting) return;
    setFormError(null);
    try {
      capture('login_method_chosen', { method: 'google', surface });
      await continueWithGoogle(signIn as unknown as PwlSignIn, afterSignInUrl());
    } catch (err) {
      setFormError(pwlError(err, 'Couldn’t open Google sign-in. Please try again.').message);
    }
  }

  // [HF-AUTH-GOOGLE-BACK-1] /sign-in?google=1 (the Explore sign-in card) starts Google at once, honouring ?redirect_url=.
  const autoGoogleRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || leaving || autoGoogleRef.current) return;
    let want = false;
    try { want = new URLSearchParams(location.search).get('google') === '1'; } catch { /* */ }
    if (!want) return;
    autoGoogleRef.current = true;
    void google('explore_card');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, leaving]);

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
      if (r.status === 'signed_in' && r.needs18Plus) {
        setWaTicket(r.ticket);
        setWaStage('age');
        return;
      }
      if (r.status === 'signed_in') {
        finishingRef.current = true;
        const c = await clerkReady();
        await redeemWhatsAppTicket(c.signIn as unknown as PwlSignIn, c.setActive, r.ticket);
        capture('auth_signin_result', { method: 'whatsapp_code', outcome: 'ok' });
        location.href = afterWhatsAppSignInUrl();
        return;
      }
      // no_account (or, from an old Worker, needs_email): this number has no account yet.
      capture('auth_signin_result', { method: 'whatsapp_code', outcome: 'no_account' });
      setWaStage('no_account');
    } catch (err) {
      finishingRef.current = false;
      setFormError(waApiMessage(err, 'That code didn’t work. Check it and try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  /** The 18+ tick for an app-made phone-only account: open the session, record the tick, go. */
  async function confirmWaAge() {
    if (submitting || !waTicket) return;
    if (!waAgree) { setFormError('Please confirm that you are 18 or over to continue.'); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      finishingRef.current = true;
      const c = await clerkReady();
      await redeemWhatsAppTicket(c.signIn as unknown as PwlSignIn, c.setActive, waTicket);
      const token = await getActiveTokenWaited();
      if (!token) throw new Error('no_token');
      await confirmAge18(token);
      location.href = afterWhatsAppSignInUrl();
    } catch (err) {
      finishingRef.current = false;
      setFormError(waApiMessage(err, 'We couldn’t finish that. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (leaving) {
    return <p className="auth-footline"><UiText id="web-auth.85a4acfc80f40e78" source="You’re already signed in — taking you through…" /></p>;
  }

  if (waStage === 'no_account') {
    return (
      <div className="auth-form">
        <div className="auth-desktop-head">
          <p className="auth-eyebrow">No account yet</p>
          <h1 className="auth-h2">We don’t know this number</h1>
        </div>
        <p className="auth-hint">There is no account for <strong>{waPhoneMasked}</strong>. Create one first — it takes two minutes.</p>
        <a className="auth-btn auth-btn--ink" href={signUpHref()}>Create an account</a>
        <div className="auth-foot">
          <p className="auth-footline">
            <a href="#again" onClick={(ev) => { ev.preventDefault(); setWaStage('number'); setWaCode(''); setFormError(null); }}>Try a different number</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void (waStage === 'number' ? sendWa() : waStage === 'age' ? confirmWaAge() : verifyWa()); }} noValidate>
      <div className="auth-desktop-head">
        <p className="auth-eyebrow"><UiText id="web-auth.6621249514b7887c" source="Welcome back" /></p>
        <h1 className="auth-h2">Good to see you</h1>
      </div>
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
          <p className="auth-hint">We’ll send a 6-digit code on WhatsApp to log you in. No password.</p>
          {/* [HF-SIGNIN-SPEED-1] Sending the code is a plain Worker call (no Clerk), so it no longer waits for clerk-js. Clerk
              finishes loading while the person types their code; verifyWa waits for it before redeeming the ticket. */}
          <Button type="submit" loading={submitting}>Send code on WhatsApp</Button>
        </>
      )}
      {waStage === 'age' && (
        <>
          <CheckRow className="auth-terms" large checked={waAgree} onChange={setWaAgree}>
            I’m 18 or over and I agree to the <a href="/terms">terms</a> and <a href="/community-guidelines">safety rules</a>.
          </CheckRow>
          <Button type="submit" loading={submitting}>Continue</Button>
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
      {waStage === 'number' && (
        <>
          <Divider label={uiT("web-auth.4aec6108de24a9f0","Or")} />
          <GoogleButton onClick={() => void google()} disabled={!isLoaded || stalled || submitting} />
        </>
      )}
      <div className="auth-foot">
        <p className="auth-footline"><UiText id="web-auth.38c1c4457cd164cc" source="New here?" /><a href={signUpHref()}><UiText id="web-auth.86033f75a4c0876a" source="Create an account" /></a>
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
