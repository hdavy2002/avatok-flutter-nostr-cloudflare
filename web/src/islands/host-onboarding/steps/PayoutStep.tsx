
import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { UPI_RE } from '../data';
import type { StepProps } from '../types';

/* [HF-UPI-ONLY-1] Withdrawals are paid ONLY to a UPI ID. No bank account number or IFSC is asked for here any more.
 * The name check on the UPI ID comes later, when the UPI-verification API is connected (worker verifyUpiId()). */
export default function PayoutStep({ draft, update, api, setAction }: StepProps) {
  const p = draft.payout;
  const [upi, setUpi] = useState(p.upi);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const upiOk = UPI_RE.test(upi.trim());
  const done = p.verified && !editing;

  useEffect(() => {
    if (done) { setAction({ label: 'Continue', run: () => true }); return; }
    setAction({
      label: 'Save',
      disabled: !upiOk,
      run: async () => {
        setError('');
        try {
          const r = await api.verifyPayout({ upi: upi.trim() });
          if (!r.ok) { setError(r.error || 'We could not save this UPI ID. Please try again.'); return false; }
          update({ payout: { upi: upi.trim(), accountLast4: '', ifsc: '', nameAtBank: '', verified: true } });
          setEditing(false);
        } catch { setError('We could not save this UPI ID. Please try again.'); }
        return false;
      },
    });
  }, [done, upiOk, upi, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">UPI ID saved</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Withdrawals will be paid to this UPI ID ✓</p>
        </div>
        <dl className="hob-card hob-v-read">
          {p.upi && <div><dt>UPI ID</dt><dd>{p.upi}</dd></div>}
        </dl>
        <button type="button" className="hob-v-link" onClick={() => { setEditing(true); update({ payout: { ...p, verified: false } }); }}>Change UPI ID</button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">Where we pay you</h1>
      <p className="hob-lead">Withdrawals are paid only to a UPI ID. Use a UPI ID in your own name{draft.aadhaarName ? ` (${draft.aadhaarName})` : ''}.</p>

      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-upi">UPI ID</label>
        <input id="hob-v-upi" className="hob-input" type="text" inputMode="email" autoComplete="off" autoCapitalize="none" placeholder="name@bank"
          value={upi} aria-invalid={!!upi && !upiOk} onChange={e => { setUpi(e.target.value.trim()); setError(''); }} />
        {!!upi && !upiOk && <p className="hob-error">Use the format name@bank</p>}
      </div>
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
      <p className="hob-help">We do not ask for a bank account number.</p>
    </div>
  );
}
