/* [AUMFE-CONSULT-F3-1 2026-10-02] Consultant desk pages (one island, `page` picks the screen):
 *   today        -> DeskToday mockup: next session card (countdown + Join), later list, alerts, Today/Upcoming/Past tabs
 *   rate         -> DeskRate mockup: live calculator (rate -> GST -> customer pays -> fee -> you receive)
 *   availability -> weekly rules + days off + slot length (GET/PUT /desk/availability)
 *   customers    -> people this consultant has served
 * The file + call screen is FilePage.tsx. Prices come from the server (priceFor); the live preview uses the server's
 * gst/fee percentages and the saved result replaces it. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { DISCIPLINE_LABEL } from '../../lib/consultTypes';
import type { DeskBookingDTO, Discipline, PriceBreakdown } from '../../lib/consultTypes';
import {
  errMessage, getAvailability, getDeskBookings, getDeskCustomers, putAvailability, putRate,
} from '../../lib/consultDeskApi';
import type { AvailabilityException, AvailabilityRule, DeskAvailability, DeskCustomer, DeskScope } from '../../lib/consultDeskApi';
import { DeskRoot, DISC_CHIP, dayIst, inMinutes, inr, slotRange, timeIst, useDesk, useNow } from './shared';
import { joinWindowOpen } from './callUi';

function Toast({ msg }: { msg: string | null }) { return msg ? <div className="cd-toast" role="status">{msg}</div> : null; }
function useToast(): [string | null, (m: string) => void] {
  const [m, setM] = useState<string | null>(null);
  useEffect(() => { if (!m) return undefined; const t = setTimeout(() => setM(null), 2600); return () => clearTimeout(t); }, [m]);
  return [m, setM];
}
function Err({ children }: { children: ReactNode }) { return <div className="card" role="alert" style={{ background: '#fbe1dc', borderColor: '#f0b8ae' }}><p style={{ fontWeight: 700 }}>{children}</p></div>; }
const discChip = (d: Discipline) => <span className={`chip ${DISC_CHIP[d] ?? ''}`}>{DISCIPLINE_LABEL[d].en}</span>;

/* ───────────────────────── Today ───────────────────────── */

function Today() {
  const { me } = useDesk();
  const initial = (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('scope') : null) as DeskScope | null;
  const [scope, setScope] = useState<DeskScope>(initial === 'upcoming' || initial === 'past' ? initial : 'today');
  const [rows, setRows] = useState<DeskBookingDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(15_000);

  const load = useCallback(async () => {
    setErr(null);
    try { setRows(await getDeskBookings(scope)); capture('consult_desk_viewed', { screen: 'today', scope }); }
    catch (e) { captureException(e, { where: 'consult_desk_bookings' }); setErr(errMessage(e, 'We could not load your bookings. Please try again.')); }
  }, [scope]);
  useEffect(() => { setRows(null); void load(); }, [load]);

  const live = (rows ?? []).filter((b) => b.status === 'confirmed' || b.status === 'in_call');
  const next = scope === 'past' ? null : live.find((b) => b.slot_end_ms + 5 * 60_000 > now) ?? null;
  const later = (rows ?? []).filter((b) => b !== next);
  const alerts = live.filter((b) => b.prep_status === 'partial' || b.prep_status === 'failed' || b.prep_status === 'pending');

  const who = (b: DeskBookingDTO) => [b.customer.age != null ? String(b.customer.age) : null, b.customer.city, b.customer.repeat ? 'repeat customer' : 'first session'].filter(Boolean).join(' · ');

  return (
    <>
      <div className="cd-tabs" role="tablist" aria-label="Which sessions">
        {(['today', 'upcoming', 'past'] as DeskScope[]).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={scope === s} className={`slot${scope === s ? ' on' : ''}`} onClick={() => setScope(s)}>{s === 'today' ? 'Today' : s === 'upcoming' ? 'Upcoming' : 'Past'}</button>
        ))}
      </div>
      {err ? <Err>{err}</Err> : null}
      {!rows && !err ? <p className="muted" aria-busy="true">Loading…</p> : null}
      {next ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, border: '2px solid #07545b', background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="label">{now >= next.slot_start_ms ? 'Now' : `Next · in ${inMinutes(next.slot_start_ms - now)}`}</span>
            {discChip(next.discipline)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <strong style={{ fontSize: 20 }}>{next.customer.name}</strong>
            <span className="muted" style={{ fontSize: 15 }}>{slotRange(next.slot_start_ms, next.slot_end_ms)} · {who(next)}</span>
          </div>
          {next.questions[0] ? <span style={{ fontSize: 15 }}>“{next.questions[0]}”</span> : null}
          <div className="cd-row">
            <a className="btn" href={`/desk/bookings/${next.id}?join=1`} style={{ flexGrow: 1, opacity: joinWindowOpen(next, now) ? 1 : 0.85 }}>{joinWindowOpen(next, now) ? 'Join call' : `Join opens in ${inMinutes(next.join_opens_ms - now)}`}</a>
            <a className="btn ghost" href={`/desk/bookings/${next.id}`}>Open file</a>
          </div>
        </div>
      ) : rows && !err ? (
        <div className="card" style={{ background: '#fff' }}><p className="muted">{scope === 'today' ? `No more sessions today. Your rate is ₹${inr(me.consultant.price.rate)} per ${me.consultant.slot_minutes} minutes.` : scope === 'upcoming' ? 'No upcoming sessions yet.' : 'No past sessions yet.'}</p></div>
      ) : null}
      {later.length ? <span className="label">{scope === 'today' ? 'Later today' : scope === 'upcoming' ? 'Upcoming' : 'Past sessions'}</span> : null}
      {later.map((b) => (
        <a key={b.id} className="card cd-link-card" href={`/desk/bookings/${b.id}`}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <strong style={{ fontSize: 17 }}>{b.customer.name}</strong>
            <span className="hint">{scope === 'today' ? '' : `${dayIst(b.slot_start_ms)} · `}{timeIst(b.slot_start_ms)} · {DISCIPLINE_LABEL[b.discipline].en} · {b.customer.repeat ? 'repeat customer' : b.prep_status === 'ready' ? 'file ready' : b.status.replace(/_/g, ' ')}</span>
          </div>
          <span style={{ fontSize: 22, color: '#07545b' }} aria-hidden="true">›</span>
        </a>
      ))}
      {alerts.map((b) => (
        <div key={`a${b.id}`} className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fbe7c2', borderColor: '#e8cf96' }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>
            {b.prep_status === 'pending' ? `${b.customer.name}'s file is still being prepared.` : `${b.customer.name}'s file is incomplete: some cards could not be prepared. Open the file to fill them in.`}
          </span>
        </div>
      ))}
    </>
  );
}

/* ───────────────────────── Rate ───────────────────────── */

function Rate() {
  const { me, earnings } = useDesk();
  const c = me.consultant;
  const [rate, setRate] = useState<number>(c.price.rate);
  const [text, setText] = useState<string>(String(c.price.rate));
  const [saved, setSaved] = useState<PriceBreakdown>(c.price);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, say] = useToast();
  const gst = c.price.gst_rate_pct ?? 18;
  const fee = c.price.fee_rate_pct ?? 20;
  const floor = me.rate_floor; const ceil = me.rate_ceil;
  const r = Number.isFinite(rate) ? rate : 0;
  const calc = { gst: Math.round((r * gst) / 100), total: Math.round(r + (r * gst) / 100), fee: Math.round((r * fee) / 100), payout: Math.round(r - (r * fee) / 100) };
  const valid = Number.isInteger(r) && r >= floor && r <= ceil;
  const names = c.disciplines.map((d) => DISCIPLINE_LABEL[d].en.toLowerCase()).join(', ');

  const set = (v: number, fromText = false) => { setRate(v); if (!fromText) setText(String(v)); };
  const save = async () => {
    if (!valid) { setErr(`Choose a rate between ₹${inr(floor)} and ₹${inr(ceil)}.`); return; }
    setBusy(true); setErr(null);
    try { const res = await putRate(r); setSaved(res.price); say('Rate saved'); capture('consult_rate_saved', { rate: r }); }
    catch (e) { captureException(e, { where: 'consult_rate_save' }); setErr(errMessage(e, 'We could not save the rate. Please try again.')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h1 className="cd-desktop-only" style={{ fontSize: 26 }}>Rate and earnings</h1>
      <div className="cd-grid2">
        <div className="field"><label htmlFor="len">Session length</label><select id="len" disabled value={c.slot_minutes}><option value={c.slot_minutes}>{c.slot_minutes} minutes</option></select></div>
        <div className="field"><label htmlFor="rate">Your rate (₹)</label>
          <input id="rate" inputMode="numeric" value={text} style={{ fontWeight: 900, fontSize: 20 }} aria-invalid={!valid}
            onChange={(e) => { const t = e.target.value.replace(/[^\d]/g, ''); setText(t); set(t === '' ? NaN : Number(t), true); }}
            onBlur={() => setText(Number.isFinite(rate) ? String(rate) : '')} /></div>
      </div>
      <input type="range" min={floor} max={ceil} step={50} value={Number.isFinite(rate) ? Math.min(ceil, Math.max(floor, rate)) : floor} onChange={(e) => set(Number(e.target.value))} aria-label="Rate per session" style={{ width: '100%', accentColor: '#07545b', minHeight: 32 }} />
      <span className="hint" style={{ color: valid ? undefined : '#9a1f19', fontWeight: valid ? 400 : 800 }}>Allowed range for {names}: ₹{inr(floor)} – ₹{inr(ceil)} (set by admin).</span>
      <div className="cd-grid2">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#fff' }}>
          <span className="label">What the customer pays</span>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Your rate</span><span>₹{inr(r)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>GST {gst}% (added)</span><span>+ ₹{inr(calc.gst)}</span></div>
          <div style={{ height: 1, background: '#e6d9b8' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 22, fontWeight: 900, color: '#07545b' }}><span>Customer pays</span><span>₹{inr(calc.total)}</span></div>
        </div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#f6ead0', borderColor: '#e2cf9f' }}>
          <span className="label">What reaches your wallet</span>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Customer pays</span><span>₹{inr(calc.total)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>GST to government</span><span>− ₹{inr(calc.gst)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Platform fee {fee}%</span><span>− ₹{inr(calc.fee)}</span></div>
          <div style={{ height: 1, background: '#e2cf9f' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 22, fontWeight: 900, color: '#6b4e12' }}><span>You receive</span><span>₹{inr(calc.payout)}</span></div>
        </div>
      </div>
      <p className="hint">Paid into your wallet when the call completes. Withdraw to UPI any time.</p>
      {err ? <Err>{err}</Err> : null}
      <button type="button" className="btn" disabled={busy || !valid || r === saved.rate} onClick={() => void save()} style={{ opacity: busy || !valid || r === saved.rate ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save rate'}</button>
      <p className="hint" style={{ textAlign: 'center' }}>New rate applies to bookings made after you save. Current saved rate: ₹{inr(saved.rate)} (customers pay ₹{inr(saved.total)}).</p>
      {earnings && (earnings.month_total_rupees != null || earnings.pending_rupees != null) ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#fff' }}>
          <h3>Earnings this month</h3>
          <div className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
            {earnings.month_total_rupees != null ? <><span className="k">Paid to your wallet</span><span className="v">₹{inr(earnings.month_total_rupees)}</span></> : null}
            {earnings.month_sessions != null ? <><span className="k">Completed sessions</span><span className="v">{earnings.month_sessions}</span></> : null}
            {earnings.pending_rupees != null ? <><span className="k">Still to settle</span><span className="v">₹{inr(earnings.pending_rupees)}</span></> : null}
          </div>
        </div>
      ) : null}
      <Toast msg={toast} />
    </>
  );
}

/* ───────────────────────── Availability ───────────────────────── */

const DAYS = [{ n: 1, l: 'Monday' }, { n: 2, l: 'Tuesday' }, { n: 3, l: 'Wednesday' }, { n: 4, l: 'Thursday' }, { n: 5, l: 'Friday' }, { n: 6, l: 'Saturday' }, { n: 0, l: 'Sunday' }];
const SLOT_OPTIONS = [15, 20, 30, 45, 60];
const BUFFER_OPTIONS = [0, 5, 10, 15];

function validate(rules: AvailabilityRule[]): string | null {
  for (const d of DAYS) {
    const w = rules.filter((r) => r.weekday === d.n).sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < w.length; i++) {
      if (!w[i].start || !w[i].end || w[i].end <= w[i].start) return `${d.l}: each window must end after it starts.`;
      if (i > 0 && w[i].start < w[i - 1].end) return `${d.l}: two windows overlap.`;
    }
  }
  return null;
}

function Availability() {
  const [a, setA] = useState<DeskAvailability | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState('');
  const [toast, say] = useToast();
  useEffect(() => {
    void getAvailability().then((x) => setA({ rules: x.rules ?? [], exceptions: x.exceptions ?? [], slot_minutes: x.slot_minutes, buffer_minutes: x.buffer_minutes ?? 0 }))
      .catch((e) => { captureException(e, { where: 'consult_availability_load' }); setErr(errMessage(e, 'We could not load your availability.')); });
  }, []);
  const today = useMemo(() => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), []);
  if (!a) return err ? <Err>{err}</Err> : <p className="muted" aria-busy="true">Loading…</p>;

  const upd = (p: Partial<DeskAvailability>) => setA({ ...a, ...p });
  const setRule = (idx: number, p: Partial<AvailabilityRule>) => upd({ rules: a.rules.map((r, i) => (i === idx ? { ...r, ...p } : r)) });
  const daysOff = a.exceptions.filter((e) => e.off).map((e) => e.date).sort();
  const save = async () => {
    const bad = validate(a.rules);
    if (bad) { setErr(bad); return; }
    setBusy(true); setErr(null);
    try { await putAvailability(a); say('Availability saved'); capture('consult_availability_saved', { rules: a.rules.length, off: daysOff.length }); }
    catch (e) { captureException(e, { where: 'consult_availability_save' }); setErr(errMessage(e, 'We could not save. Please try again.')); }
    finally { setBusy(false); }
  };
  const addOff = () => {
    if (!off || off < today || daysOff.includes(off)) return;
    upd({ exceptions: [...a.exceptions, { date: off, off: true } as AvailabilityException] });
    setOff('');
  };

  return (
    <>
      <h1 style={{ fontSize: 26 }}>Availability</h1>
      <div className="cd-grid2">
        <div className="field"><label htmlFor="sl">Session length</label>
          <select id="sl" value={a.slot_minutes} onChange={(e) => upd({ slot_minutes: Number(e.target.value) })}>{SLOT_OPTIONS.map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></div>
        <div className="field"><label htmlFor="bf">Break after each session</label>
          <select id="bf" value={a.buffer_minutes} onChange={(e) => upd({ buffer_minutes: Number(e.target.value) })}>{BUFFER_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? 'No break' : `${m} minutes`}</option>)}</select></div>
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, background: '#fff' }}>
        <h3>Weekly hours (India time)</h3>
        {DAYS.map((d) => {
          const idxs = a.rules.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === d.n);
          return (
            <div key={d.n} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #efe5cb', paddingTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{d.l}</strong>
                <button type="button" className="edit" onClick={() => upd({ rules: [...a.rules, { weekday: d.n, start: '10:00', end: '13:00' }] })}>+ Add hours</button>
              </div>
              {idxs.length === 0 ? <span className="hint">Not available</span> : null}
              {idxs.map(({ r, i }) => (
                <div key={i} className="cd-row">
                  <input className="cd-in" type="time" aria-label={`${d.l} from`} value={r.start} onChange={(e) => setRule(i, { start: e.target.value })} />
                  <span aria-hidden="true">to</span>
                  <input className="cd-in" type="time" aria-label={`${d.l} until`} value={r.end} onChange={(e) => setRule(i, { end: e.target.value })} />
                  <button type="button" className="edit" aria-label={`Remove ${d.l} hours`} onClick={() => upd({ rules: a.rules.filter((_, k) => k !== i) })}>Remove</button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#fff' }}>
        <h3>Days off</h3>
        <div className="cd-row"><input className="cd-in" type="date" min={today} value={off} aria-label="Day off" onChange={(e) => setOff(e.target.value)} /><button type="button" className="btn small ghost" onClick={addOff} disabled={!off}>Add</button></div>
        <div className="cd-chips">
          {daysOff.length === 0 ? <span className="hint">No days off marked.</span> : null}
          {daysOff.map((d) => (
            <span key={d} className="chip gold">{dayIst(Date.parse(`${d}T12:00:00+05:30`))}
              <button type="button" className="edit" aria-label={`Remove day off ${d}`} onClick={() => upd({ exceptions: a.exceptions.filter((e) => !(e.off && e.date === d)) })}>✕</button></span>
          ))}
        </div>
      </div>
      {err ? <Err>{err}</Err> : null}
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save availability'}</button>
      <p className="hint" style={{ textAlign: 'center' }}>Customers can only book free slots at least 2 hours ahead.</p>
      <Toast msg={toast} />
    </>
  );
}

/* ───────────────────────── Customers ───────────────────────── */

function Customers() {
  const [rows, setRows] = useState<DeskCustomer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void getDeskCustomers().then(setRows).catch((e) => { captureException(e, { where: 'consult_customers' }); setErr(errMessage(e, 'We could not load your customers.')); });
  }, []);
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Customers</h1>
      {err ? <Err>{err}</Err> : null}
      {!rows && !err ? <p className="muted" aria-busy="true">Loading…</p> : null}
      {rows && rows.length === 0 ? <div className="card" style={{ background: '#fff' }}><p className="muted">People you have spoken with will appear here.</p></div> : null}
      {rows?.map((c) => (
        <div key={c.uid} className="card cd-link-card" style={{ background: '#fff' }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <strong style={{ fontSize: 17 }}>{c.name}</strong>
            <span className="hint">{[c.city, c.sessions != null ? `${c.sessions} session${c.sessions === 1 ? '' : 's'}` : null, c.last_session_ms ? `last ${dayIst(c.last_session_ms, false)}` : null].filter(Boolean).join(' · ')}</span>
          </div>
          {(c.sessions ?? 0) > 1 ? <span className="chip gold">Repeat</span> : null}
        </div>
      ))}
    </>
  );
}

/* ───────────────────────── entry ───────────────────────── */

export default function DeskApp({ page }: { page: 'today' | 'rate' | 'availability' | 'customers' }) {
  const active = page === 'today' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('scope') === 'upcoming' ? 'bookings' : page;
  return (
    <DeskRoot page={active} nav={page !== 'rate'} back={page === 'rate' ? { href: '/desk', label: 'Desk', right: <strong style={{ fontSize: 17 }}>Your rate</strong> } : undefined}>
      {page === 'today' ? <Today /> : page === 'rate' ? <Rate /> : page === 'availability' ? <Availability /> : <Customers />}
    </DeskRoot>
  );
}
