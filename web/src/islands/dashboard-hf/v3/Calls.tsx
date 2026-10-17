/* [HF-DASH-V3-1] Calls: this month's numbers, every call you made (or received, for influencers), filters, search, a detail sheet with
 * rating, "call again" and Block & report. Worker: GET /api/hf/calls, GET /api/hf/calls/:id, POST /api/hf/calls/:id/review,
 * POST /api/hf/calls/:id/block, GET /api/hf/me/insights (month numbers and calls still waiting for a rating). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { hfCall, type CallInfo } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import { rateCardLines } from '../../../lib/hfStdPlan';
import { capture, captureException } from '../../../lib/analytics';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { blockFromCall, reviewCall, useDash } from './data';
import { Avatar, Card, Dialog, Empty, Failed, Ic, PageHead, Skel, Sticker, durationText, fmtInt, istDay, istTime, minutes, useToast } from './ui';

type Role = 'caller' | 'host';
type Tab = 'all' | 'completed' | 'missed' | 'rate';
interface Item { id: string; status: string; otherHandle: string; hostSlug: string | null; at: number; seconds: number; amountPaise: number | null; endReason: string | null }

function outcome(i: { status: string }, role: Role): { text: string; cls: string } {
  switch (i.status) {
    case 'completed': return { text: 'Completed', cls: '' };
    case 'connected': return { text: 'On a call now', cls: 'gold' };
    case 'ringing_host': case 'ringing_caller': return { text: 'Ringing', cls: 'gold' };
    case 'host_declined': return { text: role === 'host' ? 'You declined' : 'Declined', cls: 'dec' };
    case 'no_answer': return { text: role === 'host' ? 'Missed' : 'Not answered', cls: 'miss' };
    case 'caller_no_answer': return { text: role === 'host' ? 'Caller didn’t pick up' : 'You didn’t pick up', cls: 'miss' };
    case 'cancelled': return { text: 'Cancelled', cls: 'dec' };
    case 'blocked': return { text: 'Ended and blocked', cls: 'dec' };
    default: return { text: 'Not connected', cls: 'dec' };
  }
}

export default function Calls({ account }: { account: DashboardAccount }) {
  const { insights, wallet, reload } = useDash();
  const toast = useToast();
  const isHost = !!account.host && !account.closing;
  const qs = new URLSearchParams(location.search);
  const [role, setRole] = useState<Role>(qs.get('role') === 'host' && isHost ? 'host' : 'caller');
  const [tab, setTab] = useState<Tab>(qs.get('tab') === 'rate' ? 'rate' : 'all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [off, setOff] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(location.hash.length > 4 ? location.hash.slice(1) : null);
  const seq = useRef(0);
  const ins = insights.data;
  const toRate = new Set(ins?.pendingReviews.map(p => p.callId) ?? []);

  const load = useCallback(async (cursor: string | null) => {
    if (tab === 'rate') return;
    const my = ++seq.current;
    setFailed(false);
    if (cursor) setMore(true); else { setItems(null); setNext(null); }
    const p = new URLSearchParams({ role, status: tab, limit: '30' });
    if (cursor) p.set('cursor', cursor);
    const r = await hfCall<{ items?: Item[]; nextCursor?: string | null }>('GET', `/api/hf/calls?${p}`);
    if (my !== seq.current) return;
    setMore(false);
    if (!r.ok) {
      if (r.status === 404 || r.status === 503) { setOff(true); return; }
      captureException(new Error(`hf_dash3_calls_${r.status}_${r.code}`), { area: 'hf_dash_v3', step: 'calls_list' });
      setFailed(true); if (!cursor) setItems([]); return;
    }
    const page = Array.isArray(r.data.items) ? r.data.items : [];
    setItems(prev => (cursor && prev ? [...prev, ...page] : page)); setNext(r.data.nextCursor ?? null);
    capture('hf_calls_list_load', { role, status: tab, count: page.length, surface: 'dash_v3' });
  }, [role, tab]);
  useEffect(() => { void load(null); }, [load, account.uid]);

  const ql = q.trim().toLowerCase();
  const rows: Item[] = tab === 'rate'
    ? (ins?.pendingReviews ?? []).map(p => ({ id: p.callId, status: 'completed', otherHandle: p.hostName, hostSlug: p.hostSlug, at: p.at, seconds: p.seconds, amountPaise: null, endReason: null }))
    : (items ?? []);
  const shown = rows.filter(r => !ql || r.otherHandle.toLowerCase().includes(ql));
  const tiers = wallet.data?.plan?.tiers;

  return <>
    <PageHead eyebrow="Calls" title="Every call, ek jagah" sub="Calls you made, missed and declined — newest first. Tap a call for details, rating or block." art={<Sticker name="panipilo" w={130} rot={6} />} />
    <section className="h3-kpis">
      {([['Completed · this month', ins ? fmtInt(ins.month.calls) : '—', 'phone', 'var(--teatint)', 'var(--peacock)'], ['Not connected · this month', ins ? fmtInt(ins.month.missed) : '—', 'bell', 'var(--blush)', 'var(--rani)'],
        ['Minutes talked · this month', ins ? fmtInt(minutes(ins.month.seconds)) : '—', 'clock', 'var(--lavtint)', 'var(--lav)'], ['Spent · this month', ins ? formatPaise(ins.month.paise) : '—', 'wallet', 'var(--goldtint)', 'var(--amber)']] as const)
        .map(([l, v, i, bg, fg]) => <div key={l} className="h3-card h3-kpi"><div className="ic" style={{ background: bg, color: fg }}><Ic name={i} className="" /></div><div className="lbl">{l}</div><div className="big num">{v}</div></div>)}
    </section>
    <section className="h3-row c21">
      <Card title="Call history" note="Handles only. Calls are never recorded.">
        {off ? <p role="status">Calls are not available right now. Please check back soon.</p> : <>
          {isHost && <div className="h3-tabs" role="tablist" aria-label="Whose calls">
            <button type="button" role="tab" aria-selected={role === 'caller'} className={role === 'caller' ? 'on' : ''} onClick={() => setRole('caller')}>Calls you made</button>
            <button type="button" role="tab" aria-selected={role === 'host'} className={role === 'host' ? 'on' : ''} onClick={() => setRole('host')}>Calls you received</button></div>}
          <div className="h3-tabs" role="group" aria-label="Filter calls">{([['all', 'All'], ['completed', 'Completed'], ['missed', 'Not connected'], ...(role === 'caller' ? [['rate', `To rate${toRate.size ? ` (${toRate.size})` : ''}`]] : [])] as [Tab, string][])
            .map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          <input type="search" placeholder="Search by name" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: '20rem' }} aria-label="Search calls" />
          <div style={{ height: 10 }} />
          <div className="h3-scroll" style={{ maxHeight: '34rem' }} aria-live="polite">
            {failed && <Failed onRetry={() => void load(null)} />}
            {(tab !== 'rate' && items === null) || (tab === 'rate' && !ins) ? <Skel h={260} /> : shown.length === 0 ? <Empty text={tab === 'rate' ? 'Sab rated! Nothing waiting for your stars.' : 'No calls to show here yet.'}>{role === 'caller' && tab === 'all' && <a className="h3-btn sm rani" href="/marketplace">Find someone to talk to</a>}</Empty> :
              <table className="h3-table"><thead><tr><th>{role === 'host' ? 'Caller' : 'Influencer'}</th><th className="hide-n">When</th><th className="r">Time</th><th className="r">{role === 'host' ? 'Earned' : 'Charged'}</th><th>Status</th><th className="hide-n">Rating</th></tr></thead>
                <tbody>{shown.map(c => { const o = outcome(c, role); return <tr key={c.id} id={c.id} onClick={() => { setOpen(c.id); capture('hf_dash3_call_open', { role }); }}>
                  <td><div className="h3-who"><Avatar name={c.otherHandle} seed={c.otherHandle} /><span><b>{c.otherHandle}</b><small>{istDay(c.at)}</small></span></div></td>
                  <td className="hide-n small">{istDay(c.at)}, {istTime(c.at)}</td>
                  <td className="r">{c.status === 'completed' ? durationText(c.seconds) : '—'}</td>
                  <td className="r">{c.amountPaise != null ? formatPaise(c.amountPaise) : '—'}</td>
                  <td><span className={`h3-chip ${o.cls}`}>{o.text}</span></td>
                  <td className="hide-n">{role === 'caller' && toRate.has(c.id) ? <button type="button" className="h3-btn sm gold" onClick={e => { e.stopPropagation(); setOpen(c.id); }}>★ Rate karo</button> : <span className="small muted">—</span>}</td>
                </tr>; })}</tbody></table>}
            {next && tab !== 'rate' && <button type="button" className="h3-btn sm ghost" style={{ marginTop: 10 }} disabled={more} onClick={() => void load(next)}>{more ? 'Loading…' : 'Load more'}</button>}
          </div>
        </>}
      </Card>
      <Card title="How calls are billed" note="Simple and fair, by the minute" tone={1}>
        <div style={{ display: 'grid', gap: 10 }}>
          {[['⏱️', 'Billed by the minute of connected time, at the influencer’s rate.'], ['🔔', 'Ringing, declined, missed or a failed connection costs ₹0.'],
            ['💰', 'You need 2 minutes of balance to start a call.'], ['⌛', 'A call can last up to 60 minutes; you hear a heads-up near the end.'],
            ['#️⃣', 'Press # any time to end the call, block the person and report it.'], ['🧾', 'Charged for a call that never connected? It comes back to your wallet.']]
            .map(([e, t]) => <div key={t} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><span style={{ fontSize: 20 }} aria-hidden="true">{e}</span><span>{t}</span></div>)}
          {wallet.data?.mode === 'rupees' && <div className="h3-break"><b>Standard plan</b>{rateCardLines(tiers).map(l => <div key={l}><span>{l}</span></div>)}</div>}
        </div>
      </Card>
    </section>
    <CallSheet id={open} role={role} canRate={!!open && toRate.has(open)} onClose={() => { setOpen(null); if (location.hash) history.replaceState(null, '', location.pathname + location.search); }}
      onDone={(m) => { toast(m); reload('insights'); void load(null); }} />
  </>;
}

const REASONS: [string, string][] = [['rude', 'They were rude'], ['money_or_otp', 'They asked for money or an OTP'], ['inappropriate', 'Inappropriate talk'], ['other', 'Something else']];

function CallSheet({ id, role, canRate, onClose, onDone }: { id: string | null; role: Role; canRate: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [info, setInfo] = useState<CallInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<'view' | 'rate' | 'block'>('view');
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('rude');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setInfo(null); setFailed(false); setMode(canRate ? 'rate' : 'view'); setStars(0); setText(''); setErr('');
    if (!id) return;
    let live = true;
    void hfCall<CallInfo>('GET', `/api/hf/calls/${encodeURIComponent(id)}`).then(r => { if (!live) return; if (r.ok) setInfo(r.data); else setFailed(true); });
    return () => { live = false; };
  }, [id, canRate]);
  const sendRating = async () => {
    if (!id || !stars) { setErr('Pick some stars first ⭐'); return; }
    setBusy(true); setErr('');
    const r = await reviewCall(id, stars, text);
    setBusy(false);
    if (r.ok) { capture('hf_dash3_review_sent', { stars }); onClose(); onDone('Shukriya! Your review is with our team 🌼'); }
    else setErr(r.message || 'We could not send that. Please try again.');
  };
  const sendBlock = async () => {
    if (!id) return;
    setBusy(true); setErr('');
    const r = await blockFromCall(id, reason);
    setBusy(false);
    if (r.ok) { onClose(); onDone('Blocked and reported. Nazar na lage! 🧿'); }
    else setErr(r.message || 'We could not do that. Please try again.');
  };
  const name = info?.hostName || 'this person';
  const sec = info?.billableSeconds ?? (info?.billedMinutes ?? 0) * 60;
  return <Dialog open={!!id} onClose={onClose} label="Call details">
    {failed ? <Failed text="We could not load this call." /> : !info ? <Skel h={200} /> : mode === 'rate' ? <div style={{ textAlign: 'center' }}>
      <Sticker name="chugli" w={110} rot={-4} /><h2 style={{ marginTop: 10 }}>Kaisi rahi baat with {name}?</h2>
      <p className="small muted">Only your first name and stars are shown. Our team checks every review first.</p>
      <div className="h3-stars" style={{ justifyContent: 'center', margin: '12px 0' }}>{[1, 2, 3, 4, 5].map(i => <button key={i} type="button" className={i <= stars ? 'on' : ''} aria-label={`${i} star${i > 1 ? 's' : ''}`} onClick={() => setStars(i)}>★</button>)}</div>
      <textarea rows={3} maxLength={500} placeholder="Kuch accha laga? Likh do (optional)" value={text} onChange={e => setText(e.target.value)} />
      {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
      <div className="acts"><button type="button" className="h3-btn rani" disabled={busy} onClick={sendRating}>{busy ? 'Sending…' : 'Send'}</button><button type="button" className="h3-btn ghost" onClick={() => setMode('view')}>Later</button></div>
    </div> : mode === 'block' ? <div style={{ textAlign: 'center' }}>
      <Sticker name="nazar" w={110} rot={-4} /><h2 style={{ marginTop: 10 }}>Block {name}?</h2>
      <p className="muted small">They won’t be able to call you or reach you again, and our team will look at what happened. You can unblock from your Profile.</p>
      <select style={{ marginTop: 12 }} value={reason} onChange={e => setReason(e.target.value)} aria-label="Why">{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
      <div className="acts"><button type="button" className="h3-btn danger" disabled={busy} onClick={sendBlock}>{busy ? 'Please wait…' : 'Block & report'}</button><button type="button" className="h3-btn ghost" onClick={() => setMode('view')}>Cancel</button></div>
    </div> : <>
      <div className="h3-who" style={{ marginBottom: 12 }}><Avatar name={name} seed={name} size="" /><span><b style={{ fontSize: 20 }}>{name}</b><small>{info.hostSlug ? `@${info.hostSlug}` : ''}</small></span></div>
      <div className="h3-break">
        <div><span>Status</span><b>{outcome(info, role).text}</b></div>
        <div><span>Talk time</span><b>{sec ? durationText(sec) : '—'}</b></div>
        {(info.tiers ?? []).map((t, i) => <div key={i} className="muted"><span>{t.toMin == null ? `After ${t.fromMin} min` : `${t.fromMin}–${t.toMin} min`} · {formatPaise(t.paisePerMin)}/min</span><span>{formatPaise(t.amountPaise)}</span></div>)}
        <div className="tot"><span>{role === 'host' ? 'You earned' : 'Charged'}</span><span>{role === 'host' ? (info.earning ?? (info.earningPaise != null ? formatPaise(info.earningPaise) : '—')) : (info.charged ?? (info.chargedPaise != null ? formatPaise(info.chargedPaise) : info.chargedRupees != null ? formatPaise(info.chargedRupees * 100) : '—'))}</span></div>
      </div>
      <div className="acts">
        {canRate && <button type="button" className="h3-btn gold" onClick={() => setMode('rate')}>★ Rate this call</button>}
        {role === 'caller' && info.hostSlug && <a className="h3-btn rani" href={`/h/${info.hostSlug}`}><Ic name="phone" className="" />Call again</a>}
        <button type="button" className="h3-btn ghost" onClick={() => setMode('block')}>Block & report</button>
      </div>
    </>}
  </Dialog>;
}
