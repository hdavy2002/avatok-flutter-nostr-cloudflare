import { useEffect, useState } from 'react';
import Icon from '../Icon';
import type { StepProps } from '../types';

const RESEND_SECS = 30;

const PHONE_FLOW_URL = `/sign-up?finish=1&next=${encodeURIComponent('/hosts/onboarding?step=phone')}`;

/** Real mode: the number was verified by WhatsApp when the host signed in. We only show it (masked) and let them go on. */
function RealPhoneStep({ draft, setAction }: StepProps) {
  const verified = draft.phoneVerified;
  const last4 = draft.phone.slice(-4);
  useEffect(() => {
    setAction(verified ? { label: 'Continue', run: () => true } : { label: 'Verify my number', run: () => { window.location.assign(PHONE_FLOW_URL); return false; } });
  }, [verified, setAction]);
  if (verified) {
    return (
      <div>
        <h1 className="hob-h1">Your number is verified</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <div>
            <p className="hob-v-strong">+91 •••••• {last4} ✓</p>
            <p className="hob-help">Callers' calls will ring on this number. It is never shown to anyone.</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h1 className="hob-h1">Verify your WhatsApp number</h1>
      <p className="hob-lead">We need to check the number your calls will ring on. It takes a minute and we never show it to callers.</p>
      <a className="hob-btn hob-btn-primary" href={PHONE_FLOW_URL}>Verify my number</a>
    </div>
  );
}

export default function PhoneStep(props: StepProps) {
  return props.api.mode === 'real' ? <RealPhoneStep {...props} /> : <MockPhoneStep {...props} />;
}

function MockPhoneStep({ draft, update, api, setAction, goNext }: StepProps) {
  const [phone, setPhone] = useState(draft.phone || '');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);
  const verified = draft.phoneVerified;

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const phoneOk = /^[6-9]\d{9}$/.test(phone);

  useEffect(() => {
    if (verified) {
      setAction({ label: 'Continue', run: () => true });
    } else if (phase === 1) {
      setAction({
        label: 'Send code',
        disabled: !phoneOk,
        run: async () => {
          setError('');
          const r = await api.sendOtp(phone);
          if (!r.ok) { setError(r.error || 'We could not send the code. Please try again.'); return false; }
          setCode('');
          setLeft(RESEND_SECS);
          setPhase(2);
          return false;
        },
      });
    } else {
      setAction({
        label: 'Verify',
        disabled: code.length !== 6,
        run: async () => {
          setError('');
          const r = await api.verifyOtp(phone, code);
          if (!r.ok) { setError(r.error || 'That code is not right. Please check and try again.'); return false; }
          update({ phone, phoneVerified: true });
          return true;
        },
      });
    }
  }, [verified, phase, phone, phoneOk, code, api, update, setAction]);

  const resend = async () => {
    if (left > 0) return;
    setError('');
    const r = await api.sendOtp(phone);
    if (!r.ok) setError(r.error || 'We could not send the code. Please try again.');
    else setLeft(RESEND_SECS);
  };

  if (verified) {
    return (
      <div>
        <h1 className="hob-h1">Your number is verified</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <div>
            <p className="hob-v-strong">+91 {draft.phone}</p>
            <p className="hob-help">Calls will come to this WhatsApp number.</p>
          </div>
        </div>
        <p className="hob-v-rules"><button type="button" className="hob-v-link" onClick={() => { update({ phoneVerified: false }); setPhase(1); }}>Change number</button></p>
      </div>
    );
  }

  if (phase === 1) {
    return (
      <div>
        <h1 className="hob-h1">Your WhatsApp number</h1>
        <p className="hob-lead">We will send a code on WhatsApp to check it is really yours.</p>
        <div className="hob-field">
          <label className="hob-label" htmlFor="hob-v-phone">WhatsApp number</label>
          <div className="hob-v-phone-row">
            <span className="hob-v-prefix" aria-hidden="true">+91</span>
            <input
              id="hob-v-phone" className="hob-input" type="tel" inputMode="numeric"
              maxLength={10} autoComplete="tel-national" placeholder="98765 43210"
              value={phone} aria-describedby="hob-v-phone-help hob-v-err"
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '').slice(0, 10)); setError(''); }}
            />
          </div>
          <p id="hob-v-phone-help" className="hob-help">Calls from callers will come to this number. It is never shown to anyone.</p>
          <p id="hob-v-err" className="hob-error" role="alert" aria-live="polite">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">Enter the code</h1>
      <p className="hob-lead">Enter the 6-digit code we sent on WhatsApp to +91 {phone.slice(0, 5)} {phone.slice(5)}</p>
      <p><button type="button" className="hob-v-link" onClick={() => { setPhase(1); setError(''); setCode(''); }}>Change number</button></p>
      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-code">6-digit code</label>
        <input
          id="hob-v-code" className="hob-input hob-v-code" type="text" inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} placeholder="······" value={code}
          aria-describedby="hob-v-err"
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
        />
        <p id="hob-v-err" className="hob-error" role="alert" aria-live="polite">{error}</p>
      </div>
      <button type="button" className="hob-btn hob-btn-ghost" onClick={resend} disabled={left > 0}>
        {left > 0 ? `Resend code in ${left}s` : 'Resend code'}
      </button>
    </div>
  );
}
