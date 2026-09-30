// [SAATHUM-PREETI-LEADGATE-1] Inline "email + WhatsApp" form shown under Preeti's ask
// message when the server emits `identity_required`. No skip: Preeti answers once
// the visitor has shared both. Server field errors are shown next to the field.
import { useState } from 'react';
import type { FormEvent } from 'react';

const CODES: { code: string; label: string }[] = [
  { code: '+91', label: 'India +91' },
  { code: '+1', label: 'US / Canada +1' },
  { code: '+44', label: 'UK +44' },
  { code: '+971', label: 'UAE +971' },
  { code: '+65', label: 'Singapore +65' },
  { code: '+61', label: 'Australia +61' },
  { code: '+977', label: 'Nepal +977' },
  { code: '+94', label: 'Sri Lanka +94' },
  { code: '+880', label: 'Bangladesh +880' },
  { code: '+92', label: 'Pakistan +92' },
];

export interface IdentityError { field: 'email' | 'whatsapp' | 'form'; message: string }

interface Props {
  /** Resolve to null on success or the error to show. */
  onSubmit: (email: string, whatsapp: string) => Promise<IdentityError | null>;
}

export function IdentityCard({ onSubmit }: Props) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('+91');
  const [num, setNum] = useState('');
  const [err, setErr] = useState<IdentityError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const em = email.trim();
    const raw = num.trim();
    if (!em) { setErr({ field: 'email', message: 'Please enter your email address.' }); return; }
    if (!raw) { setErr({ field: 'whatsapp', message: 'Please enter your WhatsApp number.' }); return; }
    const whatsapp = raw.startsWith('+') ? `+${raw.replace(/\D/g, '')}` : `${code}${raw.replace(/\D/g, '').replace(/^0+/, '')}`;
    setBusy(true);
    setErr(null);
    const res = await onSubmit(em, whatsapp);
    setBusy(false);
    if (res) setErr(res);
  }

  const emailErr = err?.field === 'email' ? err.message : null;
  const numErr = err?.field === 'whatsapp' ? err.message : null;
  const formErr = err?.field === 'form' ? err.message : null;

  return (
    <form className="pt-identity" onSubmit={submit} noValidate aria-label="Share your email and WhatsApp number">
      <label className="pt-label" htmlFor="pt-id-email">Email</label>
      <input
        id="pt-id-email"
        className={`pt-input${emailErr ? ' pt-input--bad' : ''}`}
        type="email"
        inputMode="email"
        autoComplete="email"
        maxLength={254}
        value={email}
        aria-invalid={emailErr ? true : undefined}
        aria-describedby={emailErr ? 'pt-id-email-err' : undefined}
        onChange={(e) => setEmail(e.target.value)}
      />
      {emailErr && <p id="pt-id-email-err" className="pt-identity-err" role="alert">{emailErr}</p>}
      <label className="pt-label" htmlFor="pt-id-num">WhatsApp number</label>
      <div className="pt-phone-row">
        <select className="pt-input pt-input--code" aria-label="Country code" value={code} onChange={(e) => setCode(e.target.value)}>
          {CODES.map((c) => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>
        <input
          id="pt-id-num"
          className={`pt-input${numErr ? ' pt-input--bad' : ''}`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={20}
          value={num}
          aria-invalid={numErr ? true : undefined}
          aria-describedby={numErr ? 'pt-id-num-err' : undefined}
          onChange={(e) => setNum(e.target.value)}
        />
      </div>
      {numErr && <p id="pt-id-num-err" className="pt-identity-err" role="alert">{numErr}</p>}
      {formErr && <p className="pt-identity-err" role="alert">{formErr}</p>}
      <div className="pt-identity-actions">
        <button type="submit" className="pt-btn pt-btn--primary" disabled={busy}>
          {busy ? 'Saving...' : 'Share & continue'}
        </button>
      </div>
    </form>
  );
}
