/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 6 — Done. Receipt download fetches
 * the PDF with the bearer token and saves it via a blob URL (the token can
 * never sit in a plain href), then revokes the object URL once used.
 *
 * [SAATHUM-EVENT-TYPES 2026-09-27] Title comes from copy.doneTitle so a
 * satsang/sermon/meditation booking doesn't say "sankalp". The round sticker
 * (booking-blessed.png, per the approved mockup) hides itself on a 404 —
 * the owner hasn't generated every sticker yet.
 */
import { useEffect, useState } from 'react';
import { fetchReceiptBlob } from './api';
import { capture, captureException } from '../../lib/analytics';
import type { Checkout } from './types';
import type { EventType, EventTypeCopy } from '../../lib/eventTypes';

function DoneSticker() {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
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
  copy,
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

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'done', listing_id: listingId, event_type: eventType });
    capture('saathum_checkout_done');
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
    <div className="sthc-card sthc-done">
      <div className="sthc-kick">Booked</div>
      <DoneSticker />
      <div className="sthc-big">{copy.doneTitle}</div>
      <p>
        {checkout.listing.title}
        <br />
        Confirmation and receipt sent to your email.
      </p>
      {err && <p className="sthc-err" role="alert">{err}</p>}
      <div className="sthc-dl">
        <span role="button" tabIndex={0} onClick={() => void downloadReceipt()} onKeyDown={(e) => { if (e.key === 'Enter') void downloadReceipt(); }}>
          {downloading ? 'Preparing…' : '⬇ Download receipt (PDF)'}
        </span>
        <a href="/dashboard">My events</a>
      </div>
      <div className="sthc-hint" style={{ marginTop: 12 }}>
        We email you the video when it finishes. {copy.ritual ? 'Prasad ships the same day.' : ''}
      </div>
    </div>
  );
}
