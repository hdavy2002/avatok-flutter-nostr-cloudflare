/* [SAATHUM-CHECKOUT-UI 2026-09-26, updated WA-WEB-1 2026-09-28] Step 1 — "You".
 * Reuses the SAME building blocks as the rest of the site rather than
 * inventing new auth code:
 *   - sign-in: <EmailCodeSignIn> (email + 6-digit code, no password) or the
 *     new WhatsApp-as-login flow (islands/auth/whatsappAuth.ts), same choice
 *     as /sign-in and /sign-up.
 *   - WhatsApp verification for an already-signed-in account: sendPhoneCode/
 *     verifyPhoneCode from islands/auth/passwordless.ts (the authed
 *     /api/account/phone/{send,verify} routes, which now accept any
 *     international +<E.164>), through the shared WhatsAppNumberInput.
 * A signed-in account whose WhatsApp number is already verified skips this
 * step entirely (SaathumCheckout decides that before rendering it).
 *
 * [WA-WEB-1 2026-09-28, owner decision] Every signed-in user needs a verified
 * WhatsApp number — the old "Skip for now" button is gone. International
 * numbers are allowed via the shared country picker.
 *
 * [SAATHUM-EVENT-TYPES 2026-09-27] Copy says "email" for the live link only
 * (no WhatsApp/SMS promise) and names the event by its noun (havan, satsang,
 * meditation session, …) — owner rule.
 */
import { useEffect, useRef, useState } from 'react';
import { useSignIn, useSignUp } from '@clerk/clerk-react';
import { EmailCodeSignIn } from '../auth/EmailCodeSignIn';
import { sendPhoneCode, verifyPhoneCode, apiMessage, apiCode } from '../auth/passwordless';
import {
  sendWhatsAppCode, verifyWhatsAppCode, redeemWhatsAppTicket, waApiMessage,
  storeWaProof, readWaProof, claimWhatsAppProof,
} from '../auth/whatsappAuth';
import { WhatsAppNumberInput, type WhatsAppNumberInputClasses } from '../auth/WhatsAppNumberInput';
import { DEFAULT_COUNTRY, toE164 } from '../../lib/countries';
import { getActiveTokenWaited } from '../../lib/clerk';
import { capture, captureException } from '../../lib/analytics';
import type { EventType, EventTypeCopy } from '../../lib/eventTypes';
import type { PwlSignIn } from '../auth/passwordless';

const STHC_CLASSES: WhatsAppNumberInputClasses = { field: 'sthc-fld', label: '', box: 'sthc-in', err: 'sthc-err' };

export function YouStep({
  signedIn,
  onSignedIn,
  onVerified,
  listingId,
  eventType,
  copy,
  stepIndex,
  totalSteps,
}: {
  signedIn: boolean;
  onSignedIn: () => void;
  onVerified: () => void;
  listingId: string;
  eventType: EventType;
  copy: EventTypeCopy;
  stepIndex: number;
  totalSteps: number;
}) {
  const { signIn, setActive } = useSignIn();
  useSignUp(); // keeps the Clerk sign-up resource warm for EmailCodeSignIn's own hook usage

  const [method, setMethod] = useState<'email' | 'whatsapp'>('email');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'code' | 'verifying'>('idle');
  const [country, setCountry] = useState(DEFAULT_COUNTRY.code);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [phoneMasked, setPhoneMasked] = useState('');
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'you', listing_id: listingId, event_type: eventType });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function chooseMethod(m: 'email' | 'whatsapp') {
    setMethod(m);
    setErr(null);
    capture('login_method_chosen', { method: m, surface: 'checkout' });
  }

  /* ── Signed OUT: pre-auth WhatsApp login (needs_email hands off to email) ── */
  async function sendWaLogin() {
    setErr(null);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) { setErr('Enter your WhatsApp number.'); return; }
    setPhase('sending');
    try {
      const r = await sendWhatsAppCode(toE164(country, phone));
      setPhoneMasked(r.phone_masked);
      setCode('');
      setPhase('code');
      setResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      setTimeout(() => codeRef.current?.focus(), 200);
    } catch (e) {
      setPhase('idle');
      setErr(waApiMessage(e, 'We couldn’t send the code on WhatsApp. Please try again.'));
      captureException(e, { where: 'saathum_checkout_wa_send' });
    }
  }

  async function verifyWaLogin() {
    if (!/^\d{4,6}$/.test(code)) return;
    setErr(null);
    setPhase('verifying');
    try {
      const r = await verifyWhatsAppCode(toE164(country, phone), code);
      if (r.status === 'signed_in') {
        await redeemWhatsAppTicket(signIn as unknown as PwlSignIn, setActive, r.ticket);
        onSignedIn();
        onVerified(); // this number is already verified for the account — nothing left to do here
        return;
      }
      // needs_email: keep the proof, fall through to the email flow — the
      // person is never asked for a second WhatsApp code once they sign in.
      storeWaProof(r.proof, r.phone_masked);
      setPhase('idle');
      chooseMethod('email');
    } catch (e) {
      setPhase('code');
      setErr(waApiMessage(e, 'That code didn’t work. Please try again.'));
      captureException(e, { where: 'saathum_checkout_wa_verify' });
    }
  }

  /** After the email step produces a session, attach a pending WhatsApp proof if one is waiting. */
  async function afterEmailSignedIn() {
    const pending = readWaProof();
    if (pending) {
      try {
        const token = await getActiveTokenWaited();
        if (token) {
          await claimWhatsAppProof(pending.proof, token);
          onSignedIn();
          onVerified();
          return;
        }
      } catch (e) {
        // Proof expired/taken — fall through to the normal WhatsApp step below.
        captureException(e, { where: 'saathum_checkout_wa_claim' });
      }
    }
    onSignedIn();
  }

  /* ── Signed IN: verify the WhatsApp number on the account ────────────── */
  async function sendCode() {
    setErr(null);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) { setErr('Enter your WhatsApp number.'); return; }
    setPhase('sending');
    try {
      const r = await sendPhoneCode(toE164(country, phone));
      if (r.already_verified) { onVerified(); return; }
      setCode('');
      setPhase('code');
      setResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      setTimeout(() => codeRef.current?.focus(), 200);
    } catch (e) {
      setPhase(apiCode(e) === 'too_soon' ? 'code' : 'idle');
      setErr(apiMessage(e, 'We couldn’t send the code on WhatsApp. Please try again.'));
      captureException(e, { where: 'saathum_checkout_phone_send' });
    }
  }

  async function verify() {
    if (!/^\d{4,6}$/.test(code)) return;
    setErr(null);
    setPhase('verifying');
    try {
      await verifyPhoneCode(code);
      onVerified();
    } catch (e) {
      setPhase('code');
      setErr(apiMessage(e, 'That code didn’t work. Please try again.'));
      captureException(e, { where: 'saathum_checkout_phone_verify' });
    }
  }

  const dots = Array.from({ length: totalSteps }, (_, i) => (
    <i key={i} className={i < stepIndex ? 'on' : ''} />
  ));

  const resendIn = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));

  if (!signedIn) {
    return (
      <div className="sthc-card">
        <div className="sthc-kick">Step {stepIndex} of {totalSteps} · You</div>
        <h3 className="sthc-h3">Sign in to book</h3>
        <div className="sthc-dots">{dots}</div>
        <div className="sthc-fld" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button type="button" className={`sthc-btn${method === 'email' ? '' : ' sthc-btn--link'}`} onClick={() => chooseMethod('email')}>
            Continue with email
          </button>
          <button type="button" className={`sthc-btn${method === 'whatsapp' ? '' : ' sthc-btn--link'}`} onClick={() => chooseMethod('whatsapp')}>
            Continue with WhatsApp
          </button>
        </div>
        {method === 'email' ? (
          <>
          {readWaProof() && (
            <p className="sthc-hint">Your WhatsApp number {readWaProof()?.phone_masked} is verified. Now add your email — we send your booking and receipts there.</p>
          )}
          <EmailCodeSignIn reason="so we can send your booking" onAuthed={() => void afterEmailSignedIn()} />
          </>
        ) : (
          <>
            {phase !== 'code' && phase !== 'verifying' && (
              <>
                <WhatsAppNumberInput
                  value={phone} countryCode={country}
                  onChange={(n, c) => { setPhone(n); setCountry(c); }}
                  label="WhatsApp number" classes={STHC_CLASSES} autoFocus
                />
                {err && <p className="sthc-err" role="alert">{err}</p>}
                <button className="sthc-btn" disabled={phase === 'sending'} onClick={() => void sendWaLogin()}>
                  {phase === 'sending' ? 'Sending…' : 'Send code on WhatsApp →'}
                </button>
              </>
            )}
            {(phase === 'code' || phase === 'verifying') && (
              <>
                <p className="sthc-hint">We sent a 6-digit code on WhatsApp to {phoneMasked}.</p>
                <div className="sthc-fld">
                  <label htmlFor="sthc-wa-code">6-digit code</label>
                  <input
                    id="sthc-wa-code" ref={codeRef} className="sthc-in" inputMode="numeric" maxLength={6}
                    value={code} disabled={phase === 'verifying'}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                {err && <p className="sthc-err" role="alert">{err}</p>}
                <button className="sthc-btn" disabled={phase === 'verifying' || code.length < 4} onClick={() => void verifyWaLogin()}>
                  {phase === 'verifying' ? 'Verifying…' : 'Verify and continue →'}
                </button>
                <button className="sthc-btn sthc-btn--link" disabled={resendIn > 0} onClick={() => void sendWaLogin()}>
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="sthc-card">
      <div className="sthc-kick">Step {stepIndex} of {totalSteps} · You</div>
      <h3 className="sthc-h3">Verify your WhatsApp number</h3>
      <div className="sthc-dots">{dots}</div>
      <WhatsAppNumberInput
        value={phone} countryCode={country}
        onChange={(n, c) => { setPhone(n); setCountry(c); }}
        label="WhatsApp number" classes={STHC_CLASSES}
        disabled={phase === 'code' || phase === 'verifying'}
      />
      {err && <p className="sthc-err" role="alert">{err}</p>}
      <div className="sthc-hint">
        We&rsquo;ll email you the video when the {copy.noun} finishes.
      </div>
      {phase !== 'code' && phase !== 'verifying' && (
        <button className="sthc-btn" disabled={phase === 'sending' || phone.replace(/\D/g, '').length < 4} onClick={() => void sendCode()}>
          {phase === 'sending' ? 'Sending…' : 'Send code →'}
        </button>
      )}
      {(phase === 'code' || phase === 'verifying') && (
        <>
          <div className="sthc-fld">
            <label htmlFor="sthc-phone-code">6-digit code</label>
            <input
              id="sthc-phone-code"
              ref={codeRef}
              className="sthc-in"
              inputMode="numeric"
              maxLength={6}
              value={code}
              disabled={phase === 'verifying'}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <button className="sthc-btn" disabled={phase === 'verifying' || code.length < 4} onClick={() => void verify()}>
            {phase === 'verifying' ? 'Verifying…' : 'Verify WhatsApp →'}
          </button>
          <button
            className="sthc-btn sthc-btn--link"
            disabled={resendIn > 0}
            onClick={() => void sendCode()}
          >
            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
          </button>
        </>
      )}
    </div>
  );
}
