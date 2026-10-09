/* HostCalls — [HF-CALLS-1] Recent masked calls + the "Add test credits" form. Worker: GET /api/admin/hf/calls, POST /api/admin/hf/wallet/credit {uid, rupees 1..2000, note}.
 * Test credits are the only money-in for now. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type AdminCall } from '../../../lib/hfAdminApi';
import { toMs } from '../../../lib/hfCallsApi';
import { Banner, ConsultShell, Spinner, dateIST, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

function CreditForm() {
  const [uid, setUid] = useState('');
  const [rupeesIn, setRupeesIn] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const amount = Number(rupeesIn);
  const valid = uid.trim().length > 3 && Number.isInteger(amount) && amount >= 1 && amount <= 2000 && note.trim().length >= 3;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!valid) return;
    setBusy(true); setOk(null); setErr(null);
    try {
      const r = await hfAdminApi.creditWallet({ uid: uid.trim(), rupees: amount, note: note.trim() });
      const bal = r.balanceRupees ?? r.balance;
      setOk(`Added ₹${amount} test credits.${bal != null ? ` New balance: ₹${bal}.` : ''}`);
      setRupeesIn(''); setNote('');
    } catch (e2) { setErr(fail('hf_credit', e2)); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={submit} style={{ background: '#fff', display: 'grid', gap: 10, marginBottom: 18 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Add test credits</h2>
      <p className="muted" style={{ margin: 0, ...T14 }}>For testing only. Credits go to the user’s wallet and are logged. Use the user id (uid), not a phone number.</p>
      <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-uid">User id (uid)</label>
      <input id="cr-uid" style={field} value={uid} onChange={(e) => setUid(e.target.value)} autoComplete="off" placeholder="user_…" />
      <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-rs">Amount in rupees (1 to 2000)</label>
      <input id="cr-rs" style={field} inputMode="numeric" value={rupeesIn} onChange={(e) => setRupeesIn(e.target.value.replace(/\D/g, ''))} />
      <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-note">Note (why)</label>
      <input id="cr-note" style={field} value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="e.g. testing calls with Priya" />
      {err && <Banner tone="error">{err}</Banner>}
      {ok && <Banner tone="info">{ok}</Banner>}
      <div><button type="submit" className="btn small" style={T14} disabled={!valid || busy}>{busy ? 'Adding…' : 'Add test credits'}</button></div>
    </form>
  );
}

export default function HostCalls() {
  const [rows, setRows] = useState<AdminCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await hfAdminApi.calls()); } catch (e) { setError(fail('hf_calls_list', e)); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <ConsultShell>
      <CreditForm />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Recent calls</h2>
        <button type="button" className="btn ghost small" style={T14} onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div style={{ marginBottom: 12 }}><Banner tone="error">{error}</Banner></div>}
      {rows === null && <Spinner label="Loading calls…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700, ...T14 }}>No calls yet.</div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
          <table className="t" style={T14}>
            <thead><tr><th>When</th><th>Host</th><th>Caller</th><th>Status</th><th>Min</th><th>Charged</th><th>Host share</th><th>Ended by</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{dateIST(toMs(c.createdAt))}</td>
                  <td>{c.hostName || c.hostSlug || c.hostUid || '—'}</td>
                  <td style={{ wordBreak: 'break-all' }}>{c.callerUid || '—'}</td>
                  <td>{c.status}</td>
                  <td>{c.billedMinutes ?? '—'}</td>
                  <td>{c.chargedPaise != null ? rupees(c.chargedPaise / 100) : '—'}</td>
                  <td>{c.hostEarningPaise != null ? rupees(c.hostEarningPaise / 100) : '—'}</td>
                  <td>{c.endReason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsultShell>
  );
}
