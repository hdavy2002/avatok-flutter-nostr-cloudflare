/* [SAATHUM-UPI-3LAYER 2026-09-29] The approved payment screens, replicated
 * from Claude outputs/saathum-payment-mock.html (screens 1, 2, 4, 5; screen 3
 * is DoneStep). One screen at a time, driven by the real checkout envelope:
 *   awaiting_payment, no paid_claimed_at ......... 1 Pay
 *   awaiting_payment + paid_claimed_at, < 3:00 ... 2 Waiting for bank
 *   review_pending, or 3:00 elapsed .............. 4 Verifying manually
 *   expired + reason_code "rejected" ............. 5 Payment not found
 *   expired (otherwise) .......................... plain expired card
 *   confirmed .................................... onDone -> DoneStep (3)
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { UPI_APPS } from '../checkout/upiAppLinks';
import { upiAppHref, upiPlatform } from '../checkout/upiAppLinks';
import type { UpiPlatform } from '../checkout/upiAppLinks';
import { getCheckout, markPaid, submitUtr } from './api';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { SUPPORT_EMAIL, bookingRef, payableRupees, rupees, whenLabel } from './payFormat';
import type { Checkout } from './types';
import type { EventType } from '../../lib/eventTypes';

const POLL_WAIT_MS = 3000;
const POLL_REVIEW_MS = 20000;
const CLAIM_WINDOW_MS = 180000;
const RING = 364.4;
// Mock order: Google Pay, PhonePe, Paytm.
const APP_ORDER = ['google-pay', 'phonepe', 'paytm'];

function Dots({ n }: { n: number }) {
  return <div className="sthc-dots">{Array.from({ length: n }, (_, i) => <i key={i} className="on" />)}</div>;
}

function BookBox({ checkout, amountLabel }: { checkout: Checkout; amountLabel: string }) {
  return (
    <div className="book-box">
      <div className="sthc-row"><span>Event</span><span>{checkout.listing.title}</span></div>
      <div className="sthc-row"><span>Date &amp; time</span><span>{whenLabel(checkout.listing.starts_at)}</span></div>
      <div className="sthc-row"><span>{amountLabel}</span><span>{rupees(payableRupees(checkout))}</span></div>
      <div className="sthc-row"><span>Booking ID</span><span>{bookingRef(checkout.checkout_id)}</span></div>
    </div>
  );
}

export function PayStep({
  checkout,
  auth,
  onUpdate,
  onDone,
  onStartAgain,
  listingId,
  eventType,
  totalSteps,
}: {
  checkout: Checkout;
  auth: string;
  onUpdate: (c: Checkout) => void;
  onDone: () => void;
  onStartAgain: () => void;
  listingId: string;
  eventType: EventType;
  stepIndex: number;
  totalSteps: number;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState('');
  const [platform, setPlatform] = useState<UpiPlatform>('desktop');
  const [now, setNow] = useState(Date.now());
  const [utr, setUtr] = useState('');
  const [utrBusy, setUtrBusy] = useState(false);
  const [utrErr, setUtrErr] = useState<string | null>(null);
  const [utrSent, setUtrSent] = useState(false);
  const [paidBusy, setPaidBusy] = useState(false);
  const [paidErr, setPaidErr] = useState<string | null>(null);
  // Poll with the LATEST token — the parent refreshes it every 40s. [SAATHUM-UPI-FIX]
  const authRef = useRef(auth);
  authRef.current = auth;

  const claimedAt = checkout.paid_claimed_at ?? null;
  const dueMs = claimedAt ? claimedAt + CLAIM_WINDOW_MS : 0;
  const leftSecs = claimedAt ? Math.max(0, Math.ceil((dueMs - now) / 1000)) : 180;
  const qrSecs = Math.max(0, Math.round((checkout.payment.expires_at - now) / 1000));

  type Screen = 'pay' | 'waiting' | 'verifying' | 'notfound' | 'expired' | 'confirmed';
  let screen: Screen;
  if (checkout.status === 'confirmed') screen = 'confirmed';
  else if (checkout.status === 'expired') screen = checkout.reason_code === 'rejected' ? 'notfound' : 'expired';
  else if (checkout.status === 'review_pending') screen = 'verifying';
  else if (claimedAt) screen = leftSecs > 0 ? 'waiting' : 'verifying';
  else screen = qrSecs > 0 ? 'pay' : 'expired';

  useEffect(() => {
    capture('saathum_checkout_step', { step: 'pay', listing_id: listingId, event_type: eventType });
    capture('saathum_checkout_pay_started');
    setPlatform(upiPlatform(navigator.userAgent, navigator.maxTouchPoints));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (screen !== 'pay' && screen !== 'waiting' && screen !== 'verifying') return;
    let stopped = false;
    async function tick() {
      try {
        const c = await getCheckout(checkout.checkout_id, authRef.current);
        if (!stopped) onUpdate(c);
      } catch (e) {
        captureException(e, { where: 'saathum_checkout_poll' });
      }
    }
    const id = window.setInterval(() => void tick(), screen === 'verifying' ? POLL_REVIEW_MS : POLL_WAIT_MS);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout.checkout_id, screen]);

  const upi = checkout.upi?.uri ?? checkout.payment.upi_url;
  useEffect(() => {
    let active = true;
    setQr(null); setQrError('');
    if (upi) {
      void QRCode.toDataURL(upi, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
        .then((img) => { if (active) setQr(img); })
        .catch(() => { if (active) setQrError('QR unavailable. Use the payment app button.'); });
    }
    return () => { active = false; };
  }, [upi]);

  useEffect(() => {
    if (screen === 'confirmed') onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  async function iHavePaid() {
    setPaidErr(null);
    setPaidBusy(true);
    try {
      const c = await markPaid(checkout.checkout_id, authRef.current);
      capture('saathum_checkout_paid_claimed');
      onUpdate(c);
    } catch (e) {
      captureException(e, { where: 'saathum_checkout_paid' });
      setPaidErr('That didn’t work. Please try again.');
    } finally {
      setPaidBusy(false);
    }
  }

  async function sendUtr() {
    if (!/^\d{12}$/.test(utr)) return;
    setUtrErr(null);
    setUtrBusy(true);
    try {
      const c = await submitUtr(checkout.checkout_id, utr, checkout.payment.reference_revision, authRef.current);
      capture('saathum_checkout_utr', { ok: true });
      setUtrSent(true);
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

  const payable = rupees(payableRupees(checkout));
  const ref = bookingRef(checkout.checkout_id);
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Booking ${ref}`)}`;

  // ── 4 Verifying manually ──
  if (screen === 'verifying') {
    return (
      <div className="sthc-card sthc-done sthc-pf">
        <div className="sthc-kick">Booking request received</div>
        <div className="soft-icon">🙏</div>
        <div className="sthc-big">We&rsquo;ve got your booking request</div>
        <p>Our team will verify your payment and send your receipt and booking confirmation on WhatsApp and email, usually within a few hours.</p>
        <BookBox checkout={checkout} amountLabel="Amount paid" />
        <div className="sthc-hint" style={{ textAlign: 'left' }}>You can close this page now. If your bank message arrives late, we confirm your booking automatically.</div>
        <div className="support">
          <b>Need help?</b> Write to us anytime.<br />
          Email <a href={mailto}>{SUPPORT_EMAIL}</a><br />
          Please quote booking ID <b>{ref}</b>.
        </div>
        <a className="sthc-btn sthc-btn--ghost" href="/">Back to Saathum</a>
      </div>
    );
  }

  // ── 5 Payment not found ──
  if (screen === 'notfound') {
    return (
      <div className="sthc-card sthc-done sthc-pf">
        <div className="sthc-kick">Booking &middot; Payment check</div>
        <div className="soft-icon rose">🤍</div>
        <div className="sthc-big">We couldn&rsquo;t find your payment</div>
        <p>Sorry for the trouble. We couldn&rsquo;t match a payment of <b style={{ color: 'var(--teal)' }}>{payable}</b> to this booking, so your seat is not confirmed yet.</p>
        <p style={{ fontSize: 16 }}>If money left your account, please contact us with your UPI reference and we will sort it out quickly.</p>
        <div className="support">
          <b>We&rsquo;re here to help</b><br />
          Email <a href={mailto}>{SUPPORT_EMAIL}</a><br />
          Please quote booking ID <b>{ref}</b> and your 12-digit UPI reference.
        </div>
        <a className="sthc-btn" style={{ marginTop: 14 }} href={mailto}>Contact support</a>
        <button type="button" className="sthc-btn sthc-btn--ghost" onClick={onStartAgain}>Try booking again</button>
      </div>
    );
  }

  // ── plain expired ──
  if (screen === 'expired') {
    return (
      <div className="sthc-card sthc-done sthc-pf">
        <div className="sthc-kick">Booking &middot; Payment</div>
        <div className="soft-icon rose">🤍</div>
        <div className="sthc-big">This payment expired</div>
        <p>If you already paid, keep your receipt and contact us with your UPI reference. Otherwise, start again to get a fresh QR.</p>
        <div className="support">
          <b>We&rsquo;re here to help</b><br />
          Email <a href={mailto}>{SUPPORT_EMAIL}</a><br />
          Please quote booking ID <b>{ref}</b>.
        </div>
        <button type="button" className="sthc-btn" style={{ marginTop: 14 }} onClick={onStartAgain}>Start again &rarr;</button>
      </div>
    );
  }

  // ── 2 Waiting for bank ──
  if (screen === 'waiting') {
    return (
      <div className="sthc-card sthc-done sthc-pf">
        <div className="sthc-kick">Payment &middot; Step 2 of 2</div>
        <h3 className="sthc-h3">Waiting for bank to confirm</h3>
        <Dots n={totalSteps} />
        <div className="wait-ring">
          <svg width="132" height="132" viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="58" fill="none" stroke="#eadbc0" strokeWidth="10" />
            <circle cx="66" cy="66" r="58" fill="none" stroke="#F6B93B" strokeWidth="10" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={String(RING * (1 - leftSecs / 180))} />
          </svg>
          <div className="t">{Math.floor(leftSecs / 60)}:{String(leftSecs % 60).padStart(2, '0')}</div>
        </div>
        <p style={{ marginTop: 4 }}><b style={{ color: 'var(--teal)' }}>{payable}</b> &middot; {checkout.listing.title}</p>
        <p>Thank you! Your bank usually confirms within a minute. We&rsquo;ll update this page by itself &mdash; nothing more for you to do.</p>
        <ul className="steps-list">
          <li><span className="dot ok">&#10003;</span>You paid in your UPI app</li>
          <li><span className="dot now">2</span>Bank is confirming your payment</li>
          <li><span className="dot">3</span>Booking confirmed and receipt sent</li>
        </ul>
        <div className="sthc-hint sthc-hint--gold" style={{ textAlign: 'left' }}>Please keep this page open until it confirms. If you do close it, don&rsquo;t worry &mdash; we&rsquo;ll still send your booking on WhatsApp and email.</div>
        <details className="utr">
          <summary>Have your 12-digit UPI reference? Enter it to speed things up</summary>
          <div className="in">
            <div className="sthc-fld" style={{ marginBottom: 10 }}>
              <label htmlFor="sthc-utr">12-digit UPI reference (UTR)</label>
              <input
                id="sthc-utr"
                className="sthc-utr-in"
                inputMode="numeric"
                maxLength={12}
                placeholder="••••••••••••"
                value={utr}
                disabled={utrBusy}
                onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, 12))}
              />
            </div>
            {utrErr && <p className="sthc-err" role="alert">{utrErr}</p>}
            <button type="button" className="sthc-btn sthc-btn--ghost" style={{ marginTop: 0 }} disabled={utrBusy || utr.length !== 12} onClick={() => void sendUtr()}>
              {utrBusy ? 'Sending…' : utrSent ? 'Reference sent' : 'Send reference'}
            </button>
          </div>
        </details>
      </div>
    );
  }

  // ── 1 Pay ──
  const lines = checkout.quote.lines;
  const rounding = (checkout.rounding_discount_paise ?? 0) / 100;
  const phone = platform !== 'desktop';
  const apps = APP_ORDER.map((id) => UPI_APPS.find((a) => a.id === id)).filter((a): a is (typeof UPI_APPS)[number] => !!a);
  const payee = checkout.upi?.payee_name ?? checkout.payment.payee_name;
  const vpa = checkout.upi?.vpa ?? checkout.payment.vpa;
  const cover = checkout.listing.cover_url;
  const href = typeof window !== 'undefined' ? window.location.href : undefined;
  return (
    <div className="sthc-card sthc-qr-wrap sthc-pf">
      <div className="sthc-kick" style={{ textAlign: 'left' }}>Last step &middot; Pay</div>
      <h3 className="sthc-h3" style={{ textAlign: 'left' }}>Pay with UPI</h3>
      <Dots n={totalSteps} />

      <div className="ev-strip">
        <div className="ev-thumb">{cover ? <img src={cover} alt="" /> : '🪔'}</div>
        <div><b>{checkout.listing.title}</b><small>{whenLabel(checkout.listing.starts_at)}</small></div>
      </div>

      <div style={{ textAlign: 'left' }}>
        {lines.map((l, i) => (
          <div className="sthc-row" key={`${l.kind}-${l.id ?? i}`}>
            <span>{l.label}{l.qty > 1 && <small>&times; {l.qty}</small>}</span>
            <span>{rupees(l.amount_rupees)}</span>
          </div>
        ))}
        {checkout.quote.gst_rupees > 0 && (
          <div className="sthc-row"><span>GST ({checkout.quote.gst_rate_pct}%)</span><span>{rupees(checkout.quote.gst_rupees)}</span></div>
        )}
        {rounding > 0 && (
          <div className="sthc-row"><span>UPI rounding discount</span><span className="disc">&minus;{rupees(rounding)}</span></div>
        )}
      </div>

      <div className="amount-box">
        <div className="lbl">Amount to pay</div>
        <div className="amt">{payable}</div>
        <span className="exact">Please pay this exact amount</span>
      </div>

      {qr && <img className="qr" src={qr} alt="UPI payment QR code" />}
      {!qr && !qrError && <p role="status">Loading QR…</p>}
      {qrError && <p className="sthc-err" role="alert">{qrError}</p>}

      <div className="payee">Paying to <b>{payee}</b>{vpa && <><br />UPI ID <code>{vpa}</code></>}</div>

      {upi && phone && (
        <>
          <a className="sthc-btn sthc-btn--teal" href={upi}>Pay with UPI app &rarr;</a>
          <nav className="sthc-apps sthc-apps--pf" aria-label="Payment apps">
            {apps.map((app) => (
              <a key={app.id} href={upiAppHref(app, upi, platform, href)} aria-label={`Pay with ${app.name}`}>
                <span className="sthc-app-ic"><img src={app.icon} alt="" /></span>{app.name}
              </a>
            ))}
          </nav>
        </>
      )}
      {!phone && <span className="only-mobile-tag">Scan the QR with any UPI app on your phone</span>}

      <div className="sthc-hint sthc-hint--gold" style={{ textAlign: 'left' }}>After paying in your UPI app, come back here and tap the button below.</div>
      {paidErr && <p className="sthc-err" role="alert">{paidErr}</p>}
      <button className="sthc-btn" type="button" disabled={paidBusy} onClick={() => void iHavePaid()}>
        {paidBusy ? 'Please wait…' : <>I&rsquo;ve paid &rarr;</>}
      </button>
      <div className="sthc-countdown" style={{ marginTop: 12 }}>
        This QR is valid for {Math.floor(qrSecs / 60)}:{String(qrSecs % 60).padStart(2, '0')}
      </div>
    </div>
  );
}
