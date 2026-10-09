import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { IFSC_RE, UPI_RE } from '../data';
import type { StepProps } from '../types';

export default function PayoutStep({ draft, update, api, setAction }: StepProps) {
  const p = draft.payout;
  const [upi, setUpi] = useState(p.upi);
  const [acct, setAcct] = useState('');
  const [acct2, setAcct2] = useState('');
  const [ifsc, setIfsc] = useState(p.ifsc);
  const [error, setError] = useState('');
  const [matchFail, setMatchFail] = useState(false);
  const [editing, setEditing] = useState(false);

  const upiOk = UPI_RE.test(upi.trim());
  const acctOk = /^\d{9,18}$/.test(acct);
  const sameOk = acct === acct2;
  const ifscOk = IFSC_RE.test(ifsc);
  const valid = upiOk && acctOk && sameOk && ifscOk;
  const done = p.verified && !editing;

  useEffect(() => {
    if (done) { setAction({ label: 'Continue', run: () => true }); return; }
    setAction({
      label: 'Verify',
      disabled: !valid,
      run: async () => {
        setError(''); setMatchFail(false);
        try {
          const r = await api.verifyPayout({ upi: upi.trim(), account: acct, ifsc });
          if (!r.ok) { setError(r.error || 'We could not check these details. Please try again.'); return false; }
          if (!r.match) { setMatchFail(true); return false; }
          update({ payout: { upi: upi.trim(), accountLast4: acct.slice(-4), ifsc, nameAtBank: r.nameAtBank || '', verified: true } });
          setAcct(''); setAcct2(''); setEditing(false);
        } catch { setError('We could not check these details. Please try again.'); }
        return false;
      },
    });
  }, [done, valid, upi, acct, ifsc, api, update, setAction]);

  if (done) {
    return (
      <div>
        <h1 className="hob-h1">Payout details checked</h1>
        <div className="hob-card hob-v-done">
          <span className="hob-v-badge" aria-hidden="true"><Icon name="check" /></span>
          <p className="hob-v-strong">Name matches your Aadhaar ✓</p>
        </div>
        <dl className="hob-card hob-v-read">
          {p.nameAtBank && <div><dt>Name at bank</dt><dd>{p.nameAtBank}</dd></div>}
          {p.upi && <div><dt>UPI ID</dt><dd>{p.upi}</dd></div>}
          {p.accountLast4 && <div><dt>Bank account</dt><dd>••••{p.accountLast4}</dd></div>}
          {p.ifsc && <div><dt>IFSC</dt><dd>{p.ifsc}</dd></div>}
        </dl>
        <button type="button" className="hob-v-link" onClick={() => { setEditing(true); update({ payout: { ...p, verified: false } }); }}>Change payout details</button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="hob-h1">Where we pay you</h1>
      <p className="hob-lead">We check the account is in your own name. The name must match your Aadhaar{draft.aadhaarName ? ` (${draft.aadhaarName})` : ''}.</p>

      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-upi">UPI ID</label>
        <input id="hob-v-upi" className="hob-input" type="text" inputMode="email" autoComplete="off" autoCapitalize="none" placeholder="name@bank"
          value={upi} aria-invalid={!!upi && !upiOk} onChange={e => { setUpi(e.target.value.trim()); setError(''); }} />
        {!!upi && !upiOk && <p className="hob-error">Use the format name@bank</p>}
      </div>
      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-acct">Bank account number</label>
        <input id="hob-v-acct" className="hob-input" type="password" inputMode="numeric" autoComplete="off"
          value={acct} aria-invalid={!!acct && !acctOk} onChange={e => { setAcct(e.target.value.replace(/\D/g, '').slice(0, 18)); setError(''); }} />
        {!!acct && !acctOk && <p className="hob-error">Account numbers have 9 to 18 digits.</p>}
      </div>
      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-acct2">Confirm account number</label>
        <input id="hob-v-acct2" className="hob-input" type="text" inputMode="numeric" autoComplete="off"
          value={acct2} aria-invalid={!!acct2 && !sameOk} onChange={e => { setAcct2(e.target.value.replace(/\D/g, '').slice(0, 18)); setError(''); }} />
        {!!acct2 && !sameOk && <p className="hob-error">The two numbers are not the same.</p>}
      </div>
      <div className="hob-field">
        <label className="hob-label" htmlFor="hob-v-ifsc">IFSC code</label>
        <input id="hob-v-ifsc" className="hob-input" type="text" autoComplete="off" autoCapitalize="characters" placeholder="HDFC0001234" maxLength={11}
          value={ifsc} aria-invalid={!!ifsc && !ifscOk} onChange={e => { setIfsc(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)); setError(''); }} />
        {!!ifsc && !ifscOk && <p className="hob-error">IFSC has 11 characters, like HDFC0001234.</p>}
      </div>
      {matchFail && <p className="hob-error" role="alert">The name on this account does not match your Aadhaar. Please use an account in your own name.</p>}
      <p className="hob-error" role="alert" aria-live="polite">{error}</p>
      <p className="hob-help">We keep only the last 4 digits of your account number.</p>
    </div>
  );
}
