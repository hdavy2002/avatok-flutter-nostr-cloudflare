/* SpendLimitEditor — [HF-WALLET-LIMITS-1] small "Spending limit" editor on a caller row (Calls & credits page).
 * Worker: GET/PUT /api/admin/hf/limits/:uid. Limits count REAL money only (HF-PAY-7). An empty box = use the default. Nothing under 14px. */
import { useState } from 'react';
import { adminCall } from '../peopleKit';
import { Banner, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

interface Info {
  uid: string; defaults: { daily: number; monthly: number };
  override: { dailyRupees: number | null; monthlyRupees: number | null; note: string | null } | null;
  effective: { daily: number; monthly: number }; spentToday: number; spentThisMonth: number;
}

export default function SpendLimitEditor({ uid }: { uid: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const base = `/api/admin/hf/limits/${encodeURIComponent(uid)}`;

  const fill = (i: Info) => {
    setInfo(i);
    setDaily(i.override?.dailyRupees != null ? String(i.override.dailyRupees) : '');
    setMonthly(i.override?.monthlyRupees != null ? String(i.override.monthlyRupees) : '');
    setNote(i.override?.note ?? '');
  };
  const toggle = async () => {
    const next = !open; setOpen(next); setMsg(null);
    if (next && !info) {
      try { fill(await adminCall<Info>(base)); } catch (e) { setMsg({ tone: 'error', text: fail('hf_limits_get', e) }); }
    }
  };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { dailyRupees: daily === '' ? null : Number(daily), monthlyRupees: monthly === '' ? null : Number(monthly), note: note.trim() };
      fill(await adminCall<Info>(base, { method: 'PUT', body }));
      setMsg({ tone: 'info', text: 'Saved.' });
    } catch (e) { setMsg({ tone: 'error', text: fail('hf_limits_put', e) }); }
    setBusy(false);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div><button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} aria-expanded={open} onClick={() => void toggle()}>{open ? 'Hide spending limit' : 'Spending limit'}</button></div>
      {open && (
        <div style={{ display: 'grid', gap: 8, background: '#f8f1fa', borderRadius: 10, padding: 10 }}>
          {info && (
            <div style={T14}>
              <div>Now: <strong>{rupees(info.effective.daily)}</strong> a day, <strong>{rupees(info.effective.monthly)}</strong> a month{info.override ? ' (set for this user)' : ' (default)'}.</div>
              <div>Spent (real money): {rupees(info.spentToday)} today, {rupees(info.spentThisMonth)} this month. Default {rupees(info.defaults.daily)} / {rupees(info.defaults.monthly)}.</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input aria-label="Daily limit in rupees" style={{ ...field, width: 170 }} inputMode="numeric" placeholder={info ? `Daily (default ${info.defaults.daily})` : 'Daily ₹'} value={daily} onChange={(e) => setDaily(e.target.value.replace(/\D/g, ''))} />
            <input aria-label="Monthly limit in rupees" style={{ ...field, width: 190 }} inputMode="numeric" placeholder={info ? `Monthly (default ${info.defaults.monthly})` : 'Monthly ₹'} value={monthly} onChange={(e) => setMonthly(e.target.value.replace(/\D/g, ''))} />
            <input aria-label="Why" style={{ ...field, flex: 1, minWidth: 180, width: 'auto' }} maxLength={160} placeholder="Why (required)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={busy || !info || note.trim().length < 3} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        </div>
      )}
    </div>
  );
}
