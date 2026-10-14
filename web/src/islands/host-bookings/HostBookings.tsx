import { useEffect, useState } from 'react';
import { looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';
import { bookingError, dateLabel, listBookings, money, type BookingRole, type HfBooking } from '../../lib/hfBookingsApi';
import '../../styles/hf-bookings.css';

export default function HostBookings({ role = 'customer' }: { role?: BookingRole }) {
  const feature = useBookingFeature();
  const [rows, setRows] = useState<HfBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (feature !== 'enabled') { setLoading(feature === 'checking'); if (feature === 'disabled') setRows([]); return; }
    let live = true; setLoading(true); setMessage('');
    if (looksSignedOut()) { setLoading(false); setMessage('Please sign in to see your bookings.'); return; }
    listBookings(role).then(page => {
      if (live) setRows(page.bookings);
    }).catch(error => {
      if (live) setMessage(bookingError(error).message);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [role, retry, feature]);
  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  const title = role === 'host' ? 'Your bookings' : 'Your appointments';
  return <main className="hfb-page">
    <header className="hfb-heading"><p className="hfb-eyebrow">{role === 'host' ? 'Host calendar' : 'Your account'}</p><h1>{title}</h1><p>{role === 'host' ? 'See upcoming and past appointments. Booked times are confirmed by the server.' : 'Your appointments and their current status.'}</p></header>
    {looksSignedOut() && <section className="hfb-card"><p>{message}</p><a className="hfb-button hfb-primary" href={signInUrl(window.location.pathname + window.location.search)}>Sign in</a></section>}
    {!looksSignedOut() && loading && <p className="hfb-card" role="status">Loading bookings…</p>}
    {!looksSignedOut() && !loading && message && <section className="hfb-card"><p role="alert">{message}</p><button className="hfb-button" type="button" onClick={() => setRetry(n => n + 1)}>Try again</button></section>}
    {!looksSignedOut() && !loading && !message && rows.length === 0 && <section className="hfb-card"><h2>No bookings yet</h2><p>Appointments will appear here once they’re confirmed.</p>{role === 'customer' && <a className="hfb-button" href="/marketplace">Explore hosts</a>}</section>}
    {!loading && !message && rows.length > 0 && <ul className="hfb-booking-list">
      {rows.map(row => <li className="hfb-card hfb-booking-row" key={row.id}>
        <div><span className={'hfb-status hfb-status-' + row.status}>{row.status.replaceAll('_', ' ')}</span><h2>{role === 'host' ? row.customerHandle || 'A customer' : row.hostName || 'Your host'}</h2><p>{dateLabel(row.startUtc, row.hostTimezone)} · {row.durationMinutes || Math.round((Date.parse(row.endUtc) - Date.parse(row.startUtc)) / 60000)} minutes</p><p className="hfb-muted">Host timezone: {row.hostTimezone}</p></div>
        {role === 'host' && typeof row.expectedHostNetPaise === 'number' && row.status === 'confirmed' && <p className="hfb-money"><strong>{money(row.expectedHostNetPaise)}</strong><span>expected on hold</span></p>}
        <a className="hfb-button" href={'/bookings/' + encodeURIComponent(row.id)}>View details</a>
      </li>)}
    </ul>}
  </main>;
}
