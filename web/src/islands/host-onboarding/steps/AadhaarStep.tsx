import { useEffect, useState } from 'react';
import Icon from '../Icon';
import type { StepProps } from '../types';

const group = (d: string) => d.replace(/(\d{4})(?=\d)/g, '$1 ');

export default function AadhaarStep({ draft, update, api, setAction }: StepProps) {
  const [digits, setDigits] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const done = draft.aadhaarDone;

  useEffect(() => {
    if (done) setAction({ label: 'Continue', run: () => true });
    else if (phase === 1) setAction({
      label: 'Send OTP',
      disabled: digits.length !== 12,
      run: async () => {
        setError('');
        const r = await api.sendAadhaarOtp(digits);
        if (!r.ok) { setError(r.error || 'We could not send the OTP. Please check the number.'); return false; }
        setCode(''); setPhase(2);
        return false;
      },
    });
    else setAction({
      label: 'Verify',
      disabled: code.length !== 6,
      run: async () => {
        setError('');
        const r = await api.verifyAadhaarOtp(code);
        if (!r.ok) { setError(r.error || 'That OTP is not right. Please try again.'); return false; }
        update({ aadhaarDone: true, aadhaarLast4: r.last4 || digits.slice(-4) });
        return true;
      },
    });
  }, [done, phase, digits, code, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Aadhaar check</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Aadhaar ending {draft.aadhaarLast4} verified</p>
        </div>
      </div>
    );
  }

  if (phase === 1) {
    return (
      <div>
        <h1 className="hob-h1">Your Aadhaar number</h1>
        <p className="hob-lead">We send an OTP to the mobile linked with your Aadhaar.</p>
        <div className="hob-field">
          <label className="hob-label" htmlFor="hob-v-aadhaar">Aadhaar number</label>
          <input
            id="hob-v-aadhaar" className="hob-input hob-v-aadhaar" type="text" inputMode="numeric"
            autoComplete="off" placeholder="0000 0000 0000" value={group(digits)}
            aria-describedby="hob-v-aadhaar-help hob-v-err"
            onChange={(e) => { setDigits(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(''); }}
          />
          <p id="hob-v-aadhaar-help" className="hob-help">We only check it. We never show it and never store the full number.</p>
          <p id="hob-v-err" className="hob-error" role="alert" aria-live="polite">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">Enter the OTP</h1>
      <p className="hob-lead">We sent a 6-digit OTP to the mobile linked with your Aadhaar.</p>
      <p><button type="button" className="hob-v-link" onClick={() => { setPhase(1); setError(''); }}>Change Aadhaar number</button></p>
      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-aotp">6-digit OTP</label>
        <input
          id="hob-v-aotp" className="hob-input hob-v-code" type="text" inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} placeholder="······" value={code}
          aria-describedby="hob-v-err"
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
        />
        <p id="hob-v-err" className="hob-error" role="alert" aria-live="polite">{error}</p>
      </div>
    </div>
  );
}
