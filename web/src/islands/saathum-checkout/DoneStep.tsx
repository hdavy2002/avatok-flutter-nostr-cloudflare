/* [SAATHUM-UPI-3LAYER 2026-09-29] Screen 3 "Payment received", replicated from
 * the approved mock. Receipt download fetches the PDF with the bearer token and
 * saves it via a blob URL (the token can never sit in a plain href).
 *
 * The old auto-redirect to the listing when the event is live is replaced (as
 * approved) by a "Watch now" button shown while getLiveState says 'live'. The
 * button goes to /book/<listing> — the watch page (LiveOverlay renders the
 * player there for entitled buyers).
 */
import { useEffect, useState } from 'react';
import { fetchReceiptBlob, getLiveState } from './api';
import { capture, captureException } from '../../lib/analytics';
import { bookingRef, payableRupees, rupees, whenLabel } from './payFormat';
import type { Checkout } from './types';
import type { EventType, EventTypeCopy } from '../../lib/eventTypes';

function DoneSticker() {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="tick">&#10003;</div>;
  return (
    <img
      className="sthc-done-sticker"
      src="/assets/saathum-booking-stickers/booking-blessed.png"
      alt=""
      onError={() => setBroken(true)}
    />
  );
}

export function DoneStep({
  checkout,
  auth,
  listingId,
  eventType,
}: {
  checkout: Checkout;
  auth: string;
  listingId: string;
  copy: EventTypeCopy;
  eventType: EventType;
}) {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'done', listing_id: listingId, event_type: eventType });
    capture('saathum_checkout_done');
    let active = true;
    const check = () => getLiveState(listingId)
      .then((ls) => { if (active) setLive(ls.state === 'live'); })
      .catch((e) => captureException(e, { where: 'saathum_checkout_done_live_check' }));
    void check();
    const id = window.setInterval(() => void check(), 30000);
    return () => { active = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadReceipt() {
    setErr(null);
    setDownloading(true);
    try {
      const blob = await fetchReceiptBlob(checkout.checkout_id, auth);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `saathum-receipt-${checkout.checkout_id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      capture('saathum_checkout_receipt_download');
    } catch (e) {
      captureException(e, { where: 'saathum_checkout_receipt' });
      setErr('The receipt isn’t ready yet. Please try again in a moment.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="sthc-card sthc-done sthc-pf">
      <div className="sthc-kick">Booked</div>
      <DoneSticker />
      <div className="sthc-big">Payment received</div>
      <p>Thank you. Your seat is booked. May the puja bring peace to your family.</p>

      <div className="book-box">
        <div className="sthc-row"><span>Event</span><span>{checkout.listing.title}</span></div>
        <div className="sthc-row"><span>Date &amp; time</span><span>{whenLabel(checkout.listing.starts_at)}</span></div>
        <div className="sthc-row"><span>Paid</span><span>{rupees(payableRupees(checkout))}</span></div>
        <div className="sthc-row"><span>Booking ID</span><span>{bookingRef(checkout.checkout_id)}</span></div>
      </div>

      {live && (
        <div style={{ margin: '12px 0' }}>
          <span className="live-pill"><i></i>The puja is live now</span>
          <a className="sthc-btn sthc-btn--teal" style={{ marginTop: 12 }} href={`/book/${encodeURIComponent(listingId)}`}>&#9654; Watch now</a>
        </div>
      )}

      {err && <p className="sthc-err" role="alert">{err}</p>}
      <button className="sthc-btn sthc-btn--ghost sthc-btn--teal" style={{ marginTop: 8, color: '#fff' }} type="button" disabled={downloading} onClick={() => void downloadReceipt()}>
        {downloading ? 'Preparing…' : <>&#11015; Download receipt (PDF)</>}
      </button>

      <div className="sthc-hint" style={{ textAlign: 'left', marginTop: 14 }}>Receipt and booking also sent on WhatsApp and email.</div>
      <p style={{ fontSize: 16 }}>See it anytime in your dashboard &mdash; sign in with WhatsApp or email.</p>
      <a className="sthc-btn sthc-btn--ghost" href="/dashboard/my-events">Go to my events</a>
    </div>
  );
}
