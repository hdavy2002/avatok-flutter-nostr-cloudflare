/* HostCalls — [HF-CALLS-1] Recent masked calls + [HF-ADMIN-CREDIT-1] the "Add test credits" panel (search by WhatsApp number, email or name, one-tap credit). Worker: GET /api/admin/hf/calls, GET /api/admin/hf/users/search?q=, POST /api/admin/hf/wallet/credit {uid|phone, rupees 1..2000, note}.
 * Test credits are the only money-in for now. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type AdminCall, type AdminUserHit } from '../../../lib/hfAdminApi';
import { toMs } from '../../../lib/hfCallsApi';
import { Banner, ConsultShell, Spinner, dateIST, fail, rupees } from '../consultants/kit';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid #c8afd1', minHeight: 44 } as const;

const QUICK = [100, 200, 500] as const;

/** One search result with its own quick-credit buttons. Balance updates inline after a credit. */
function UserRow({ u, onBalance }: { u: AdminUserHit; onBalance: (uid: string, bal: number) => void }) {
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const customAmt = Number(custom);
  const customOk = Number.isInteger(customAmt) && customAmt >= 1 && customAmt <= 2000;

  const credit = async (amount: number) => {
    setBusy(amount); setMsg(null);
    try {
      const r = await hfAdminApi.creditWallet({ uid: u.uid, rupees: amount, note: note.trim() || 'Test credits', via: 'search', opId: crypto.randomUUID() });
      onBalance(u.uid, r.balanceRupees);
      setMsg({ tone: 'info', text: `Added ₹${amount}. New balance ₹${r.balanceRupees}.` });
      setCustom('');
    } catch (e2) { setMsg({ tone: 'error', text: fail('hf_credit', e2) }); }
    setBusy(null);
  };
  return (
    <div className="card" style={{ background: '#fff', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 16 }}>{u.name || 'No name'}{u.isHost && <span className="chip gold" style={{ ...T14, marginLeft: 8 }}>Host{u.hostSlug ? ` · ${u.hostSlug}` : ''}</span>}</strong>
        <strong style={{ fontSize: 16 }}>Balance ₹{u.balanceRupees}</strong>
      </div>
      <div style={{ ...T14, display: 'grid', gap: 2, wordBreak: 'break-all' }}>
        <span>{u.phone || 'No phone on file'}{u.phone && (u.whatsappVerified ? ' · WhatsApp verified' : ' · not verified')}</span>
        <span>{u.email || 'No email'}</span>
        <span className="muted">{u.uid}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {QUICK.map((n) => (
          <button key={n} type="button" className="btn small" style={{ ...T14, minHeight: 44, minWidth: 80 }} disabled={busy !== null} onClick={() => void credit(n)}>
            {busy === n ? 'Adding…' : `+ ₹${n}`}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Custom amount in rupees" style={{ ...field, width: 140 }} inputMode="numeric" placeholder="Custom ₹" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} />
        <input aria-label="Note (optional)" style={{ ...field, flex: 1, minWidth: 160, width: 'auto' }} value={note} maxLength={120} placeholder="Note (optional)" onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn ghost small" style={{ ...T14, minHeight: 44 }} disabled={!customOk || busy !== null} onClick={() => void credit(customAmt)}>{busy === customAmt && customOk ? 'Adding…' : 'Add'}</button>
      </div>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
    </div>
  );
}

function AdvancedUidForm() {
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
      setOk(`Added ₹${amount} to ${r.name || r.uid}. New balance: ₹${r.balanceRupees}.`);
      setRupeesIn(''); setNote('');
    } catch (e2) { setErr(fail('hf_credit', e2)); }
    setBusy(false);
  };
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ ...T14, cursor: 'pointer', fontWeight: 800, minHeight: 44, display: 'flex', alignItems: 'center' }}>Advanced: by user id</summary>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 8 }}>
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
    </details>
  );
}

function CreditPanel() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<AdminUserHit[] | null>(null);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canSearch = q.trim().length >= 2;

  const search = async (e: React.FormEvent) => {
    e.preventDefault(); if (!canSearch) return;
    setBusy(true); setErr(null);
    try { setHits(await hfAdminApi.searchUsers(q.trim())); setSearched(q.trim()); }
    catch (e2) { setErr(fail('hf_user_search', e2)); setHits(null); }
    setBusy(false);
  };
  const setBalance = (uid: string, bal: number) => setHits((h) => (h ? h.map((x) => (x.uid === uid ? { ...x, balanceRupees: bal } : x)) : h));

  return (
    <section className="card" style={{ background: '#fff', display: 'grid', gap: 10, marginBottom: 18 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Add test credits</h2>
      <p className="muted" style={{ margin: 0, ...T14 }}>For testing only. Find the caller, then tap an amount. Every credit is logged.</p>
      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="WhatsApp number, email or name" style={{ ...field, flex: 1, minWidth: 200, width: 'auto' }} value={q} onChange={(e) => setQ(e.target.value)}
          autoComplete="off" placeholder="WhatsApp number, email or name" />
        <button type="submit" className="btn small" style={{ ...T14, minHeight: 44 }} disabled={!canSearch || busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {err && <Banner tone="error">{err}</Banner>}
      {hits && hits.length === 0 && <div className="muted" style={{ fontWeight: 700, ...T14 }}>No one found for “{searched}”. Try the full number with country code, the full email, or part of the name.</div>}
      {hits && hits.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="muted" style={T14}>{hits.length} found{hits.length === 20 ? ' (showing the first 20, narrow the search)' : ''}</div>
          {hits.map((u) => <UserRow key={u.uid} u={u} onBalance={setBalance} />)}
        </div>
      )}
      <AdvancedUidForm />
    </section>
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
      <CreditPanel />
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
