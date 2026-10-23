/* [HF-DASH-V3-1] My appointments: month calendar with dots, the chosen day, upcoming (with countdown and money held) and past bookings.
 * Joining, cancelling and the cancellation rules live on the appointment page (/bookings/:id), which this screen links to.
 * Worker: GET /api/hf/bookings?role=customer&from&to (all pages). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listBookings, type HfBooking } from '../../../lib/hfBookingsApi';
import { bookingsOnDay, calendarDays, calendarMonth, collectBookingPages, dayEnd, localDayKey } from '../../../lib/hfBookingCalendar';
import { getActiveTokenWaited } from '../../../lib/clerk';
import { formatPaise } from '../../../lib/money';
import { capture } from '../../../lib/analytics';
import { Avatar, Card, Empty, Failed, Ic, PageHead, Skel, Sticker, istDay, istTime } from './ui';

const LIVE = ['confirmed', 'pending_approval', 'starting', 'active']; // [HF-BOOKING-E2E-1] a request still waiting for the influencer is upcoming too, not "past"
const label = (s: string) => s === 'confirmed' ? 'Confirmed' : s === 'pending_approval' ? 'Waiting for approval' : s === 'completed' ? 'Completed' : s.startsWith('cancel') ? 'Cancelled' : s === 'starting' || s === 'active' ? 'Happening now' : s.replaceAll('_', ' ');
const chip = (s: string) => s === 'completed' ? '' : s.startsWith('cancel') ? 'dec' : s === 'confirmed' ? 'lav' : 'gold';

export default function Appointments({ enabled, uid }: { enabled: boolean; uid: string }) {
  const [month, setMonth] = useState(() => calendarMonth(new Date()));
  const [sel, setSel] = useState(() => new Date());
  const [rows, setRows] = useState<HfBooking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const days = useMemo(() => calendarDays(month), [month]);
  const load = useCallback(async () => {
    if (!enabled) { setRows([]); return; }
    setRows(null); setFailed(false);
    let live = true;
    try {
      const token = await getActiveTokenWaited(6000);
      if (!token) { setFailed(true); return; }
      const from = new Date(Math.min(days[0].getTime(), Date.now() - 60 * 86_400_000));
      const to = new Date(Math.max(dayEnd(days[days.length - 1]).getTime(), Date.now() + 90 * 86_400_000));
      const r = await collectBookingPages(cursor => listBookings('customer', from.toISOString(), to.toISOString(), cursor, token), () => live);
      if (r.error && !r.rows.length) setFailed(true);
      setRows(r.rows);
    } catch { setFailed(true); }
    return () => { live = false; };
  }, [enabled, days]);
  useEffect(() => { void load(); }, [load, uid]);
  const now = Date.now();
  const up = (rows ?? []).filter(b => LIVE.includes(b.status) && Date.parse(b.endUtc) > now).sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  const past = (rows ?? []).filter(b => !(LIVE.includes(b.status) && Date.parse(b.endUtc) > now)).sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc)).slice(0, 12);
  const dayRows = rows ? bookingsOnDay(rows, sel) : [];
  const today = localDayKey(new Date());

  if (!enabled) return <><PageHead eyebrow="My appointments" title="Fixed time, pakki baat" art={<Sticker name="mehman" w={110} rot={-6} />} /><Card title="Appointments" note=""><Empty text="Appointments open soon." /></Card></>;
  const row = (b: HfBooking, actions: boolean) => { const t = Date.parse(b.startUtc); const mins = Math.round((t - now) / 60_000);
    return <div key={b.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 0', borderBottom: '1px dashed var(--line)', flexWrap: 'wrap' }}>
      <div className="h3-who"><Avatar name={b.hostName} seed={b.hostUid} /><span><b>{b.hostName || 'Your influencer'}</b><small>{istDay(t)}, {istTime(t)}{b.durationMinutes ? ` · ${b.durationMinutes} min` : ''}</small></span></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {actions ? <><span className="h3-chip lav">{formatPaise(b.reservedPaise)} held</span>{b.status === 'pending_approval' && <span className="h3-chip gold">Waiting for approval</span>}</> : <span className={`h3-chip ${chip(b.status)}`}>{label(b.status)}</span>}
        {actions && mins > 0 && mins < 24 * 60 && <span className="h3-chip gold">{mins >= 60 ? `in ${Math.floor(mins / 60)}h` : `in ${mins}m`}</span>}
        <a className={`h3-btn sm ${actions && mins <= 15 && b.status !== 'pending_approval' ? 'rani' : 'ghost'}`} href={`/bookings/${encodeURIComponent(b.id)}`} onClick={() => capture('hf_dash3_appt_open', { status: b.status })}>{actions && mins <= 15 && b.status !== 'pending_approval' ? 'Join' : actions ? 'View or change' : 'Details'}</a>
      </div></div>; };

  return <>
    <PageHead eyebrow="My appointments" title="Fixed time, pakki baat" sub="Book a slot with an influencer and they call you at that time. No waiting around." art={<Sticker name="mehman" w={110} rot={-6} wiggle />} />
    <section className="h3-row c12">
      <Card title="Calendar" note={`Tap a day · times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <button type="button" className="h3-iconbtn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Ic name="left" className="" /></button>
          <b style={{ fontFamily: 'var(--head)', fontSize: 18 }} aria-live="polite">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</b>
          <button type="button" className="h3-iconbtn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Ic name="right" className="" /></button>
        </div>
        {failed ? <Failed onRetry={() => void load()} /> : <div className="h3-cal">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="dw">{d}</div>)}
          {days.map(d => { const k = localDayKey(d); const n = rows ? bookingsOnDay(rows, d).filter(b => !b.status.startsWith('cancel')).length : 0;
            return <button key={k} type="button" aria-pressed={k === localDayKey(sel)} aria-label={`${d.toDateString()}${n ? `, ${n} appointment${n > 1 ? 's' : ''}` : ''}`}
              className={`${k === today ? 'today ' : ''}${k === localDayKey(sel) ? 'sel ' : ''}${d.getMonth() !== month.getMonth() ? 'dim' : ''}`} onClick={() => setSel(d)}>
              {d.getDate()}{n > 0 && <span className="dots">{Array.from({ length: Math.min(3, n) }, (_, i) => <i key={i} />)}</span>}</button>; })}
        </div>}
        <div style={{ marginTop: 14 }}><b>{sel.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</b>
          {!rows ? <Skel h={60} /> : dayRows.length ? dayRows.map(b => row(b, LIVE.includes(b.status) && Date.parse(b.endUtc) > now)) : <p className="small muted" style={{ marginTop: 6 }}>Kuch nahi is din. Free hai aap!</p>}</div>
      </Card>
      <Card title="Upcoming" note="Money is held from your wallet until the call" tone={1}>
        {!rows ? <Skel h={200} /> : up.length ? up.map(b => row(b, true)) : <Empty text="No upcoming appointments." />}
        <a className="h3-btn rani" style={{ marginTop: 14, width: '100%' }} href="/marketplace"><Ic name="plus" className="" />Book a new time</a>
      </Card>
    </section>
    <Card title="Past" note="Completed and cancelled">{!rows ? <Skel h={120} /> : past.length ? past.map(b => row(b, false)) : <p className="small muted">Your past appointments show up here.</p>}</Card>
    <section className="h3-safe" style={{ background: 'var(--lavtint)', borderColor: 'var(--line2)' }}>
      <div style={{ flex: 1, minWidth: '16rem' }}><h3>How appointments work</h3>
        <ul>{['Pick a free slot on an influencer’s profile', 'The amount is held from your wallet, not spent', 'We remind you on WhatsApp 1 hour and 10 minutes before', 'Open the appointment a few minutes early', 'Your number stays hidden on the call', 'Cancellation rules are shown on each appointment'].map(t => <li key={t}>{t}</li>)}</ul></div>
      <Sticker name="chai" w={96} rot={5} />
    </section>
  </>;
}
