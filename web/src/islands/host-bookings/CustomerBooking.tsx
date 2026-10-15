import { useEffect, useMemo, useRef, useState } from 'react';
import { looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { ACTIVE_SESSION_CHANGED } from '../../lib/clerk';
import { bookingError, confirmBooking, createQuote, getPublicSlots, money, type AvailabilitySlot, type BookingQuote } from '../../lib/hfBookingsApi';
import { capture } from '../../lib/analytics';
import '../../styles/hf-bookings.css';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';

const DURATIONS = [15, 30, 45, 60];
const localDate = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const addDays = (key: string, days: number) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + days); return localDate(d); };
const randomKey = () => globalThis.crypto?.randomUUID?.() ?? 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2);
type Phase = 'loading' | 'ready' | 'error';

export default function CustomerBooking() {
  const feature = useBookingFeature();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const host = params.get('host') || '';
  const back = window.location.pathname + window.location.search;
  const [duration, setDuration] = useState(Number(params.get('duration')) || 30);
  const [date, setDate] = useState(params.get('date') || localDate(new Date(Date.now() + 86_400_000)));
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selected, setSelected] = useState<AvailabilitySlot | null>(null);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [topUp, setTopUp] = useState(false);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const key = useRef('');
  const authEpoch = useRef(0);
  const quoteAuthEpoch = useRef(0);
  const restored = useRef(false);
  const requestedSlot = useRef('');

  const syncUrl = (nextDate: string, nextDuration: number) => {
    const next = new URL(window.location.href); next.searchParams.set('host', host); next.searchParams.set('date', nextDate); next.searchParams.set('duration', String(nextDuration));
    window.history.replaceState({}, '', next.pathname + next.search);
  };
  const loadSlots = async (nextDate = date, nextDuration = duration, keepMessage = false) => {
    setPhase('loading'); if (!keepMessage) setMessage(''); setQuote(null); setSelected(null);
    try {
      const found = await getPublicSlots(host, addDays(nextDate, -1), addDays(nextDate, 1), nextDuration);
      setSlots(found.filter(slot => localDate(new Date(slot.startUtc)) === nextDate));
      setPhase('ready');
    } catch (error) {
      const issue = bookingError(error); setMessage(issue.message); setPhase('error');
    }
  };
  useEffect(() => {
    if (feature !== 'enabled') { setPhase(feature === 'checking' ? 'loading' : 'error'); if (feature === 'disabled') setMessage('Appointments are not available right now.'); return; }
    if (!host) { setPhase('error'); setMessage('Choose an influencer from their profile to book a time.'); return; }
    let nextDate = date;
    let nextDuration = duration;
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
    } catch (error) { setMessage(bookingError(error).message); setSelected(null); }
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
      capture('hf_booking_confirm_failed', { feature: 'hf_booking', quote_id: quote.id, status: issue.status, code: issue.code });
      if (issue.status === 409 || issue.code.includes('expired') || issue.code.includes('conflict')) {
        setQuote(null); setSelected(null); setPolicyAccepted(false); setMessage('That time just changed. Choose an updated time to see a fresh price.');
        capture('hf_booking_stale_quote', { quote_id: quote.id, status: issue.status, reason: issue.code });
        await loadSlots(date, duration, true);
      } else if (issue.code.includes('balance') || issue.code.includes('fund')) {
        setTopUp(true); setMessage('Your balance is too low to reserve this appointment. Add money, then choose the time again to get a fresh quote.');
      } else { setMessage(issue.message); }
    } finally { setBusy(false); }
  };

  const goTopUp = () => {
    sessionStorage.setItem('hf_booking_intent', JSON.stringify({ host, date, duration, startUtc: selected?.startUtc }));
    window.location.assign('/wallet?return_to=' + encodeURIComponent(window.location.pathname + window.location.search));
  };
  const minDate = localDate(new Date());
  const maxDate = localDate(new Date(Date.now() + 60 * 86_400_000));

  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  return <main className="hfb-page" aria-labelledby="hfb-title">
    <header className="hfb-heading"><p className="hfb-eyebrow">Book a conversation</p><h1 id="hfb-title">Choose a time</h1><p>Call now stays available separately on the influencer’s profile. This booking is confirmed only after the server accepts your reservation.</p></header>
    {!host && <section className="hfb-card"><p role="alert">{message}</p><a className="hfb-button" href="/marketplace">Explore influencers</a></section>}
    {host && <>
      {looksSignedOut() && <section className="hfb-card"><h2>Sign in to book</h2><p>Your selected booking details will be kept when you return.</p><a className="hfb-button hfb-primary" href={signInUrl(back)}>Sign in</a></section>}
      <section className="hfb-card" aria-labelledby="hfb-options">
        <h2 id="hfb-options">Appointment length</h2>
        <div className="hfb-choice-row" role="group" aria-label="Appointment length">
          {DURATIONS.map(minutes => <button type="button" key={minutes} className={duration === minutes ? 'hfb-choice is-selected' : 'hfb-choice'} aria-pressed={duration === minutes} onClick={() => { setDuration(minutes); syncUrl(date, minutes); setQuote(null); setSelected(null); void loadSlots(date, minutes); }}>{minutes} minutes</button>)}
        </div>
        <label className="hfb-label" htmlFor="hfb-date">Date</label>
        <input id="hfb-date" className="hfb-input" type="date" min={minDate} max={maxDate} value={date} onChange={e => { setDate(e.target.value); syncUrl(e.target.value, duration); setQuote(null); setSelected(null); void loadSlots(e.target.value, duration); }} />
        <p className="hfb-muted">Times are shown in your device’s timezone. The influencer’s timezone and offset appear on each option.</p>
      </section>
      <section className="hfb-card" aria-labelledby="hfb-times" aria-busy={phase === 'loading'}>
        <h2 id="hfb-times">Available times</h2>
        {phase === 'loading' && <p role="status">Checking current availability…</p>}
        {phase === 'error' && <div><p role="alert">{message}</p><button className="hfb-button" type="button" onClick={() => void loadSlots()}>Try again</button></div>}
        {phase === 'ready' && slots.length === 0 && <p>No times are available for this date. Try another day.</p>}
        {phase === 'ready' && slots.length > 0 && <div className="hfb-slot-grid" role="group" aria-label="Available appointment times">
          {slots.map(slot => <button type="button" key={slot.startUtc} className={selected?.startUtc === slot.startUtc ? 'hfb-slot is-selected' : 'hfb-slot'} aria-pressed={selected?.startUtc === slot.startUtc} onClick={() => void choose(slot)} disabled={busy}>
            <strong>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(slot.startUtc))}</strong><span>{slot.hostLocalLabel} influencer time</span><small>{slot.offsetLabel}</small>
          </button>)}
        </div>}
        {message && phase === 'ready' && !quote && <p role="status" className="hfb-message">{message}</p>}
      </section>
      {quote && selected && <section className="hfb-card hfb-quote" aria-labelledby="hfb-confirm">
        <h2 id="hfb-confirm">Review and confirm</h2>
        <dl className="hfb-details"><div><dt>Date and time</dt><dd>{new Date(quote.startUtc).toLocaleString()} · {selected.hostLocalLabel} influencer time ({selected.offsetLabel})</dd></div><div><dt>Length</dt><dd>{quote.durationMinutes} minutes</dd></div><div><dt>Price to reserve</dt><dd><strong>{quote.priceRupees || money(quote.reservedPaise)}</strong></dd></div><div><dt>Quote expires</dt><dd>{new Date(quote.expiresAt).toLocaleTimeString()}</dd></div></dl>
        <p className="hfb-muted">Before the call connects, either person may cancel and the server releases the reservation. No cancellation penalty or no-show fee applies. After connection, the call charges only for verified connected time.</p>
        <label className="hfb-check"><input type="checkbox" checked={policyAccepted} onChange={e => setPolicyAccepted(e.target.checked)} /><span>I understand the reservation and cancellation policy.</span></label>
        {message && <p role="status" className="hfb-message">{message}</p>}
        <div className="hfb-actions"><button type="button" className="hfb-button hfb-primary" onClick={() => void confirm()} disabled={busy || !policyAccepted}>{busy ? 'Confirming…' : 'Confirm and reserve'}</button><button type="button" className="hfb-button" onClick={() => { setQuote(null); setSelected(null); setMessage(''); }}>Pick another time</button></div>
        {topUp && <div className="hfb-note" role="alert"><p>Add funds to your wallet to continue. Your chosen time may change while you top up, so we’ll check availability and show a fresh quote when you return.</p><button className="hfb-button" type="button" onClick={goTopUp}>Add money</button></div>}
      </section>}
    </>}
  </main>;
}
