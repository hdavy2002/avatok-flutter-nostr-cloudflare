/* [HF-CHANNEL-WEB-1] Booking calendar inline on the channel page: a week strip ("N free"), the day's time slots, the call length, and a
 * rickshaw-meter summary ("₹150 · Sun 26 Oct · 4:00 pm · 15 min") with "Request this slot". The button hands off to the existing booking
 * flow: /bookings?host=<slug>&date=YYYY-MM-DD&duration=<min>&slot=<startUtc> (CustomerBooking.tsx reads those and asks for sign-in / the quote).
 * Reads GET /api/hf/hosts/:slug/availability through hfBookingsApi. Bookings off for the whole site: the section hides itself; no open times:
 * a quiet note. Money shown here is the rate x minutes (an estimate); the real quote is made on the booking page.
 * Telemetry: channel_slot_requested. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { artUrl, ART_DIMS } from '../../lib/hfChannelArt';
import { capture } from '../../lib/analytics';
import { bookingError, bookingsEnabled, getPublicSlotsInfo, offeredDurations, type AvailabilitySlot } from '../../lib/hfBookingsApi';
import { callModeFlags, lengthLabel, offeredLengths } from '../../lib/hfCallModes';
import SpaceLock from '../../components/hosts/SpaceLock'; // [HF-CREATOR-SPACES-1]
import SessionBridge from '../calls/SessionBridge';
import { spaceOf, useSpaceGate } from '../../lib/hfSpaces';
import { chargeForSeconds, type PriceTier } from '../../lib/hfStdPlan';
import { formatPaise } from '../../lib/money';

const WEEKS = 3; // the strip pages through today + three weeks at most (the server also enforces its own horizon)
const ymd = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const addDays = (key: string, n: number) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const dayFmt = (key: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', o).format(new Date(key + 'T12:00:00'));
const timeFmt = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).replace(/\s?([AP])M$/i, (_m, c: string) => ` ${c.toLowerCase()}m`);

const money = (paise: number) => (paise % 100 === 0 ? `₹${(paise / 100).toLocaleString('en-IN')}` : formatPaise(paise));

interface Props { hostSlug: string; hostName: string; paisePerMin: number; plan?: string; priceTiers?: PriceTier[]; space?: 'women' | 'lgbtq' | null }

const meterArt = artUrl('meterIcon');

/** [HF-CREATOR-SPACES-1] Booking on a Women-only / LGBTQ+ channel is locked until the viewer's video KYC is approved (the server checks too). */
export default function InlineBooking(props: Props) {
  const space = spaceOf({ space: props.space });
  const gate = useSpaceGate(space);
  if (!space) return <InlineBookingInner {...props} />;
  return <>
    <SessionBridge on={gate.needsBridge} />
    {gate.state === 'ok' ? <InlineBookingInner {...props} /> : <SpaceLock lane={space} wait={gate.state === 'loading'} signedOut={gate.state === 'signedout'} missing={gate.missing} />}
  </>;
}

function InlineBookingInner({ hostSlug, hostName, paisePerMin, plan, priceTiers }: Props) {
  const today = useMemo(() => ymd(new Date()), []);
  const [state, setState] = useState<'checking' | 'off' | 'loading' | 'ready' | 'error'>('checking');
  const [week, setWeek] = useState(0);
  const [duration, setDuration] = useState(10);
  const [durations, setDurations] = useState<number[]>([10]);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [day, setDay] = useState('');
  const [slot, setSlot] = useState('');
  const [msg, setMsg] = useState('');
  const [needsApproval, setNeedsApproval] = useState(false); // [HF-PARITY-POLISH-1]
  const lengthsOn = useRef(false);
  const seq = useRef(0);
  const start = addDays(today, week * 7);

  // site-wide switch + length flag, once
  useEffect(() => {
    let live = true;
    void (async () => {
      const [on, flags] = await Promise.all([bookingsEnabled(), callModeFlags()]);
      if (!live) return;
      if (!on) { setState('off'); hide(); return; }
      lengthsOn.current = flags.lengths;
      if (flags.lengths) { setDurations(offeredLengths(null)); setDuration(15); }
      setState('loading');
    })();
    return () => { live = false; };
  }, []);

  // load the week whenever the week or the length changes
  useEffect(() => {
    if (state === 'checking' || state === 'off') return;
    const mine = ++seq.current;
    setState('loading'); setMsg('');
    void (async () => {
      const end = addDays(start, 6);
      let to = addDays(end, 1);
      const from = week === 0 ? start : addDays(start, -1);
      let dur = duration;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const found = await getPublicSlotsInfo(hostSlug, from, to, dur);
          if (mine !== seq.current) return;
          if (found.durationsMinutes) setDurations(lengthsOn.current ? offeredLengths(found.durationsMinutes) : found.durationsMinutes);
          setSlots(found.slots);
          setNeedsApproval(found.needsApproval);
          setState('ready');
          return;
        } catch (error) {
          if (mine !== seq.current) return;
          const offered = offeredDurations(error);
          if (offered && !offered.includes(dur)) { dur = offered[0]; setDurations(offered); setDuration(dur); continue; }
          const issue = bookingError(error);
          if (issue.code === 'date_range_out_of_bounds' && to > addDays(from, 1)) { to = addDays(to, -3) > addDays(from, 1) ? addDays(to, -3) : addDays(from, 1); continue; }
          setMsg(issue.status === 0 ? issue.message : ''); setSlots([]); setState('error');
          return;
        }
      }
      setSlots([]); setState('error');
    })();
  }, [week, duration, state === 'checking' || state === 'off']); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, AvailabilitySlot[]>();
    for (const s of slots) {
      const k = ymd(new Date(s.startUtc));
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [slots]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const pastNow = (s: AvailabilitySlot) => Date.parse(s.startUtc) > Date.now();

  // keep a valid day + slot selected (first open day of the week; its first slot)
  useEffect(() => {
    if (state !== 'ready') return;
    const open = days.filter(d => (byDay.get(d) ?? []).some(pastNow));
    const d = open.includes(day) ? day : open[0] ?? '';
    setDay(d);
    const list = (byDay.get(d) ?? []).filter(pastNow);
    setSlot(prev => (list.some(s => s.startUtc === prev) ? prev : list[0]?.startUtc ?? ''));
  }, [state, byDay, start]); // eslint-disable-line react-hooks/exhaustive-deps

  function hide() {
    document.getElementById('book')?.setAttribute('hidden', '');
    document.querySelectorAll('a[href="#book"]').forEach(a => a.setAttribute('hidden', ''));
    document.querySelector('[data-book-band]')?.setAttribute('hidden', '');
  }

  const priceFor = (min: number) => (plan === 'standard' ? chargeForSeconds(priceTiers, min * 60) : Math.round(paisePerMin * min));
  const chosen = slots.find(s => s.startUtc === slot);
  const request = () => {
    if (!chosen) return;
    const q = new URLSearchParams({ host: hostSlug, date: day, duration: String(duration), slot: chosen.startUtc });
    capture('channel_slot_requested', { host_slug: hostSlug, date: day, duration_minutes: duration, price_paise: priceFor(duration) });
    location.assign(`/bookings?${q.toString()}`);
  };

  if (state === 'off') return null;
  const lens = durations; // [HF-PARITY-POLISH-1] every length the influencer offers (15 min to 5 h), same as the app
  const anyOpen = days.some(d => (byDay.get(d) ?? []).some(pastNow));

  return <div className="cal" aria-label="Booking calendar" aria-busy={state === 'loading' || state === 'checking'}>
    <div className="cal-h">
      <h3>{week === 0 ? 'This week' : `${dayFmt(start, { day: 'numeric', month: 'short' })} – ${dayFmt(addDays(start, 6), { day: 'numeric', month: 'short' })}`}</h3>
      <span className="nav2">
        <button className="ibtn" type="button" aria-label="Previous week" disabled={week === 0} onClick={() => setWeek(w => Math.max(0, w - 1))}>‹</button>
        <button className="ibtn" type="button" aria-label="Next week" disabled={week >= WEEKS} onClick={() => setWeek(w => Math.min(WEEKS, w + 1))}>›</button>
      </span>
    </div>
    <div className="days" role="group" aria-label="Pick a day">
      {days.map(d => {
        const n = (byDay.get(d) ?? []).filter(pastNow).length;
        return <button key={d} type="button" className={`day${d === day ? ' on' : ''}${n === 0 ? ' off' : ''}`} disabled={n === 0} aria-pressed={d === day} onClick={() => { setDay(d); setSlot((byDay.get(d) ?? []).filter(pastNow)[0]?.startUtc ?? ''); }}>
          <small>{dayFmt(d, { weekday: 'short' })}</small><b>{dayFmt(d, { day: 'numeric' })}</b><em>{n > 0 ? `${n} free` : ' '}</em>
        </button>;
      })}
    </div>
    {(state === 'checking' || state === 'loading') && <p className="cal-msg" role="status">Finding open times…</p>}
    {state === 'error' && <p className="cal-msg" role="status">{msg || `We could not load ${hostName}’s open times just now. Please try again in a moment.`}</p>}
    {state === 'ready' && !anyOpen && <p className="cal-msg" role="status">{week >= WEEKS ? `No more open times with ${hostName} that far ahead.` : `No open times this week. Try the next week, or call when ${hostName} is online.`}</p>}
    {state === 'ready' && anyOpen && day && <>
      <p className="nun" style={{ marginBottom: 12 }}>{dayFmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <div className="slots" role="group" aria-label="Pick a time">
        {(byDay.get(day) ?? []).filter(pastNow).map(s => <button key={s.startUtc} type="button" className={`slot${s.startUtc === slot ? ' on' : ''}`} aria-pressed={s.startUtc === slot} onClick={() => setSlot(s.startUtc)}>{timeFmt(s.startUtc)}</button>)}
      </div>
      <p className="nun lbl2" style={{ margin: '22px 0 10px' }}>How long?</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} role="group" aria-label="Call length">
        {lens.map(m => <button key={m} type="button" className={`chip${m === duration ? ' on' : ''}`} aria-pressed={m === duration} onClick={() => setDuration(m)}>{lengthLabel(m)}</button>)}
      </div>
      <div className="meter">
        {meterArt && <img className="meter-ic" src={meterArt} width={ART_DIMS.meterIcon.w} height={ART_DIMS.meterIcon.h} alt="" loading="lazy" decoding="async" />}
        <div className="msum"><span className="disp">{money(priceFor(duration))}</span><small>{chosen ? `${dayFmt(day, { weekday: 'short', day: 'numeric', month: 'short' })} · ${timeFmt(chosen.startUtc)} · ${lengthLabel(duration)}` : 'Pick a time'}</small></div>
        <button type="button" className="btn btn-y" disabled={!chosen} onClick={request}>Request this slot</button>
      </div>
      {needsApproval && <p className="cal-msg" style={{ marginTop: 10 }}>Each booking needs the influencer&rsquo;s approval. If it isn&rsquo;t accepted within 24 hours, your money returns to your wallet.</p>}
    </>}
  </div>;
}
