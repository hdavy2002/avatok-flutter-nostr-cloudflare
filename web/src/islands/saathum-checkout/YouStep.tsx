/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 1 — "You". Reuses the SAME building
 * blocks as the rest of the site rather than inventing new auth code:
 *   - sign-in: <EmailCodeSignIn> (email + 6-digit code, no password — the
 *     same component BookingFlow.tsx uses).
 *   - mobile verification: sendPhoneCode/verifyPhoneCode/getPhoneStatus from
 *     islands/auth/passwordless.ts — the exact functions SignUpIsland.tsx's
 *     inline phone gate calls (/api/account/phone/{send,verify,status}).
 * A signed-in account whose phone is already verified skips this step
 * entirely (SaathumCheckout decides that before rendering it).
 */
import { useEffect, useRef, useState } from 'react';
import { EmailCodeSignIn } from '../auth/EmailCodeSignIn';
import { sendPhoneCode, verifyPhoneCode, apiMessage, apiCode } from '../auth/passwordless';
import { capture, captureException } from '../../lib/analytics';

export function YouStep({
  signedIn,
  onSignedIn,
  onVerified,
  listingId,
}: {
  signedIn: boolean;
  onSignedIn: () => void;
  onVerified: () => void;
  listingId: string;
}) {
  const [phase, setPhase] = useState<'idle' | 'sending' | 'code' | 'verifying'>('idle');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'you', listing_id: listingId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendCode() {
    setErr(null);
    if (!/^[6-9]\d{9}$/.test(phone)) { setErr('Enter your 10-digit mobile number.'); return; }
    setPhase('sending');
    try {
      const r = await sendPhoneCode(`+91${phone}`);
      if (r.already_verified) { onVerified(); return; }
      setCode('');
      setPhase('code');
      setResendAt(Date.now() + (r.resend_after_s ?? 30) * 1000);
      setTimeout(() => codeRef.current?.focus(), 200);
    } catch (e) {
      setPhase(apiCode(e) === 'too_soon' ? 'code' : 'idle');
      setErr(apiMessage(e, 'We couldn’t send the SMS. Please try again.'));
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

  if (!signedIn) {
    return (
      <div className="sthc-card">
        <div className="sthc-kick">Step 1 of 5 · You</div>
        <h3 className="sthc-h3">Sign in to book</h3>
        <div className="sthc-dots"><i className="on" /><i /><i /><i /><i /></div>
        <EmailCodeSignIn reason="so we can send your booking" onAuthed={onSignedIn} />
      </div>
    );
  }

  const resendIn = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));

  return (
    <div className="sthc-card">
      <div className="sthc-kick">Step 1 of 5 · You</div>
      <h3 className="sthc-h3">Verify your mobile</h3>
      <div className="sthc-dots"><i className="on" /><i /><i /><i /><i /></div>
      <div className="sthc-fld">
        <label htmlFor="sthc-phone">Mobile number</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="sthc-in" style={{ width: 64, textAlign: 'center', flex: 'none' }}>+91</span>
          <input
            id="sthc-phone"
            className="sthc-in"
            inputMode="numeric"
            maxLength={10}
            placeholder="98xxx xxxxx"
            value={phone}
            disabled={phase === 'code' || phase === 'verifying'}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        </div>
      </div>
      {err && <p className="sthc-err" role="alert">{err}</p>}
      <div className="sthc-hint">
        We&rsquo;ll send the live video link by email 30 minutes before the havan starts.
      </div>
      {phase !== 'code' && phase !== 'verifying' && (
        <button className="sthc-btn" disabled={phase === 'sending' || phone.length !== 10} onClick={() => void sendCode()}>
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
            {phase === 'verifying' ? 'Verifying…' : 'Verify mobile →'}
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
