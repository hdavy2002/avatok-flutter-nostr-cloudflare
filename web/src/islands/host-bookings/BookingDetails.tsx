import { hfCall, recoverAgeConfirmation } from '../../lib/hfCallsApi';
import { useEffect, useState } from 'react';
import { acceptBooking, bookingError, cancelBooking, declineBooking, dateLabel, getBooking, money, type HfBooking } from '../../lib/hfBookingsApi';
import { capture, captureException } from '../../lib/analytics';
import { signInUrl } from '../../lib/hfCallsApi';
import SessionBridge from '../calls/SessionBridge';
import '../../styles/hf-bookings.css';
import { BookingFeatureLoading, BookingUnavailable, useBookingFeature } from './BookingFeatureGate';

/** [HF-FIX-BOOKING-DETAILS-1] Never show raw API codes (no_session, ...) to people. */
function friendly(error: unknown): { text: string; signedOut: boolean } {
  const issue = bookingError(error);
  captureException(error, { feature: 'hf_booking', where: 'booking_details', code: issue.code, status: issue.status });
  if (issue.status === 401 || issue.code === 'no_session') return { text: 'Please sign in again to see this appointment.', signedOut: true };
  if (issue.status === 404 || issue.code === 'not_found') return { text: 'We could not find this appointment.', signedOut: false };
  if (issue.status === 0 || issue.code === 'network') return { text: issue.message, signedOut: false };
  return { text: 'We could not load this appointment right now. Please try again.', signedOut: false };
}

export default function BookingDetails({ id }: { id: string }) {
  const feature = useBookingFeature();
  const [booking, setBooking] = useState<HfBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retry, setRetry] = useState(0);
  const [needsAge, setNeedsAge] = useState(false);
  useEffect(() => {
    let live = true;
    void hfCall<{ age18ConfirmedAt: number | null }>('GET', '/api/hf/me').then(r => { if (live) setNeedsAge(!r.ok || !r.data.age18ConfirmedAt); });
    return () => { live = false; };
  }, [retry]);
  useEffect(() => {
    if (feature !== 'enabled') { setLoading(feature === 'checking'); return; }
    let live = true; setLoading(true); setMessage(''); setSignedOut(false);
    getBooking(id).then(row => { if (live) setBooking(row); }).catch(error => { const f = friendly(error); if (live) { setMessage(f.text); setSignedOut(f.signedOut); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, retry, feature]);
  if (feature === 'checking') return <BookingFeatureLoading />;
  if (feature === 'disabled') return <BookingUnavailable />;
  const cancel = async () => {
    setBusy(true); setMessage('');
    try { const row = await cancelBooking(id); setBooking(row); setConfirming(false); }
    catch (error) {
      const issue = bookingError(error); setMessage(issue.code === 'too_late' ? issue.message : issue.status === 409 ? 'This appointment changed while you were viewing it. Reload to see its current status.' : friendly(error).text);
      capture('hf_booking_cancel_failed', { feature: 'hf_booking', booking_id: id, status: issue.status, code: issue.code });
    } finally { setBusy(false); }
  };
  const decide = async (what: 'accept' | 'decline') => {
    setBusy(true); setMessage('');
    try { await (what === 'accept' ? acceptBooking(id) : declineBooking(id)); setBooking(await getBooking(id)); }
    catch (error) { const issue = bookingError(error); setMessage(issue.status === 409 ? (issue.message !== issue.code ? issue.message : 'This request was already decided or has expired.') : friendly(error).text); }
    finally { setBusy(false); }
  };
  const status = booking?.status || '';
  const isHost = typeof booking?.expectedHostNetPaise === 'number'; // the server only sends this to the influencer
  return <main className="hfb-page">
    <SessionBridge on />
    <a className="hfb-back" href="/dashboard/appointments">← All bookings</a>
    <header className="hfb-heading"><p className="hfb-eyebrow">Appointment details</p><h1>Booking</h1></header>
    {loading && <p className="hfb-card" role="status">Loading appointment…</p>}
    {!loading && !booking && <section className="hfb-card"><p role="alert">{message || 'We could not find this appointment.'}</p>{signedOut ? <a className="hfb-button" href={signInUrl(location.pathname + location.search)}>Sign in</a> : <button className="hfb-button" type="button" onClick={() => setRetry(n => n + 1)}>Try again</button>}</section>}
    {booking && <>
      {needsAge && !['completed', 'cancelled'].includes(status) && <section className="hfb-card"><p>Please confirm that you are 18 or older before this appointment can start.</p><button type="button" className="hfb-button" disabled={busy} onClick={async () => { setBusy(true); setMessage(await recoverAgeConfirmation()); setBusy(false); setRetry(n => n + 1); }}>Confirm 18+</button></section>}
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
        {status === 'pending_approval' && isHost && <div className="hfb-note"><h3>Waiting for your answer</h3><p>Accept to confirm this time, or decline and the caller gets the full amount back in their wallet. If you do nothing it is cancelled and refunded within 24 hours.</p><div className="hfb-actions"><button type="button" className="hfb-button hfb-primary" onClick={() => void decide('accept')} disabled={busy}>{busy ? 'Please wait…' : 'Accept'}</button><button type="button" className="hfb-button" onClick={() => void decide('decline')} disabled={busy}>Decline</button></div></div>}
        {(status === 'confirmed' || (status === 'pending_approval' && !isHost)) && <div className="hfb-actions">{!confirming ? <button type="button" className="hfb-button" onClick={() => setConfirming(true)}>Cancel appointment</button> : <div className="hfb-note" role="alertdialog" aria-labelledby="hfb-cancel-title"><h3 id="hfb-cancel-title">Cancel this appointment?</h3><p>The reservation will be released if the server confirms cancellation. The slot may be taken by someone else if you book again.</p><button type="button" className="hfb-button hfb-danger" onClick={() => void cancel()} disabled={busy}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</button><button type="button" className="hfb-button" onClick={() => setConfirming(false)} disabled={busy}>Keep appointment</button></div>}</div>}
      </section>
      <section className="hfb-card"><h2>What happens next</h2><p>Only the server can confirm changes or mark a call complete. Your status here refreshes from the booking record.</p><a className="hfb-button" href="/dashboard/appointments">View all bookings</a></section>
    </>}
  </main>;
}
