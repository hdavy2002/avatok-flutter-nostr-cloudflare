/* HostCalls — [HF-CALLS-1] Recent masked calls + [HF-ADMIN-CREDIT-1] the "Add test credits" panel (search by WhatsApp number, email or name, one-tap credit). Worker: GET /api/admin/hf/calls, GET /api/admin/hf/users/search?q=, POST /api/admin/hf/wallet/credit {uid|phone, rupees 1..2000, note}.
 * Test credits are the only money-in for now. Nothing under 14px. */
import { useCallback, useEffect, useState } from 'react';
import { hfAdminApi, type AdminCall, type AdminUserHit, type StdCallRow, type StdTotals } from '../../../lib/hfAdminApi';
import { toMs } from '../../../lib/hfCallsApi';
import { Banner, ConsultShell, Spinner, dateIST, fail } from '../consultants/kit';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis } from '../desi';
import { formatPaise } from '../../../lib/money';

const T14 = { fontSize: 14 } as const;
const field = { width: '100%', ...T14, padding: 10, borderRadius: 10, border: '1px solid var(--hf-admin-line)', minHeight: 44 } as const;

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
    <div style={{ display: 'grid', gap: 10, padding: 16, borderRadius: 20, background: 'linear-gradient(160deg, #fff 30%, var(--a-teatint))', border: '1px solid #cfe9eb', borderLeft: '8px solid var(--a-peacock)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ fontSize: 'var(--fs-body)' }}>{u.name || 'No name'}{u.isHost && <DesiChip tone="gold" className="ml-2">Influencer{u.hostSlug ? ` · ${u.hostSlug}` : ''}</DesiChip>}</strong>
        <strong className="hfa-amount" style={{ minWidth: 0, fontSize: 'var(--fs-big)', color: 'var(--a-peacock)' }}>Balance ₹{u.balanceRupees}</strong>
      </div>
      <div style={{ ...T14, display: 'grid', gap: 2, wordBreak: 'break-all' }}>
        <span>{u.phone || 'No phone on file'}{u.phone && (u.whatsappVerified ? ' · WhatsApp verified' : ' · not verified')}</span>
        <span>{u.email || 'No email'}</span>
        <span className="hfa-note">{u.uid}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {QUICK.map((n) => (
          <button key={n} type="button" className="hfa-btn gold" style={{ minWidth: 88 }} disabled={busy !== null} onClick={() => void credit(n)}>
            {busy === n ? 'Adding…' : `+ ₹${n}`}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Custom amount in rupees" style={{ ...field, width: 140 }} inputMode="numeric" placeholder="Custom ₹" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} />
        <input aria-label="Note (optional)" style={{ ...field, flex: 1, minWidth: 160, width: 'auto' }} value={note} maxLength={120} placeholder="Note (optional)" onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="hfa-btn ghost" disabled={!customOk || busy !== null} onClick={() => void credit(customAmt)}>{busy === customAmt && customOk ? 'Adding…' : 'Add'}</button>
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
      <summary style={{ ...T14, cursor: 'pointer', fontWeight: 800, minHeight: 44, display: 'flex', alignItems: 'center', color: 'var(--a-amber)' }}>Advanced: by user id</summary>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-uid">User id (uid)</label>
        <input id="cr-uid" style={field} value={uid} onChange={(e) => setUid(e.target.value)} autoComplete="off" placeholder="user_…" />
        <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-rs">Amount in rupees (1 to 2000)</label>
        <input id="cr-rs" style={field} inputMode="numeric" value={rupeesIn} onChange={(e) => setRupeesIn(e.target.value.replace(/\D/g, ''))} />
        <label style={{ ...T14, fontWeight: 800 }} htmlFor="cr-note">Note (why)</label>
        <input id="cr-note" style={field} value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="e.g. testing calls with Priya" />
        {err && <Banner tone="error">{err}</Banner>}
        {ok && <Banner tone="info">{ok}</Banner>}
        <div><button type="submit" className="hfa-btn gold" disabled={!valid || busy}>{busy ? 'Adding…' : 'Add test credits'}</button></div>
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
    <DesiCard tone="gold" corner="marigold" title="Add test credits" note="For testing only. Find the caller, then tap an amount. Every credit is logged.">
      <div style={{ display: 'grid', gap: 12 }}>
        <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input aria-label="WhatsApp number, email or name" style={{ ...field, flex: 1, minWidth: 200, width: 'auto' }} value={q} onChange={(e) => setQ(e.target.value)}
            autoComplete="off" placeholder="WhatsApp number, email or name" />
          <button type="submit" className="hfa-btn gold" disabled={!canSearch || busy}>{busy ? 'Searching…' : 'Search'}</button>
        </form>
        {err && <Banner tone="error">{err}</Banner>}
        {hits && hits.length === 0 && <div className="hfa-note" style={{ fontWeight: 700 }}>No one found for “{searched}”. Try the full number with country code, the full email, or part of the name.</div>}
        {hits && hits.length > 0 && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="hfa-note">{hits.length} found{hits.length === 20 ? ' (showing the first 20, narrow the search)' : ''}</div>
            {hits.map((u) => <UserRow key={u.uid} u={u} onBalance={setBalance} />)}
          </div>
        )}
        <AdvancedUidForm />
      </div>
    </DesiCard>
  );
}

/* [HF-STD-PLAN-1] Calls & margins: what each Standard-plan call cost the caller, what the host earned, the estimated phone cost and what is left for the platform.
 * Worker: GET /api/admin/hf/std/calls and /summary. Estimates only, before other expenses, never profit. */
const pn = (v: number | null | undefined): string => (v == null ? '—' : formatPaise(v));
function MarginsPanel() {
  const [rows, setRows] = useState<StdCallRow[] | null>(null);
  const [totals, setTotals] = useState<StdTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [c, t] = await Promise.all([hfAdminApi.stdCalls(), hfAdminApi.stdSummary().catch(() => null)]);
        if (!live) return;
        setRows(c.items); setTotals(t ?? c.totals ?? null);
      } catch (e) { if (live) { setError(fail('hf_std_calls', e)); setRows([]); } }
    })();
    return () => { live = false; };
  }, []);
  return (
    <DesiCard tone="lav" corner="jasmine" title="Calls & margins" note="Estimates before other expenses — not profit.">
      <div style={{ display: 'grid', gap: 12 }}>
        {error && <Banner tone="error">{error}</Banner>}
        {rows === null && <Spinner label="Loading…" />}
        {totals && (
          <DesiKpis>
            <DesiKpi tone="plum" label="Calls" value={totals.calls ?? '—'} />
            <DesiKpi tone="tea" label="Charged" value={pn(totals.chargePaise)} />
            <DesiKpi tone="lav" label="Influencers" value={pn(totals.hostPaise)} />
            <DesiKpi tone="rani" label="Phone est." value={pn(totals.phoneCostEstPaise)} />
            <DesiKpi tone="rani" label="Phone actual" value={pn(totals.phoneCostActualPaise)} />
            <DesiKpi tone="gold" label="Platform est." value={pn(totals.platformEstPaise)} />
          </DesiKpis>
        )}
        {rows && rows.length === 0 && !error && <DesiEmpty text="No Standard-plan calls yet." />}
        {rows && rows.length > 0 && (
          <div className="hfa-scroll">
            <table className="hfa-table">
              <thead><tr><th>When</th><th>Influencer</th><th>Charge</th><th>Influencer share</th><th>Phone est.</th><th>Phone actual</th><th>Platform est.</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>{dateIST(toMs(c.at ?? c.createdAt))}</td>
                    <td>{c.hostName || c.hostSlug || '—'}</td>
                    <td style={{ color: 'var(--a-peacock)', fontWeight: 800 }}>{pn(c.chargePaise)}</td><td>{pn(c.hostPaise)}</td><td>{pn(c.phoneCostEstPaise)}</td><td>{pn(c.phoneCostActualPaise)}</td>
                    <td>{pn(c.platformAfterActualPaise ?? c.platformEstPaise)}{c.platformAfterActualPaise != null ? ' (after actual phone cost)' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DesiCard>
  );
}

/** STD-PCO style call register: outcome colours the whole row, minutes shown as a big meter. */
function outcomeOf(status: string): { tone: 'tea' | 'gold' | 'rani' | 'lav'; bg: string; edge: string } {
  const s = String(status || '').toLowerCase();
  if (/(fail|miss|reject|declin|error|no.?answer|busy|cancel|expire)/.test(s)) return { tone: 'rani', bg: 'linear-gradient(100deg, #fff 30%, var(--a-blush))', edge: 'var(--a-rani)' };
  if (/(complet|ended|done|finish|success|paid)/.test(s)) return { tone: 'tea', bg: 'linear-gradient(100deg, #fff 30%, var(--a-teatint))', edge: 'var(--a-peacock)' };
  if (/(ring|connect|progress|live|active|pending|wait|start)/.test(s)) return { tone: 'gold', bg: 'linear-gradient(100deg, #fff 30%, var(--a-goldtint))', edge: 'var(--a-marigold)' };
  return { tone: 'lav', bg: 'linear-gradient(100deg, #fff 30%, var(--a-lavtint))', edge: 'var(--a-lav)' };
}
function CallRow({ c }: { c: AdminCall }) {
  const o = outcomeOf(c.status);
  return (
    <article style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 'clamp(10px, 1.6vw, 22px)', alignItems: 'center', padding: '14px clamp(14px, 1.6vw, 22px)', borderRadius: 20, background: o.bg, border: '1px solid var(--a-line)', borderLeft: `8px solid ${o.edge}`, boxShadow: 'var(--a-shadow)' }}>
      <div style={{ textAlign: 'center', minWidth: 76, padding: '8px 10px', borderRadius: 16, background: 'linear-gradient(150deg, var(--a-plum), #8a2b7d)', color: '#ffd166' }} aria-label={`Minutes billed: ${c.billedMinutes ?? 'none'}`}>
        <div className="hfa-amount" style={{ color: '#ffd166', minWidth: 0 }}>{c.billedMinutes ?? '—'}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>min</div>
      </div>
      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ fontSize: 'var(--fs-body)', overflowWrap: 'anywhere' }}>{c.hostName || c.hostSlug || c.hostUid || '—'}</strong>
          <DesiChip tone={o.tone}>{c.status}</DesiChip>
        </div>
        <div className="hfa-note" style={{ overflowWrap: 'anywhere' }}>{dateIST(toMs(c.createdAt))} · Caller {c.callerUid || '—'}</div>
        <div style={{ display: 'flex', gap: '6px 18px', flexWrap: 'wrap', fontSize: 'var(--fs-small)', fontWeight: 700 }}>
          <span style={{ color: 'var(--a-peacock)' }}>Charged {c.chargedPaise != null ? formatPaise(c.chargedPaise) : '—'}</span>
          <span style={{ color: 'var(--a-lav)' }}>Influencer share {c.hostEarningPaise != null ? formatPaise(c.hostEarningPaise) : '—'}</span>
          <span style={{ color: 'var(--a-muted)' }}>Ended by {c.endReason || '—'}</span>
        </div>
      </div>
    </article>
  );
}

export default function HostCalls() {
  const [rows, setRows] = useState<AdminCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setRows(null);
    try { setRows(await hfAdminApi.calls(setRows)); } catch (e) { setError(fail('hf_calls_list', e)); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <ConsultShell className="hf-admin-operations">
      <div className="hfa-stack">
        <CreditPanel />
        <MarginsPanel />
        <DesiCard tone="cream" pattern="stripes" title="Recent calls" note="The call register, newest first."
          action={<button type="button" className="hfa-btn ghost" onClick={() => void load()}>Refresh</button>}>
          <div style={{ display: 'grid', gap: 12 }}>
            {error && <Banner tone="error">{error}</Banner>}
            {rows === null && <Spinner label="Loading calls…" />}
            {rows && rows.length === 0 && !error && <DesiEmpty text="No calls yet." />}
            {rows && rows.map((c) => <CallRow key={c.id} c={c} />)}
          </div>
        </DesiCard>
      </div>
    </ConsultShell>
  );
}
