import { useEffect, useMemo, useRef, useState } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { PageShell, useEmbedded, useIntoDashboard } from '../../components/account/dashboardEmbed';
import { signInUrl } from '../../lib/hfCallsApi';
import { ACTIVE_SESSION_CHANGED, getActiveTokenWaited } from '../../lib/clerk';
import { BRAND } from '../../lib/brand';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';
import { bookingError, dateLabel, listBookings, money, type BookingRole, type HfBooking } from '../../lib/hfBookingsApi';
import { bookingsOnDay, calendarDays, calendarMonth, collectBookingPages, dayEnd, localDayKey } from '../../lib/hfBookingCalendar';
import '../../styles/hf-bookings.css';

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (day: Date) => day.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const person = (row: HfBooking, role: BookingRole) => role === 'host' ? row.customerHandle || 'A customer' : row.hostName || 'Your influencer';

export default function HostBookings({ role = 'customer' }: { role?: BookingRole }) {
  const feature = useBookingFeature();
  const embedded = useEmbedded();
  useIntoDashboard(role === 'host' ? '/dashboard/host/calendar' : '/dashboard/appointments');
  const [month, setMonth] = useState(() => calendarMonth(new Date()));
  const [selected, setSelected] = useState(() => new Date());
  const [rows, setRows] = useState<HfBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const days = useMemo(() => calendarDays(month), [month]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = localDayKey(new Date());
  const selectedKey = localDayKey(selected);
  const dayRows = bookingsOnDay(rows, selected);
  const monthRows = rows.filter(row => Date.parse(row.startUtc) < new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime()
    && Date.parse(row.endUtc) > month.getTime());

  // Invalidate synchronously on identity changes, before a pending page can settle.
  useEffect(() => {
    const changed = () => {
      generation.current++; setRows([]); setMessage(''); setLoading(true); setSignedOut(false); setRetry(n => n + 1);
    };
    window.addEventListener(ACTIVE_SESSION_CHANGED, changed);
    window.addEventListener('storage', changed);
    return () => { window.removeEventListener(ACTIVE_SESSION_CHANGED, changed); window.removeEventListener('storage', changed); };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    setRows([]); setMessage(''); setSignedOut(false);
    if (feature !== 'enabled') { setLoading(feature === 'checking'); return; }
    setLoading(true);
    void (async () => {
      try {
        const token = await getActiveTokenWaited(6000);
        if (!isCurrent()) return;
        if (!token) { setSignedOut(true); return; }
        const result = await collectBookingPages(cursor => listBookings(role, days[0].toISOString(), dayEnd(days[days.length - 1]).toISOString(), cursor, token), isCurrent);
        if (!isCurrent()) return;
        if (result.error) {
          const error = bookingError(result.error);
          if (error.status === 401) { setSignedOut(true); return; }
          setMessage(result.rows.length ? 'Some appointments could not be loaded. This calendar is incomplete. Please try again.' : 'We could not load your calendar. Please try again.');
        }
        setRows(result.rows);
      } catch {
        if (isCurrent()) setMessage('We could not load your calendar. Please try again.');
      } finally { if (isCurrent()) setLoading(false); }
    })();
    return () => { generation.current++; };
  }, [role, retry, feature, days]);

  function navigate(date: Date) {
    generation.current++; setRows([]); setMessage(''); setLoading(true);
    setMonth(calendarMonth(date)); setSelected(date);
  }
  function retryLoad() {
    generation.current++; setRows([]); setMessage(''); setLoading(true); setRetry(n => n + 1);
  }
  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  return <PageShell className="hfb-page hfb-wide hfb-appointments">
    <SessionBridge on={!embedded} />
    <header className="hfb-heading">
      <p className="hfb-eyebrow">{BRAND.name} · {role === 'host' ? 'Influencer calendar' : 'Appointment calendar'}</p>
      <h1>{role === 'host' ? 'Your influencer calendar' : 'Your appointments'}</h1>
      <p>{role === 'host' ? 'Your booked conversations, together in one calendar.' : 'Make time for your next conversation. Select a day to see your appointments.'}</p>
      <div className="hfb-actions">{!embedded && <a className="hfb-back" href="/dashboard">← Dashboard</a>}{role === 'host' && <a className="hfb-back" href="/dashboard/host/availability">Manage availability</a>}</div>
    </header>
    {signedOut ? <section className="hfb-card"><h2>Sign in to see your calendar</h2><p>Your appointments are private to your account.</p><a className="hfb-button hfb-primary" href={signInUrl(role === 'host' ? '/dashboard/host/calendar' : '/dashboard/appointments')}>Sign in</a></section> : <>
      <section className="hfb-card hfb-appointment-month" aria-labelledby="hfb-month-title" aria-busy={loading}>
        <div className="hfb-section-head">
          <div><p className="hfb-eyebrow">Your month</p><h2 id="hfb-month-title" aria-live="polite">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2></div>
          <div className="hfb-month-controls"><button className="hfb-icon-button" type="button" aria-label="Previous month" onClick={() => navigate(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button><button className="hfb-button hfb-small" type="button" onClick={() => navigate(new Date())}>Today</button><button className="hfb-icon-button" type="button" aria-label="Next month" onClick={() => navigate(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button></div>
        </div>
        <p className="hfb-muted">All calendar dates and times use your device timezone: <strong>{timezone}</strong>.</p>
        <div className="hfb-calendar-scroll" role="region" aria-label="Appointment dates; scroll horizontally on small screens" tabIndex={0}>
        <div className="hfb-appointment-grid" role="group" aria-label="Select an appointment date">
          {weekdays.map(day => <span className="hfb-calendar-label" key={day} aria-hidden="true">{day}</span>)}
          {days.map(day => {
            const key = localDayKey(day);
            const appointments = bookingsOnDay(rows, day);
            return <button key={key} type="button" className={'hfb-appointment-date' + (key === selectedKey ? ' is-selected' : '') + (day.getMonth() !== month.getMonth() ? ' is-outside' : '')}
              aria-pressed={key === selectedKey} aria-current={key === today ? 'date' : undefined}
              aria-label={`${dayLabel(day)}${key === today ? ', today' : ''}${loading ? ', loading appointments' : message ? `, ${appointments.length} loaded appointments, calendar incomplete` : `, ${appointments.length} appointments`}`}
              onClick={() => setSelected(day)}>
              <span className="hfb-day-number">{day.getDate()}</span>
              {appointments.length > 0 && <><span className="hfb-day-count">{appointments.length}<span className="hfb-visually-hidden"> appointments</span></span><span className="hfb-day-preview" aria-hidden="true">{person(appointments[0], role)}</span></>}
            </button>;
          })}
        </div>
        </div>
        {loading ? <p className="hfb-muted" role="status">Loading appointments…</p> : <p className="hfb-muted" role="status">{message ? 'Calendar incomplete — counts include only loaded appointments.' : `${monthRows.length} appointment${monthRows.length === 1 ? '' : 's'} this month. Select a date for details.`}</p>}
      </section>
      {message && <section className="hfb-note"><p role="alert">{message}</p><button className="hfb-button" type="button" onClick={retryLoad}>Try again</button></section>}
      <section className="hfb-agenda" aria-labelledby="hfb-agenda-title" aria-busy={loading}>
        <div className="hfb-section-head"><h2 id="hfb-agenda-title">{dayLabel(selected)}</h2><span className="hfb-muted">Daily agenda</span></div>
        {loading ? <p className="hfb-card" role="status">Loading your agenda…</p> : dayRows.length === 0 ? <div className="hfb-card"><h3>{message ? 'Appointments may be missing' : 'No appointments on this day'}</h3><p className="hfb-muted">{message ? 'Try loading the calendar again to see the full day.' : 'Choose another day or return to today to see your booked conversations.'}</p>{role === 'customer' && !message && <a className="hfb-button" href="/marketplace">Explore influencers</a>}</div> : <ul className="hfb-booking-list">
          {dayRows.map(row => <li className="hfb-card hfb-booking-row" key={row.id}>
            <div><span className={'hfb-status hfb-status-' + row.status}>{row.status.replaceAll('_', ' ')}</span><h3>{person(row, role)}</h3><p><time dateTime={row.startUtc}>{dateLabel(row.startUtc, timezone)}</time> – <time dateTime={row.endUtc}>{dateLabel(row.endUtc, timezone)}</time></p><p className="hfb-muted">Influencer timezone: {row.hostTimezone}</p></div>
            {role === 'host' && typeof row.expectedHostNetPaise === 'number' && row.status === 'confirmed' && <p className="hfb-money"><strong>{money(row.expectedHostNetPaise)}</strong><span>expected on hold</span></p>}
            <a className="hfb-button" href={'/bookings/' + encodeURIComponent(row.id)} aria-label={`View appointment with ${person(row, role)} on ${dateLabel(row.startUtc, timezone)}`}>View details</a>
          </li>)}
        </ul>}
      </section>
    </>}
  </PageShell>;
}
