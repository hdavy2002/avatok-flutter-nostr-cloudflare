import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { GENDER_LABEL } from '../data';
import type { KycGender, StepProps } from '../types';

const group = (d: string) => d.replace(/(\d{4})(?=\d)/g, '$1 ');

export default function AadhaarStep({ draft, update, api, setAction }: StepProps) {
  const [digits, setDigits] = useState('');
  const [code, setCode] = useState('');
  const [mockGender, setMockGender] = useState<KycGender>(draft.kycGender ?? 'woman');
  const [phase, setPhase] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const real = api.mode === 'real';
  const done = draft.aadhaarDone;

  useEffect(() => {
    if (done) setAction({ label: 'Continue', run: () => true });
    else if (phase === 1) setAction({
      label: 'Send OTP',
      disabled: digits.length !== 12 || (real && !consent),
      run: async () => {
        setError('');
        const r = await api.sendAadhaarOtp(digits);
        if (!r.ok) { setError(r.error || 'We could not send the OTP. Please check the number.'); return false; }
        if (r.alreadyVerified) { update({ aadhaarDone: true, aadhaarLast4: r.alreadyVerified.last4, kycGender: r.alreadyVerified.gender }); return false; }
        setCode(''); setPhase(2);
        return false;
      },
    });
    else setAction({
      label: 'Verify',
      disabled: code.length !== 6,
      run: async () => {
        setError('');
        const r = await api.verifyAadhaarOtp(code, mockGender);
        if (!r.ok) { setError(r.error || 'That OTP is not right. Please try again.'); return false; }
        update({ aadhaarDone: true, aadhaarLast4: r.last4 || digits.slice(-4), aadhaarName: r.name || '', kycGender: r.gender ?? mockGender });
        return false;
      },
    });
  }, [done, phase, digits, code, mockGender, consent, real, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Aadhaar verified</h1>
        <p className="hob-lead">Here is what we read from your Aadhaar through our licensed verification partner.</p>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Aadhaar ending {draft.aadhaarLast4}</p>
        </div>
        <dl className="hob-card hob-v-read">
          <div><dt>Name</dt><dd>{draft.aadhaarName || '-'}</dd></div>
          <div><dt>Gender</dt><dd>{draft.kycGender ? GENDER_LABEL[draft.kycGender] : '-'}</dd></div>
          <div><dt>Age</dt><dd>18 or older ✓</dd></div>
        </dl>
        <p className="hob-help">We keep only your name, gender, 18+ result and the last 4 digits. Never the full number.</p>
      </div>
    );
  }

  if (phase === 1) {
    return (
      <div>
        <h1 className="hob-h1">Your Aadhaar number</h1>
        <p className="hob-lead">Our licensed verification partner sends an OTP to the mobile linked with your Aadhaar.</p>
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
        {real && (
          <label className="hob-card hob-f-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree that my Aadhaar can be checked through our licensed verification partner to confirm my name, gender and that I am 18 or older. The full number is never stored.</span>
          </label>
        )}
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
      {!real && <div className="hob-v-preview" role="group" aria-labelledby="hob-v-prev">
        <p className="hob-v-tag">Preview only</p>
        <p id="hob-v-prev">For this preview, choose the gender the Aadhaar record would show:</p>
        <div className="hob-v-chips">
          {(['woman', 'man', 'transgender'] as KycGender[]).map((g) => (
            <button key={g} type="button" className="hob-chip" aria-pressed={mockGender === g} onClick={() => setMockGender(g)}>{GENDER_LABEL[g]}</button>
          ))}
        </div>
      </div>}
    </div>
  );
}
