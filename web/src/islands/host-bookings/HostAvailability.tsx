import { useEffect, useMemo, useRef, useState } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { PageShell, useEmbedded, useIntoDashboard } from '../../components/account/dashboardEmbed';
import { bookingError, getHostSchedule, legacyHoursToRules, listBookings, normalizeAvailabilitySchedule, saveHostSchedule, type AvailabilitySchedule, type DateException, type HfBooking, type LegacyAvailabilityPreview, type WindowRule } from '../../lib/hfBookingsApi';
import { collectBookingPages } from '../../lib/hfBookingCalendar';
import '../../styles/hf-bookings.css';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (minute: number) => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
const mins = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const iso = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const blank = (): AvailabilitySchedule => ({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata', version: 0,
  durationsMinutes: [10], slotIntervalMinutes: 15, bufferMinutes: 10, minNoticeMinutes: 120,
  horizonDays: 60, rules: [], exceptions: [],
});
/** [HF-BOOKING-E2E-1] Bookings that still hold a time: confirmed, waiting for the influencer's yes, or happening now. */
const HOLDS_TIME = ['confirmed', 'pending_approval', 'starting', 'active'];
function dayIn(utc: string, timezone: string): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utc)); }
  catch { return iso(new Date(utc)); }
}
function timeIn(utc: string, timezone: string): string {
  try { return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc)); }
  catch { return new Date(utc).toLocaleTimeString(); }
}
export default function HostAvailability() {
  useIntoDashboard('/dashboard/host/availability');
  const embedded = useEmbedded();
  const feature = useBookingFeature();
  const [schedule, setSchedule] = useState<AvailabilitySchedule>(blank);
  const [saved, setSaved] = useState<AvailabilitySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const [legacyPreview, setLegacyPreview] = useState<LegacyAvailabilityPreview | null>(null);
  const [legacyNeedsConfirmation, setLegacyNeedsConfirmation] = useState(false);
  const [legacyAcknowledged, setLegacyAcknowledged] = useState(false);
  const [month, setMonth] = useState(today);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [exceptionStatus, setExceptionStatus] = useState<'available' | 'unavailable'>('unavailable');
  const [fullDay, setFullDay] = useState(false);
  const [fromTime, setFromTime] = useState('09:00');
  const [toTime, setToTime] = useState('17:00');
  const pointerSelecting = useRef(false);
    const datePointerEvent = useRef(false);
  const [dragWeekday, setDragWeekday] = useState(1);
  const [keyboardAnchor, setKeyboardAnchor] = useState<number | null>(null);
  const [manualFrom, setManualFrom] = useState('09:00');
  const [manualTo, setManualTo] = useState('10:00');
  const timeDrag = useRef<{ start: number; end: number } | null>(null);
  const [booked, setBooked] = useState<HfBooking[]>([]);
  const [bookedFailed, setBookedFailed] = useState(false);

  const load = async () => {
    setLoading(true); setMessage(''); setStale(false);
    try {
      const response = await getHostSchedule();
      const fresh = response.schedule;
      const requiresConfirmation = response.legacyPreview?.requiresHostTimezoneConfirmation === true && fresh.version === 0;
      let draft = fresh;
      if (requiresConfirmation && response.legacyPreview) {
        const mapped = legacyHoursToRules(response.legacyPreview.hours);
        const signatures = new Set(fresh.rules.map(rule => `${rule.weekday}:${rule.startMin}:${rule.endMin}`));
        draft = { ...fresh, rules: [...fresh.rules, ...mapped.filter(rule => !signatures.has(`${rule.weekday}:${rule.startMin}:${rule.endMin}`))] };
      }
      setSchedule(draft); setSaved(fresh); setLegacyPreview(requiresConfirmation ? response.legacyPreview ?? null : null);
      setLegacyNeedsConfirmation(requiresConfirmation); setLegacyAcknowledged(false);
    }
    catch (error) { setMessage(bookingError(error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (feature === 'enabled') void load(); }, [feature]);
  useEffect(() => {
    const stop = () => { pointerSelecting.current = false; timeDrag.current = null; };
    window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop); window.addEventListener('blur', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); };
  }, []);
  // Which days of the shown month already carry a booking or a request (reloaded when the month changes and after every save).
  useEffect(() => {
    if (feature !== 'enabled') return;
    let live = true;
    const from = new Date(month.getFullYear(), month.getMonth(), 0).toISOString();
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 2).toISOString();
    void collectBookingPages(cursor => listBookings('host', from, to, cursor), () => live).then(r => {
      if (!live) return;
      setBooked(r.rows.filter(b => HOLDS_TIME.includes(b.status))); setBookedFailed(!!r.error);
    });
    return () => { live = false; };
  }, [feature, month, saved]);
  const bookedByDay = useMemo(() => {
    const map = new Map<string, HfBooking[]>();
    for (const b of booked) { const k = dayIn(b.startUtc, schedule.timezone); map.set(k, [...(map.get(k) ?? []), b]); }
    for (const rows of map.values()) rows.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    return map;
  }, [booked, schedule.timezone]);
  const waitingTotal = booked.filter(b => b.status === 'pending_approval').length;
  const monthDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = first.getDay();
    return [...Array(offset).fill(null), ...Array(new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()).fill(0).map((_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  }, [month]);
  const setRule = (index: number, change: Partial<WindowRule>) => setSchedule(s => ({ ...s, rules: s.rules.map((r, i) => i === index ? { ...r, ...change } : r) }));
  const addRule = (weekday: number) => setSchedule(s => ({ ...s, rules: [...s.rules, { weekday, startMin: 540, endMin: 1020 }] }));
  const addException = () => {
    if (!rangeStart || !rangeEnd) { setMessage('Choose a valid date range first.'); return; }
    const start = fullDay ? 0 : mins(fromTime); const end = fullDay ? 1440 : mins(toTime);
    if (start === end) { setMessage('Start and end times must be different.'); return; }
    const rows: DateException[] = [];
    const firstKey = rangeStart < rangeEnd ? rangeStart : rangeEnd; const lastKey = rangeStart < rangeEnd ? rangeEnd : rangeStart;
    const cursor = new Date(firstKey + 'T12:00:00'); const last = new Date(lastKey + 'T12:00:00');
    for (; cursor <= last; cursor.setDate(cursor.getDate() + 1)) rows.push({ date: iso(cursor), startMin: start, endMin: end, status: exceptionStatus });
    setSchedule(s => ({ ...s, exceptions: [...s.exceptions.filter(e => !rows.some(r => r.date === e.date && r.startMin === e.startMin && r.endMin === e.endMin)), ...rows] }));
    setMessage(rows.length === 1 ? 'Date override added.' : rows.length + ' date overrides added.');
  };
  const addManualWeekWindow = (start: number, end: number) => {
    if (start === end) { setMessage('Choose two different times.'); return; }
    const parts = end > start ? [{ weekday: dragWeekday, startMin: start, endMin: end }] : [{ weekday: dragWeekday, startMin: start, endMin: 1440 }, ...(end > 0 ? [{ weekday: (dragWeekday + 1) % 7, startMin: 0, endMin: end }] : [])];
    setSchedule(s => ({ ...s, rules: [...s.rules, ...parts] })); setMessage('Weekly hours added.');
  };
  const addWeekWindow = (start: number, end: number) => {
    const low = Math.min(start, end); const high = Math.max(start, end);
    if (low === high) { setMessage('Choose two different times.'); return; }
    setSchedule(s => ({ ...s, rules: [...s.rules, { weekday: dragWeekday, startMin: low, endMin: high }] }));
    setKeyboardAnchor(null); setMessage('Weekly hours added.');
  };
  const save = async () => {
    if (schedule.rules.some(r => r.startMin === r.endMin) || schedule.exceptions.some(e => e.startMin === e.endMin)) { setMessage('Check each time window. Start and end cannot match.'); return; }
    const needsConfirmation = legacyNeedsConfirmation && schedule.version === 0;
    if (needsConfirmation && !legacyAcknowledged) { setMessage('Confirm the influencer timezone for these legacy hours before saving.'); return; }
    // [HF-BOOKING-UNIFY-1] Every booking, in the app and on the web, is a 10-minute call: that is the only length on offer.
    const normalized = normalizeAvailabilitySchedule({ ...schedule, durationsMinutes: [10] });
    setSaving(true); setMessage(''); setStale(false);
    try {
      const next = await saveHostSchedule(normalized, schedule.version, needsConfirmation && legacyAcknowledged);
      setSchedule(next); setSaved(next); setLegacyPreview(null); setLegacyNeedsConfirmation(false); setLegacyAcknowledged(false); setMessage('Availability saved.');
    }
    catch (error) { const issue = bookingError(error); setMessage(issue.message); setStale(issue.status === 409); }
    finally { setSaving(false); }
  };
  const selectDay = (key: string) => {
    if (!rangeStart || rangeStart !== rangeEnd) { setRangeStart(key); setRangeEnd(key); }
    else setRangeEnd(key);
  };
  const changeZone = (zone: string) => { setSchedule(s => ({ ...s, timezone: zone })); if (legacyNeedsConfirmation) setLegacyAcknowledged(false); };

  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  return <PageShell className="hfb-page hfb-wide">
    <SessionBridge on={!embedded} />
    <header className="hfb-heading"><p className="hfb-eyebrow">Influencer calendar</p><h1>Availability</h1><p>Set recurring hours and date exceptions. Saving checks confirmed appointments on the server. Paid appointments cannot be moved here.</p></header>
    {loading && <p className="hfb-card" role="status">Loading your schedule…</p>}
    {!loading && !saved && message && <section className="hfb-card"><p role="alert">{message}</p><button className="hfb-button" type="button" onClick={() => void load()}>Try again</button></section>}
    {!loading && saved && message && <p className={stale ? 'hfb-message hfb-warn' : 'hfb-message'} role={stale ? 'alert' : 'status'}>{message}</p>}
    {stale && <section className="hfb-note"><strong>This schedule changed in another tab.</strong><p>Reload the latest version before editing again.</p><button className="hfb-button" type="button" onClick={() => void load()}>Reload schedule</button></section>}
    {!loading && saved && <section className="hfb-card" aria-labelledby="hfb-zone">
      <h2 id="hfb-zone">Timezone</h2><label className="hfb-label" htmlFor="hfb-timezone">Your schedule timezone (IANA)</label>
      <input id="hfb-timezone" className="hfb-input" value={schedule.timezone} onChange={e => changeZone(e.target.value)} placeholder="Asia/Kolkata" />
      <p className="hfb-muted">Recurring hours follow this timezone. Confirmed appointments keep their original instant if you change it.</p>
      {legacyNeedsConfirmation && legacyPreview && <div className="hfb-note" role="group" aria-labelledby="hfb-legacy-title">
        <h3 id="hfb-legacy-title">Review your existing hours before first save</h3>
        <p>These hours came from your existing profile and are shown here as an editable draft. They have not been saved to the booking calendar.</p>
        <p><strong>Legacy hours:</strong> {legacyHoursToRules(legacyPreview.hours).map(rule => DAYS[rule.weekday]).join(', ') || 'No valid days'} · {String(legacyPreview.hours.from ?? '')}–{String(legacyPreview.hours.to ?? '')}</p>
        <label className="hfb-check"><input type="checkbox" checked={legacyAcknowledged} onChange={e => setLegacyAcknowledged(e.target.checked)} /><span>I confirm these existing hours use the influencer timezone <strong>{schedule.timezone}</strong>.</span></label>
      </div>}
    </section>}
    {!loading && saved && <section className="hfb-card" aria-labelledby="hfb-weekly">
      <div className="hfb-section-head"><div><h2 id="hfb-weekly">Weekly hours</h2><p className="hfb-muted">Add more than one time window for a day. Keyboard users can edit every time field directly.</p></div></div>
      <div className="hfb-weekly">
        {DAYS.map((day, weekday) => <div className="hfb-day-row" key={day}><h3>{day}</h3><div className="hfb-windows">
          {schedule.rules.map((rule, index) => rule.weekday === weekday && <div className="hfb-window" key={index}>
            <label><span className="hfb-visually-hidden">{day} window start</span><input aria-label={day + ' window start'} className="hfb-time" type="time" value={clock(rule.startMin)} onChange={e => setRule(index, { startMin: mins(e.target.value) })} /></label><span aria-hidden="true">to</span>
            <label><span className="hfb-visually-hidden">{day} window end</span><input aria-label={day + ' window end'} className="hfb-time" type="time" value={clock(rule.endMin === 1440 ? 0 : rule.endMin)} onChange={e => setRule(index, { endMin: mins(e.target.value) })} /></label>
            <button type="button" className="hfb-icon-button" aria-label={'Remove ' + day + ' window'} onClick={() => setSchedule(s => ({ ...s, rules: s.rules.filter((_, i) => i !== index) }))}>Remove</button>
          </div>)}
          <button type="button" className="hfb-button hfb-small" onClick={() => addRule(weekday)}>Add hours</button>
        </div></div>)}
      </div>
      <div className="hfb-drag-editor">
        <label className="hfb-label">Choose a day for time selection<select className="hfb-input" value={dragWeekday} onChange={e => setDragWeekday(Number(e.target.value))}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        <p className="hfb-muted">Desktop: drag over the time blocks. Keyboard: focus two blocks and press Enter on each. Phone: choose exact start and end times below.</p>
        <div className="hfb-time-grid" role="group" aria-label={'Select hours for ' + DAYS[dragWeekday]}>
          {[...Array(48)].map((_, index) => { const start = index * 30; return <button type="button" key={start} className="hfb-time-cell" aria-label={clock(start) + ' to ' + clock(start + 30)} onPointerDown={() => { timeDrag.current = { start, end: start + 30 }; }} onPointerEnter={() => { if (timeDrag.current) timeDrag.current.end = start + 30; }} onPointerUp={() => { if (timeDrag.current) { addWeekWindow(timeDrag.current.start, timeDrag.current.end); timeDrag.current = null; } }} onClick={e => { if (e.detail !== 0) return; if (keyboardAnchor == null) setKeyboardAnchor(start); else addWeekWindow(keyboardAnchor, start + 30); }}>{clock(start)}</button>; })}
        </div>
        <div className="hfb-range-fields"><label className="hfb-label">Start time<input className="hfb-input" type="time" value={manualFrom} onChange={e => setManualFrom(e.target.value)} /></label><label className="hfb-label">End time<input className="hfb-input" type="time" value={manualTo} onChange={e => setManualTo(e.target.value)} /></label><button type="button" className="hfb-button" onClick={() => addManualWeekWindow(mins(manualFrom), mins(manualTo))}>Add this window</button></div>
      </div>
      <p className="hfb-muted">If an end time is earlier than its start, the window is split across the next day when saved.</p>
    </section>}
    {!loading && saved && <section className="hfb-card" aria-labelledby="hfb-dates">
      <div className="hfb-section-head"><div><h2 id="hfb-dates">Date overrides</h2><p className="hfb-muted">Drag across dates on desktop. On a phone or keyboard, select the first and last dates below.</p></div><div className="hfb-month-controls"><button type="button" className="hfb-icon-button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button><strong>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month)}</strong><button type="button" className="hfb-icon-button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button></div></div>
      <div className="hfb-calendar" role="group" aria-label="Select date range">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <span className="hfb-calendar-label" key={d}>{d}</span>)}
        {monthDays.map((day, index) => {
          if (!day) return <span className="hfb-date-empty" key={'empty-' + index} />;
          const key = iso(day); const low = rangeStart < rangeEnd ? rangeStart : rangeEnd; const high = rangeStart < rangeEnd ? rangeEnd : rangeStart;
          const holds = bookedByDay.get(key) ?? []; const waiting = holds.filter(b => b.status === 'pending_approval').length;
          return <button type="button" key={key} className={(rangeStart && rangeEnd && key >= low && key <= high ? 'hfb-date is-selected' : 'hfb-date') + (holds.length ? ' is-booked' : '') + (waiting ? ' is-waiting' : '')} aria-pressed={rangeStart === key || rangeEnd === key}
            aria-label={holds.length ? `${day.getDate()}: ${holds.length} booked${waiting ? `, ${waiting} waiting for your answer` : ''}` : undefined}
            onPointerDown={() => { datePointerEvent.current = true; pointerSelecting.current = true; setRangeStart(key); setRangeEnd(key); }}
            onPointerEnter={() => { if (pointerSelecting.current) setRangeEnd(key); }}
            onPointerUp={() => { pointerSelecting.current = false; }}
            onClick={() => { if (datePointerEvent.current) { datePointerEvent.current = false; return; } selectDay(key); }}>{day.getDate()}{holds.length > 0 && <span className="hfb-date-badge" aria-hidden="true">{holds.length}</span>}</button>;
        })}
      </div>
      <p className="hfb-legend" role="status"><span className="hfb-key is-booked" aria-hidden="true" />Crossed-out days already have a booking{waitingTotal > 0 && <> · <span className="hfb-key is-waiting" aria-hidden="true" />{waitingTotal} waiting for your answer</>}{bookedFailed && ' · some bookings could not be loaded'}</p>
      {bookedByDay.size > 0 && <ul className="hfb-booked-list" aria-label="Booked days this month">{[...bookedByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => <li key={date}><strong>{date}</strong><span>{rows.map(r => `${timeIn(r.startUtc, schedule.timezone)} ${r.status === 'pending_approval' ? '(waiting)' : '(booked)'}`).join(' · ')}</span><a href={'/bookings/' + encodeURIComponent(rows[0].id)}>Open</a></li>)}</ul>}
      <div className="hfb-range-fields"><label className="hfb-label">First date<input className="hfb-input" type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)} /></label><label className="hfb-label">Last date<input className="hfb-input" type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} /></label></div>
      <div className="hfb-range-fields"><label className="hfb-label">From<input className="hfb-input" type="time" value={fromTime} onChange={e => setFromTime(e.target.value)} /></label><label className="hfb-label">To<input className="hfb-input" type="time" value={toTime} onChange={e => setToTime(e.target.value)} /></label><label className="hfb-label">Availability<select className="hfb-input" value={exceptionStatus} onChange={e => setExceptionStatus(e.target.value as 'available' | 'unavailable')}><option value="unavailable">Block these hours</option><option value="available">Open these hours</option></select></label></div>
      <label className="hfb-check"><input type="checkbox" checked={fullDay} onChange={e => setFullDay(e.target.checked)} /><span>Block or open the full selected day</span></label>
      <button type="button" className="hfb-button" onClick={addException}>Apply date override</button>
      <ul className="hfb-exceptions">{schedule.exceptions.map((item, index) => <li key={item.date + '-' + item.startMin + '-' + index}><strong>{item.date}</strong><span>{clock(item.startMin)}–{clock(item.endMin)} · {item.status === 'available' ? 'Available' : 'Blocked'}</span><button type="button" className="hfb-icon-button" aria-label={'Remove override on ' + item.date} onClick={() => setSchedule(s => ({ ...s, exceptions: s.exceptions.filter((_, i) => i !== index) }))}>Remove</button></li>)}</ul>
      <p className="hfb-muted">An override adds or blocks hours for those dates only. Other dates and windows are preserved.</p>
    </section>}
    {!loading && saved && schedule !== saved && <section className="hfb-card hfb-note" aria-labelledby="hfb-preview"><h2 id="hfb-preview">Before you save</h2><p>These calendar rules and settings will replace the saved version. Existing confirmed appointments keep their times.</p><ul>{schedule.rules.map((rule, i) => <li key={'r'+i}>{DAYS[rule.weekday]} {clock(rule.startMin)}–{clock(rule.endMin)}</li>)}{schedule.exceptions.map((item, i) => <li key={'e'+i}>{item.date} {clock(item.startMin)}–{clock(item.endMin)} · {item.status}</li>)}</ul></section>}
    {!loading && saved && <section className="hfb-card" aria-labelledby="hfb-policy">
      <h2 id="hfb-policy">Booking settings</h2>
      <div className="hfb-range-fields">
        <label className="hfb-label">Minimum notice (minutes)<input className="hfb-input" type="number" min="0" max="10080" value={schedule.minNoticeMinutes} onChange={e => setSchedule(s => ({ ...s, minNoticeMinutes: Number(e.target.value) }))} /></label>
        <label className="hfb-label">Gap between appointments (minutes)<input className="hfb-input" type="number" min="0" max="120" value={schedule.bufferMinutes} onChange={e => setSchedule(s => ({ ...s, bufferMinutes: Number(e.target.value) }))} /></label>
        <label className="hfb-label">Booking horizon (days)<input className="hfb-input" type="number" min="1" max="60" value={schedule.horizonDays} onChange={e => setSchedule(s => ({ ...s, horizonDays: Number(e.target.value) }))} /></label>
      </div>
      <p className="hfb-muted">Every appointment is a 10-minute call, in the app and on the web. Times you mark in the app show here as date overrides.</p>
      <label className="hfb-label">Start interval (minutes)<input className="hfb-input" type="number" min="5" max="60" step="5" value={schedule.slotIntervalMinutes} onChange={e => setSchedule(s => ({ ...s, slotIntervalMinutes: Number(e.target.value) }))} /></label>
      <div className="hfb-actions"><button type="button" className="hfb-button hfb-primary" onClick={() => void save()} disabled={saving || stale}>{saving ? 'Saving…' : 'Save availability'}</button><button type="button" className="hfb-button" disabled={saving || !saved} onClick={() => { if (saved) { setSchedule(saved); setMessage('Unsaved changes reverted.'); } }}>Undo unsaved changes</button></div>
      <p className="hfb-muted">Version {schedule.version}. Saved appointments are never moved by calendar edits.</p>
    </section>}
  </PageShell>;
}
