/* [HF-MERCH-GST-1] The influencer's OPTIONAL GSTIN for merch. We are the seller and issue the tax invoice, so this is only recorded (admin sees it on the order);
 * payouts do not change because of it yet. GET|PUT /api/hf/merch/tax. A tiny collapsible so it never crowds the screen. */
import { useEffect, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { GSTIN_RE, getTax, putTax } from './api';

export default function TaxBox() {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [val, setVal] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void getTax().then(r => { if (r.ok) { setSaved(r.data.gstin); setVal(r.data.gstin ?? ''); } else setSaved(null); });
  }, []);

  const g = val.trim().toUpperCase().replace(/\s+/g, '');
  const valid = g === '' || GSTIN_RE.test(g);
  async function save() {
    if (!valid || busy) return;
    setBusy(true); setMsg(null);
    const r = await putTax(g);
    setBusy(false);
    if (r.ok) { setSaved(r.data.gstin); setVal(r.data.gstin ?? ''); setMsg({ ok: true, text: g ? 'Saved. We keep it on file; your royalty stays the same.' : 'Removed.' }); }
    else { setMsg({ ok: false, text: r.message || 'Could not save it.' }); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_tax_${r.status}_${r.code}`), { area: 'hf_merch_creator', part: 'tax' }); }
  }
  if (saved === undefined) return null;
  return <section className="h3-card" style={{ marginBottom: 14 }} aria-label="GSTIN">
    <button type="button" className="h3-btn sm ghost" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide' : saved ? `Your GSTIN: ${saved}` : 'Have a GSTIN? Add it (optional)'}</button>
    {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <p className="small muted">We sell the shirts and give the fan a tax invoice, so you do not need a GSTIN to earn your royalty. If you have one, you can add it here for our records. It does not change your payout.</p>
      <label className="f">GSTIN (15 characters)<input value={val} maxLength={20} autoCapitalize="characters" placeholder="27ABCDE1234F1Z5" onChange={e => setVal(e.target.value)} aria-invalid={!valid} /></label>
      {!valid && <p className="mc-err small">A GSTIN looks like 27ABCDE1234F1Z5. Leave it empty if you do not have one.</p>}
      {msg && <p className={msg.ok ? 'small muted' : 'mc-err small'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <div className="acts"><button type="button" className="h3-btn rani mc-big" disabled={!valid || busy || g === (saved ?? '')} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></div>
    </div>}
  </section>;
}
