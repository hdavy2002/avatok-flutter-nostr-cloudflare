// [SAATHUM-PREETI-1] Inline "name + WhatsApp" card shown to anonymous visitors at
// the start of a chat. Never a hard gate: "Skip for now" always works.
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

interface Props {
  /** Resolve to null on success or an error message to show. */
  onSubmit: (name: string, whatsapp: string) => Promise<string | null>;
  onSkip: () => void;
}

export function IdentityCard({ onSubmit, onSkip }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('+91');
  const [num, setNum] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    const raw = num.trim();
    if (!n) { setErr('Please tell me your name.'); return; }
    if (!raw) { setErr('Please enter your WhatsApp number.'); return; }
    const whatsapp = raw.startsWith('+') ? `+${raw.replace(/\D/g, '')}` : `${code}${raw.replace(/\D/g, '').replace(/^0+/, '')}`;
    setBusy(true);
    setErr(null);
    const msg = await onSubmit(n, whatsapp);
    setBusy(false);
    if (msg) setErr(msg);
  }

  return (
    <form className="pt-identity" onSubmit={submit} noValidate>
      <p className="pt-identity-help">
        Aapka naam aur WhatsApp number dene se main hamari baat yaad rakh paungi aur team aapse sampark kar sakegi.
      </p>
      <label className="pt-label" htmlFor="pt-id-name">Your name</label>
      <input
        id="pt-id-name"
        className="pt-input"
        type="text"
        autoComplete="name"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="pt-label" htmlFor="pt-id-num">WhatsApp number</label>
      <div className="pt-phone-row">
        <select className="pt-input pt-input--code" aria-label="Country code" value={code} onChange={(e) => setCode(e.target.value)}>
          {CODES.map((c) => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>
        <input
          id="pt-id-num"
          className="pt-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          maxLength={20}
          value={num}
          onChange={(e) => setNum(e.target.value)}
        />
      </div>
      {err && <p className="pt-identity-err" role="alert">{err}</p>}
      <div className="pt-identity-actions">
        <button type="submit" className="pt-btn pt-btn--primary" disabled={busy}>
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="pt-link" onClick={onSkip}>Skip for now</button>
      </div>
    </form>
  );
}
