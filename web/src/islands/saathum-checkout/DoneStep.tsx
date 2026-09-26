/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 6 — Done. Receipt download fetches
 * the PDF with the bearer token and saves it via a blob URL (the token can
 * never sit in a plain href), then revokes the object URL once used. */
import { useEffect, useState } from 'react';
import { fetchReceiptBlob } from './api';
import { capture, captureException } from '../../lib/analytics';
import type { Checkout } from './types';

export function DoneStep({ checkout, auth, listingId }: { checkout: Checkout; auth: string; listingId: string }) {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'done', listing_id: listingId });
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
      <div className="sthc-done-icon">🙏</div>
      <div className="sthc-big">Your sankalp is booked 🙏</div>
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
        Live link arrives by email 30 min before. Prasad ships the same day.
      </div>
    </div>
  );
}
