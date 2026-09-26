/* [SAATHUM-CHECKOUT-UI 2026-09-26] Step 5 — Pay: UPI QR for the exact total,
 * UPI app deep links (reusing checkout/upiAppLinks.ts, the same catalogue and
 * intent:// / custom-scheme building UpiPlainQr.tsx uses), a 12-digit UTR
 * entry, and polling of GET /checkout/:id every 3-5s while awaiting_payment.
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { UPI_APPS, upiAppHref, upiPlatform } from '../checkout/upiAppLinks';
import type { UpiPlatform } from '../checkout/upiAppLinks';
import { getCheckout, submitUtr } from './api';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import type { Checkout } from './types';

const POLL_MS = 4000;

export function PayStep({
  checkout,
  auth,
  onUpdate,
  onDone,
  onStartAgain,
  listingId,
}: {
  checkout: Checkout;
  auth: string;
  onUpdate: (c: Checkout) => void;
  onDone: () => void;
  onStartAgain: () => void;
  listingId: string;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState('');
  const [platform, setPlatform] = useState<UpiPlatform>('desktop');
  const [now, setNow] = useState(Date.now());
  const [utr, setUtr] = useState('');
  const [utrBusy, setUtrBusy] = useState(false);
  const [utrErr, setUtrErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'pay', listing_id: listingId });
    capture('saathum_checkout_pay_started');
    setPlatform(upiPlatform(navigator.userAgent, navigator.maxTouchPoints));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (checkout.status !== 'awaiting_payment') return;
    let stopped = false;
    async function tick() {
      try {
        const c = await getCheckout(checkout.checkout_id, auth);
        if (!stopped) onUpdate(c);
      } catch (e) {
        captureException(e, { where: 'saathum_checkout_poll' });
      }
    }
    pollRef.current = window.setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout.checkout_id, checkout.status]);

  const upi = checkout.payment.upi_url;
  useEffect(() => {
    let active = true;
    setQr(null); setQrError('');
    if (upi) {
      void QRCode.toDataURL(upi, { width: 300, margin: 3, errorCorrectionLevel: 'M' })
        .then((img) => { if (active) setQr(img); })
        .catch(() => { if (active) setQrError('QR unavailable. Use a payment app button below.'); });
    }
    return () => { active = false; };
  }, [upi]);

  useEffect(() => {
    if (checkout.status === 'confirmed') onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout.status]);

  async function submit() {
    if (!/^\d{12}$/.test(utr)) return;
    setUtrErr(null);
    setUtrBusy(true);
    try {
      const c = await submitUtr(checkout.checkout_id, utr, checkout.payment.reference_revision, auth);
      capture('saathum_checkout_utr', { ok: true });
      onUpdate(c);
    } catch (e) {
      capture('saathum_checkout_utr', { ok: false });
      captureException(e, { where: 'saathum_checkout_utr' });
      const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { message?: string }) : null;
      setUtrErr(body?.message || 'That didn’t work. Please try again.');
    } finally {
      setUtrBusy(false);
    }
  }

  const secsLeft = Math.max(0, Math.round((checkout.payment.expires_at - now) / 1000));
  const expired = checkout.status === 'expired' || (checkout.status === 'awaiting_payment' && secsLeft <= 0);
  const reviewPending = checkout.status === 'review_pending';

  if (reviewPending) {
    return (
      <div className="sthc-card">
        <div className="sthc-kick">Step 5 of 5 · Pay</div>
        <h3 className="sthc-h3">Checking your payment</h3>
        <div className="sthc-dots"><i className="on" /><i className="on" /><i className="on" /><i className="on" /><i className="on" /></div>
        <div className="sthc-hint sthc-hint--gold">
          We&rsquo;re checking your payment with the bank &mdash; we&rsquo;ll email you.
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="sthc-card">
        <div className="sthc-kick">Step 5 of 5 · Pay</div>
        <h3 className="sthc-h3">This payment expired</h3>
        <div className="sthc-dots"><i className="on" /><i className="on" /><i className="on" /><i className="on" /><i className="on" /></div>
        <p style={{ font: '700 14px/1.5 Nunito, sans-serif', color: 'var(--body)' }}>
          If you already paid, keep your receipt and contact us with your UTR. Otherwise, start again to get a fresh QR.
        </p>
        <button className="sthc-btn" onClick={onStartAgain}>Start again →</button>
      </div>
    );
  }

  return (
    <div className="sthc-card sthc-qr-wrap">
      <div className="sthc-kick" style={{ textAlign: 'left' }}>Step 5 of 5 · Pay</div>
      <h3 className="sthc-h3" style={{ textAlign: 'left' }}>Scan &amp; pay ₹{checkout.payment.amount_rupees.toLocaleString('en-IN')}</h3>
      <div className="sthc-dots"><i className="on" /><i className="on" /><i className="on" /><i className="on" /><i className="on" /></div>

      {qr && <img src={qr} alt="UPI payment QR code" />}
      {!qr && !qrError && <p role="status">Loading QR…</p>}
      {qrError && <p className="sthc-err" role="alert">{qrError}</p>}

      {upi && (
        <nav className="sthc-apps" aria-label="Payment apps">
          {UPI_APPS.map((app) => (
            <a key={app.id} href={upiAppHref(app, upi, platform, typeof window !== 'undefined' ? window.location.href : undefined)} aria-label={`Pay with ${app.name}`}>
              <img src={app.icon} alt="" /> {app.name}
            </a>
          ))}
        </nav>
      )}

      <div className="sthc-countdown">
        {secsLeft > 0 ? `QR expires in ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}` : 'Checking…'}
      </div>

      <div className="sthc-fld" style={{ textAlign: 'left' }}>
        <label htmlFor="sthc-utr">12-digit UPI transaction number (UTR)</label>
        <input
          id="sthc-utr"
          className="sthc-utr-in"
          inputMode="numeric"
          maxLength={12}
          value={utr}
          disabled={utrBusy}
          onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
      </div>
      {utrErr && <p className="sthc-err" role="alert">{utrErr}</p>}
      <div className="sthc-hint sthc-hint--gold">
        Find it in your UPI app under the payment&rsquo;s details. We check it with our bank.
      </div>
      <button className="sthc-btn" disabled={utrBusy || utr.length !== 12} onClick={() => void submit()}>
        {utrBusy ? 'Verifying…' : 'Verify payment →'}
      </button>
    </div>
  );
}
