import { useEffect, useState } from 'react';
import { bookingError, cancelBooking, dateLabel, getBooking, money, type HfBooking } from '../../lib/hfBookingsApi';
import { capture } from '../../lib/analytics';
import '../../styles/hf-bookings.css';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';

export default function BookingDetails({ id }: { id: string }) {
  const feature = useBookingFeature();
  const [booking, setBooking] = useState<HfBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (feature !== 'enabled') { setLoading(feature === 'checking'); return; }
    let live = true; setLoading(true); setMessage('');
    getBooking(id).then(row => { if (live) setBooking(row); }).catch(error => { if (live) setMessage(bookingError(error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, retry, feature]);
  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  const cancel = async () => {
    setBusy(true); setMessage('');
    try { const row = await cancelBooking(id); setBooking(row); setConfirming(false); }
    catch (error) {
      const issue = bookingError(error); setMessage(issue.status === 409 ? 'This appointment changed while you were viewing it. Reload to see its current status.' : issue.message);
      capture('hf_booking_cancel_failed', { feature: 'hf_booking', booking_id: id, status: issue.status, code: issue.code });
    } finally { setBusy(false); }
  };
  const status = booking?.status || '';
  return <main className="hfb-page">
    <a className="hfb-back" href="/bookings">← All bookings</a>
    <header className="hfb-heading"><p className="hfb-eyebrow">Appointment details</p><h1>Booking</h1></header>
    {loading && <p className="hfb-card" role="status">Loading appointment…</p>}
    {!loading && !booking && <section className="hfb-card"><p role="alert">{message || 'We could not find this appointment.'}</p><button className="hfb-button" type="button" onClick={() => setRetry(n => n + 1)}>Try again</button></section>}
    {booking && <>
      <section className="hfb-card">
        <span className={'hfb-status hfb-status-' + status}>{status.replaceAll('_', ' ')}</span>
        <h2>{booking.hostName || 'Appointment'}</h2>
        <dl className="hfb-details">
          <div><dt>Your local time</dt><dd>{dateLabel(booking.startUtc)}</dd></div>
          <div><dt>Influencer local time</dt><dd>{dateLabel(booking.startUtc, booking.hostTimezone)} · {booking.hostTimezone}</dd></div>
          <div><dt>Duration</dt><dd>{booking.durationMinutes || Math.round((Date.parse(booking.endUtc) - Date.parse(booking.startUtc)) / 60000)} minutes</dd></div>
          <div><dt>Reserved</dt><dd>{money(booking.reservedPaise)}</dd></div>
          {typeof booking.expectedHostNetPaise === 'number' && <div><dt>Expected influencer earnings on hold</dt><dd>{money(booking.expectedHostNetPaise)}</dd></div>}
          {booking.callId && <div><dt>Call reference</dt><dd>{booking.callId}</dd></div>}
        </dl>
        <p className="hfb-muted">The influencer’s timezone is shown separately so you can check the appointment across timezones.</p>
        {message && <p className="hfb-message" role="alert">{message}<button className="hfb-text-button" type="button" onClick={() => setRetry(n => n + 1)}>Reload</button></p>}
        {status === 'confirmed' && <div className="hfb-actions">{!confirming ? <button type="button" className="hfb-button" onClick={() => setConfirming(true)}>Cancel appointment</button> : <div className="hfb-note" role="alertdialog" aria-labelledby="hfb-cancel-title"><h3 id="hfb-cancel-title">Cancel this appointment?</h3><p>The reservation will be released if the server confirms cancellation. The slot may be taken by someone else if you book again.</p><button type="button" className="hfb-button hfb-danger" onClick={() => void cancel()} disabled={busy}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</button><button type="button" className="hfb-button" onClick={() => setConfirming(false)} disabled={busy}>Keep appointment</button></div>}</div>}
      </section>
      <section className="hfb-card"><h2>What happens next</h2><p>Only the server can confirm changes or mark a call complete. Your status here refreshes from the booking record.</p><a className="hfb-button" href="/bookings">View all bookings</a></section>
    </>}
  </main>;
}
