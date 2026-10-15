import { useEffect, useState } from 'react';
import { bookingsOnDay, calendarDays, collectBookingPages, dayEnd } from '../../lib/hfBookingCalendar';
import { getActiveTokenWaited } from '../../lib/clerk';
import { bookingError, listBookings, type HfBooking } from '../../lib/hfBookingsApi';

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
export default function DashboardCalendar({ uid, host, enabled, onTodayCount }: { uid: string; host: boolean; enabled: boolean; onTodayCount: (count: number | null) => void }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState(() => new Date());
  const [bookings, setBookings] = useState<HfBooking[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    const changed = () => { current = false; setBookings([]); onTodayCount(null); };
    window.addEventListener('site:active-session-changed', changed);
    setBookings([]); setState('loading'); onTodayCount(null);
    if (enabled) void (async () => {
      try {
        const token = await getActiveTokenWaited(6000);
        if (!current) return;
        if (!token) throw new Error('Please sign in again.');
        // Pin the account across each role and every page; keep navigation ranges bounded.
        const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const cells = calendarDays(month);
        const end = dayEnd(cells[cells.length - 1]);
        const ranges = [{ from: cells[0].toISOString(), to: end.toISOString() }];
        if (today < cells[0] || today >= end) ranges.push({ from: today.toISOString(), to: dayEnd(today).toISOString() });
        const items = new Map<string, HfBooking>();
        for (const role of host ? ['customer', 'host'] as const : ['customer'] as const) {
          for (const range of ranges) {
            const result = await collectBookingPages(cursor => listBookings(role, range.from, range.to, cursor, token), () => current);
            if (!current) return;
            if (result.error) throw result.error;
            result.rows.forEach(booking => items.set(booking.id, booking));
          }
        }
        if (!current) return;
        const result = [...items.values()].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
        setBookings(result); setState('ready');
        onTodayCount(bookingsOnDay(result, today).filter(booking => !booking.status.startsWith('cancel')).length);
      } catch (cause) { if (current) { setState('error'); setError(bookingError(cause).message); onTodayCount(null); } }
    })();
    return () => { current = false; window.removeEventListener('site:active-session-changed', changed); };
  }, [uid, host, enabled, month, retry, onTodayCount]);
  const days = calendarDays(month);
  const entries = bookingsOnDay(bookings, selected);
  const move = (amount: number) => { const next = new Date(month.getFullYear(), month.getMonth() + amount, 1); setMonth(next); setSelected(next); };
  return <section className="hfc-card hfd-calendar-card" aria-labelledby="hfd-appointments"><div className="hfd-card-head"><h2 id="hfd-appointments">Your appointments</h2><a href={host ? '/dashboard/host/calendar' : '/dashboard/appointments'}>View full calendar <span aria-hidden="true">→</span></a></div><div className="hfd-calendar-layout">
    <div className="hfd-agenda"><h3>{selected.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</h3><p className="hfd-muted">Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
      {!enabled ? <p>Appointments are not available right now.</p> : state === 'loading' ? <p role="status">Loading appointments…</p> : state === 'error' ? <p role="alert">{error} <button type="button" className="hfb-text-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : entries.length ? <ul className="hfd-appointments">{entries.map(booking => <li key={booking.id}><time dateTime={booking.startUtc}>{new Date(booking.startUtc).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</time><div><strong>{booking.hostUid === uid ? booking.customerHandle || 'Booked appointment' : booking.hostName || 'Booked appointment'}</strong><small>{booking.status.replaceAll('_', ' ')}</small></div></li>)}</ul> : <div className="hfd-empty"><span aria-hidden="true">♡</span><p>No appointments for this day.</p><a href="/marketplace">Explore influencers →</a></div>}
    </div><div className="hfd-month"><div className="hfd-month-head"><button type="button" aria-label="Previous month" onClick={() => move(-1)}>‹</button><h3 aria-live="polite">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h3><button type="button" aria-label="Next month" onClick={() => move(1)}>›</button></div><div className="hfd-days">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => <span className="hfd-weekday" key={day}>{day}</span>)}{days.map((date, i) => { const hasBooking = bookingsOnDay(bookings, date).length > 0; return <button key={i} type="button" aria-label={`${date.toLocaleDateString('en-IN', { dateStyle: 'full' })}${hasBooking ? ', has appointments' : ''}`} aria-pressed={dayKey(selected) === dayKey(date)} className={`${hasBooking ? 'hfd-has-booking' : ''}${date.getMonth() !== month.getMonth() ? ' hfd-other-month' : ''}`} onClick={() => setSelected(date)}>{date.getDate()}</button>; })}</div><p className="hfd-calendar-key"><span /> Appointments</p></div>
  </div></section>;
}
