import { useEffect, useMemo, useRef, useState } from 'react';
import { looksSignedOut, signInUrl, recoverAgeConfirmation } from '../../lib/hfCallsApi';
import { ACTIVE_SESSION_CHANGED } from '../../lib/clerk';
import { bookingError, confirmBooking, createQuote, getPublicSlotsInfo, money, offeredDurations, type AvailabilitySlot, type BookingQuote } from '../../lib/hfBookingsApi';
import SessionBridge from '../calls/SessionBridge';
import SpaceLock from '../../components/hosts/SpaceLock'; // [HF-CREATOR-SPACES-1]
import { capture } from '../../lib/analytics';
import { callModeFlags, holdLine, lengthLabel, offeredLengths } from '../../lib/hfCallModes'; // [HF-CALL-MODES-E1]
import '../../styles/hf-bookings.css';
import '../../styles/hf-channel.css';
import Sticker from '../channel/Sticker';
import { artUrl, ART_DIMS } from '../../lib/hfChannelArt';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';

const DEFAULT_DURATIONS = [10]; // replaced by the lengths this influencer really offers as soon as the server tells us
const localDate = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const addDays = (key: string, days: number) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + days); return localDate(d); };
const randomKey = () => globalThis.crypto?.randomUUID?.() ?? 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2);
type Phase = 'loading' | 'ready' | 'error';

export type BookingHostInfo = { name: string; photo: string | null; rate: string | null };
const meterArt = artUrl('meterIcon');

export default function CustomerBooking({ hostInfo }: { hostInfo?: BookingHostInfo | null }) {
  const feature = useBookingFeature();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const host = params.get('host') || '';
  const back = window.location.pathname + window.location.search;
  const [duration, setDuration] = useState(Number(params.get('duration')) || 10);
  const [durations, setDurations] = useState<number[]>(DEFAULT_DURATIONS);
  // [HF-CALL-MODES-E1] hfBookingLengthsEnabled: lengths 15 min to 5 h, the first 15 minutes held. Off = today's single 10-minute length.
  const [lengthsOn, setLengthsOn] = useState(false);
  const lengthsRef = useRef(false);
  const [date, setDate] = useState(params.get('date') || localDate(new Date(Date.now() + 86_400_000)));
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selected, setSelected] = useState<AvailabilitySlot | null>(null);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [topUp, setTopUp] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [laneNeed, setLaneNeed] = useState<'women' | 'lgbtq' | 'kyc' | null>(null); // [HF-CREATOR-SPACES-1] [HF-CREATOR-BADGES-1]
  const key = useRef('');
  const authEpoch = useRef(0);
  const quoteAuthEpoch = useRef(0);
  const restored = useRef(false);
  const requestedSlot = useRef('');

  const syncUrl = (nextDate: string, nextDuration: number) => {
    const next = new URL(window.location.href); next.searchParams.set('host', host); next.searchParams.set('date', nextDate); next.searchParams.set('duration', String(nextDuration));
    window.history.replaceState({}, '', next.pathname + next.search);
  };
  const loadSlots = async (nextDate = date, nextDuration = duration, keepMessage = false, retried = false): Promise<void> => {
    setPhase('loading'); if (!keepMessage) setMessage(''); setQuote(null); setSelected(null);
    try {
      const found = await getPublicSlotsInfo(host, addDays(nextDate, -1), addDays(nextDate, 1), nextDuration);
      if (found.durationsMinutes) setDurations(lengthsRef.current ? offeredLengths(found.durationsMinutes) : found.durationsMinutes);
      setSlots(found.slots.filter(slot => localDate(new Date(slot.startUtc)) === nextDate));
      setPhase('ready');
    } catch (error) {
      // [HF-BOOKING-E2E-1] An influencer who set times in the app offers 10-minute calls only: switch to a length that exists instead of failing.
      const offered = offeredDurations(error);
      if (offered && !retried && !offered.includes(nextDuration)) {
        setDurations(offered); setDuration(offered[0]); syncUrl(nextDate, offered[0]);
        return loadSlots(nextDate, offered[0], keepMessage, true);
      }
      const issue = bookingError(error); setMessage(issue.message); setLaneNeed(issue.lane ?? null); setPhase('error');
    }
  };
  useEffect(() => {
    if (feature !== 'enabled') { setPhase(feature === 'checking' ? 'loading' : 'error'); if (feature === 'disabled') setMessage('Appointments are not available right now.'); return; }
    if (!host) { setPhase('error'); setMessage('Choose an influencer from their profile to book a time.'); return; }
    void (async () => {
    const flags = await callModeFlags();
    lengthsRef.current = flags.lengths; setLengthsOn(flags.lengths);
    let nextDate = date;
    let nextDuration = duration;
    if (flags.lengths) { setDurations(offeredLengths(null)); if (!params.get('duration')) { nextDuration = 15; setDuration(15); } }
    const intent = sessionStorage.getItem('hf_booking_intent');
    if (intent) {
      try {
        const saved = JSON.parse(intent) as { host?: string; date?: string; duration?: number; startUtc?: string };
        if (saved.host === host && saved.date) {
          nextDate = saved.date; nextDuration = saved.duration || duration; requestedSlot.current = saved.startUtc || '';
          setDate(nextDate); setDuration(nextDuration);
        }
      } catch { /* ignore malformed local intent */ }
      sessionStorage.removeItem('hf_booking_intent');
    }
    if (!requestedSlot.current) requestedSlot.current = params.get('slot') || '';
    void loadSlots(nextDate, nextDuration, true);
    })();
  }, [host, feature]);
  useEffect(() => {
    const invalidateQuote = () => {
      authEpoch.current += 1;
      if (!quote && !selected) return;
      setQuote(null); setSelected(null); setPolicyAccepted(false); key.current = '';
      setMessage('Your signed-in account changed. Choose the time again to get a fresh quote.');
    };
    window.addEventListener(ACTIVE_SESSION_CHANGED, invalidateQuote);
    return () => window.removeEventListener(ACTIVE_SESSION_CHANGED, invalidateQuote);
  }, [quote, selected]);
  useEffect(() => {
    const desired = requestedSlot.current;
    if (restored.current || !desired || phase !== 'ready' || looksSignedOut()) return;
    restored.current = true;
    requestedSlot.current = '';
    const next = new URL(window.location.href); next.searchParams.delete('slot'); window.history.replaceState({}, '', next.pathname + next.search);
    const slot = slots.find(candidate => candidate.startUtc === desired);
    if (slot) void choose(slot);
    else setMessage('That selected time is no longer available. Choose another current time to get a fresh quote.');
  }, [slots, phase]);

  const choose = async (slot: AvailabilitySlot) => {
    if (looksSignedOut()) {
      syncUrl(date, duration); const next = new URL(window.location.href); next.searchParams.set('slot', slot.startUtc);
      window.location.assign(signInUrl(next.pathname + next.search)); return;
    }
    setSelected(slot); setQuote(null); setPolicyAccepted(false); setMessage('Getting the confirmed price…'); setBusy(true); setTopUp(false);
    const quoteEpoch = authEpoch.current;
    try {
      const fresh = await createQuote(host, slot.startUtc, duration);
      if (authEpoch.current !== quoteEpoch) { setQuote(null); setSelected(null); setMessage('Your signed-in account changed. Choose the time again to get a fresh quote.'); return; }
      setQuote(fresh); quoteAuthEpoch.current = quoteEpoch; key.current = randomKey(); setMessage('');
    } catch (error) { const issue = bookingError(error); setLaneNeed(issue.lane ?? null); setMessage(issue.code === 'age_confirmation_required' ? await recoverAgeConfirmation() : issue.message); setSelected(null); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!quote || busy || !policyAccepted) return;
    if (quoteAuthEpoch.current !== authEpoch.current) { setQuote(null); setSelected(null); setPolicyAccepted(false); key.current = ''; setMessage('Your signed-in account changed. Choose the time again to get a fresh quote.'); return; }
    if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) {
      setQuote(null); setSelected(null); setMessage('This price quote expired. Choose a time again to get a fresh quote.'); await loadSlots(date, duration, true); return;
    }
    setBusy(true); setMessage('');
    try {
      const booking = await confirmBooking(quote.id, key.current || (key.current = randomKey()));
      sessionStorage.removeItem('hf_booking_intent');
      window.location.assign('/bookings/' + encodeURIComponent(booking.id));
    } catch (error) {
      const issue = bookingError(error);
      setLaneNeed(issue.lane ?? null);
      capture('hf_booking_confirm_failed', { feature: 'hf_booking', quote_id: quote.id, status: issue.status, code: issue.code });
      if (issue.code === 'age_confirmation_required') {
        setMessage(await recoverAgeConfirmation());
      } else if (issue.status === 409 || issue.code.includes('expired') || issue.code.includes('conflict')) {
        setQuote(null); setSelected(null); setPolicyAccepted(false); setMessage('That time just changed. Choose an updated time to see a fresh price.');
        capture('hf_booking_stale_quote', { quote_id: quote.id, status: issue.status, reason: issue.code });
        await loadSlots(date, duration, true);
      } else if (issue.code.includes('balance') || issue.code.includes('fund')) {
        setTopUp(true); setMessage('Your balance is too low to reserve this appointment. Add money, then choose the time again to get a fresh quote.');
      } else { setMessage(issue.message); }
    } finally { setBusy(false); }
  };

  // [HF-BOOK-GP-1] Keep the week strip on the week that holds the chosen day (URL, restored intent or a click).
  useEffect(() => {
    const diff = Math.round((Date.parse(date + 'T12:00:00') - Date.parse(localDate(new Date()) + 'T12:00:00')) / 86_400_000);
    if (Number.isFinite(diff) && diff >= 0) setWeekOffset(Math.floor(diff / 7));
  }, [date]);

  const goTopUp = () => {
    sessionStorage.setItem('hf_booking_intent', JSON.stringify({ host, date, duration, startUtc: selected?.startUtc }));
    window.location.assign('/wallet?return_to=' + encodeURIComponent(window.location.pathname + window.location.search));
  };
  const minDate = localDate(new Date());
  const maxDate = localDate(new Date(Date.now() + 60 * 86_400_000));

  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  // [HF-BOOK-GP-1] Galli Pop skin, matching the channel page (/h/<slug>): photo + name up top, a week strip instead of a date box, and the
  // review step painted like a rickshaw meter. All booking logic above is unchanged.
  const name = hostInfo?.name || 'this influencer';
  const first = hostInfo?.name ? hostInfo.name.split(/\s+/)[0] : 'them';
  const dayFmt = (key: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', o).format(new Date(key + 'T12:00:00'));
  const timeFmt = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const weekStart = addDays(minDate, weekOffset * 7);
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter(d => d <= maxDate);
  const pickDay = (d: string) => { setDate(d); syncUrl(d, duration); setQuote(null); setSelected(null); void loadSlots(d, duration); };
  const lenText = (m: number) => (lengthsOn ? lengthLabel(m) : `${m} min`);
  const held = lengthsOn && quote?.holdPaise != null;
  return <main className="gp bkp" aria-labelledby="hfb-title">
    <SessionBridge on />
    <div className="wrap">
      {host && <a className="lnk bk-back" href={`/h/${encodeURIComponent(host)}`}>‹ Back to {hostInfo?.name ? `${first}’s page` : 'the profile'}</a>}
      <header className="bk-hero">
        {hostInfo?.photo ? <img className="bk-ava" src={hostInfo.photo} width={112} height={140} alt={hostInfo.name} decoding="async" /> : hostInfo?.name ? <span className="bk-ava bk-ini" aria-hidden="true">{first.charAt(0).toUpperCase()}</span> : null}
        <div className="bk-ht">
          <p className="eyebrow">Book a time</p>
          <h1 id="hfb-title" className="h2">{hostInfo?.name ? <>Book a time with {first}</> : 'Choose a time'}</h1>
          <p className="sub">Pick a day and a time that suits you. You see the full price before you confirm.</p>
          {hostInfo?.rate && <div className="bk-chips"><span className="chip">{hostInfo.rate}</span><span className="chip">Your number stays private</span></div>}
        </div>
        <div className="bk-stk"><Sticker k="booking" /></div>
      </header>
      {!host && <section className="panel"><p role="alert">{message}</p><a className="btn btn-r" href="/marketplace">Explore influencers</a></section>}
      {host && <>
        {looksSignedOut() && <section className="panel bk-signin"><div><h2>Sign in to book</h2><p>We keep the time you picked, so you can carry on right after.</p></div><a className="btn btn-r" href={signInUrl(back)}>Sign in</a></section>}
        <div className="bk-grid">
          <section className="cal" aria-labelledby="hfb-times" aria-busy={phase === 'loading'}>
            <p className="nun lbl2" id="hfb-len">How long?</p>
            <div className="bk-lens" role="group" aria-labelledby="hfb-len">
              {durations.map(minutes => <button type="button" key={minutes} className={`chip${duration === minutes ? ' on' : ''}`} aria-pressed={duration === minutes} onClick={() => { setDuration(minutes); syncUrl(date, minutes); setQuote(null); setSelected(null); if (lengthsOn) capture('hf_web_booking_length_picked', { host, minutes }); void loadSlots(date, minutes); }}>{lenText(minutes)}</button>)}
            </div>
            <div className="cal-h" style={{ marginTop: 22 }}>
              <h3 id="hfb-times">{dayFmt(week[0], { day: 'numeric', month: 'short' })} – {dayFmt(week[week.length - 1], { day: 'numeric', month: 'short' })}</h3>
              <span className="nav2">
                <button className="ibtn" type="button" aria-label="Previous week" disabled={weekOffset === 0} onClick={() => setWeekOffset(w => Math.max(0, w - 1))}>‹</button>
                <button className="ibtn" type="button" aria-label="Next week" disabled={addDays(weekStart, 7) > maxDate} onClick={() => setWeekOffset(w => w + 1)}>›</button>
              </span>
            </div>
            <div className="days" role="group" aria-label="Pick a day">
              {week.map(d => <button key={d} type="button" className={`day${d === date ? ' on' : ''}`} aria-pressed={d === date} onClick={() => pickDay(d)}>
                <small>{d === minDate ? 'Today' : dayFmt(d, { weekday: 'short' })}</small><b>{dayFmt(d, { day: 'numeric' })}</b><em>{dayFmt(d, { month: 'short' })}</em>
              </button>)}
            </div>
            <p className="nun" style={{ marginBottom: 12 }}>{dayFmt(date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            {laneNeed && <SpaceLock lane={laneNeed} missing="server_403" />}
            {phase === 'loading' && <p className="cal-msg" role="status">Finding open times…</p>}
            {phase === 'error' && <div className="cal-msg" role="alert"><p>{message}</p><button className="btn btn-o bk-retry" type="button" onClick={() => void loadSlots()}>Try again</button></div>}
            {phase === 'ready' && slots.length === 0 && <p className="cal-msg" role="status">No open times on this day. Try another day.</p>}
            {phase === 'ready' && slots.length > 0 && <div className="slots" role="group" aria-label="Pick a time">
              {slots.map(slot => <button type="button" key={slot.startUtc} className={`slot${selected?.startUtc === slot.startUtc ? ' on' : ''}`} aria-pressed={selected?.startUtc === slot.startUtc} onClick={() => void choose(slot)} disabled={busy} title={`${slot.hostLocalLabel} for ${first} (${slot.offsetLabel})`}>{timeFmt(slot.startUtc)}</button>)}
            </div>}
            <p className="bk-tz">Times are in your own time zone. Hover or tap a time to see {first === 'them' ? 'their' : `${first}’s`} local time.</p>
            {message && phase === 'ready' && !quote && <p role="status" className="cal-msg" style={{ marginTop: 14 }}>{message}</p>}
          </section>
          <aside className="bk-side" aria-live="polite">
            {!(quote && selected) && <section className="panel bk-how" aria-label="How booking works">
              <h2>How it works</h2>
              <ol>
                <li><span className="bk-n">1</span><span><b className="nun">Pick a time</b>Choose a day and a slot on the left.</span></li>
                <li><span className="bk-n">2</span><span><b className="nun">Check the price</b>We show the exact amount before anything is reserved.</span></li>
                <li><span className="bk-n">3</span><span><b className="nun">Confirm</b>Your time with {first} is booked. Meter down, baat shuru.</span></li>
              </ol>
              {busy && <p className="cal-msg" role="status">Getting the price…</p>}
            </section>}
            {quote && selected && <section className="bk-ticket" aria-labelledby="hfb-confirm">
              <div className="bk-tt">
                {meterArt && <img className="meter-ic" src={meterArt} width={ART_DIMS.meterIcon.w} height={ART_DIMS.meterIcon.h} alt="" decoding="async" />}
                <div><p className="eyebrow" style={{ color: 'var(--yel)' }}>Your booking</p><h2 id="hfb-confirm">Check and confirm</h2></div>
              </div>
              <dl className="bk-dl">
                <div><dt>When</dt><dd>{new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(quote.startUtc))}<small>{selected.hostLocalLabel} for {first} ({selected.offsetLabel})</small></dd></div>
                <div><dt>How long</dt><dd>{lenText(quote.durationMinutes)}</dd></div>
                <div><dt>{held ? 'Held now' : 'You pay'}</dt><dd className="bk-amt">{held ? money(quote.holdPaise!) : quote.priceRupees || money(quote.reservedPaise)}</dd></div>
              </dl>
              {held && <p className="bk-fine">{holdLine(money(quote.holdPaise!), quote.holdMinutes ?? 15)}</p>}
              <p className="bk-fine">Either of you can cancel before the call starts, and nothing is charged for cancelling. Once you are talking, you pay only for the time you actually talk. This price is kept for you until {new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(quote.expiresAt))}.</p>
              <label className="ck"><input type="checkbox" checked={policyAccepted} onChange={e => setPolicyAccepted(e.target.checked)} /><i aria-hidden="true">✓</i><span>I understand how booking and cancelling work.</span></label>
              {message && <p role="status" className="bk-msg">{message}</p>}
              {laneNeed && <SpaceLock lane={laneNeed} missing="server_403" />}
              <div className="bk-act">
                <button type="button" className="btn btn-r" onClick={() => void confirm()} disabled={busy || !policyAccepted}>{busy ? 'Confirming…' : 'Confirm and reserve'}</button>
                <button type="button" className="btn bk-ghost" onClick={() => { setQuote(null); setSelected(null); setMessage(''); }}>Pick another time</button>
              </div>
              {topUp && <div className="bk-topup" role="alert"><p>Add money to your wallet to continue. When you come back we check the time again and show a fresh price.</p><button className="btn btn-y" type="button" onClick={goTopUp}>Add money</button></div>}
            </section>}
          </aside>
        </div>
      </>}
    </div>
  </main>;
}
