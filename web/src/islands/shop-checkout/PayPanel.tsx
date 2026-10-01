/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Step 4 — Pay with UPI. The state machine is the event checkout's PayStep
 * (islands/saathum-checkout/PayStep.tsx), against the shop order envelope (same semantics, spec §4.2):
 *   awaiting_payment, not claimed ............ pay        (mockup step 4)
 *   awaiting_payment + paid_claimed_at < 3:00  waiting    (mockup "Waiting for bank to confirm")
 *   review_pending, or 3:00 elapsed .......... verifying
 *   expired + reason_code "rejected" ......... notfound
 *   expired (otherwise) ...................... expired
 *   confirmed ................................ onDone -> Done
 * Visuals of pay + waiting are the mockup's; verifying / notfound / expired are not mocked, so they reuse the
 * same panel classes with the event checkout's wording. Polling: 3 s while paying/waiting, 20 s while verifying. */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { capture, captureException } from '../../lib/analytics';
import { ApiError } from '../../lib/apiClient';
import { BRAND } from '../../lib/brand';
import { getOrder, markPaid, submitUtr } from './api';
import { StepsBar, inrPaise } from './parts';
import type { ShopOrder } from './types';

const POLL_WAIT_MS = 3000;
const POLL_REVIEW_MS = 20000;
const CLAIM_WINDOW_MS = 180000;
// [SAATHUM-PAY-QR-ONLY-1 2026-09-29, owner decision — same as events] No "open UPI app" buttons: UPI apps refuse
// unsigned payment links opened from a website, so the customer scans the QR or types the UPI ID + exact amount.

const SUPPORT = BRAND.emails.support;

export function PayPanel({
  order, auth, onUpdate, onDone, onStartAgain,
}: {
  order: ShopOrder;
  auth: string;
  onUpdate: (o: ShopOrder) => void;
  onDone: () => void;
  onStartAgain: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [utr, setUtr] = useState('');
  const [utrBusy, setUtrBusy] = useState(false);
  const [utrErr, setUtrErr] = useState<string | null>(null);
  const [utrSent, setUtrSent] = useState(false);
  const [paidBusy, setPaidBusy] = useState(false);
  const [paidErr, setPaidErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const authRef = useRef(auth); // poll with the LATEST token — the parent refreshes it every 40 s
  authRef.current = auth;

  const claimedAt = order.paid_claimed_at ?? null;
  const dueMs = claimedAt ? claimedAt + CLAIM_WINDOW_MS : 0;
  const leftSecs = claimedAt ? Math.max(0, Math.ceil((dueMs - now) / 1000)) : 180;
  const qrSecs = Math.max(0, Math.round((order.payment.expires_at - now) / 1000));

  type Screen = 'pay' | 'waiting' | 'verifying' | 'notfound' | 'expired' | 'confirmed';
  let screen: Screen;
  if (order.status === 'confirmed') screen = 'confirmed';
  else if (order.status === 'expired') screen = order.reason_code === 'rejected' ? 'notfound' : 'expired';
  else if (order.status === 'review_pending') screen = 'verifying';
  else if (claimedAt) screen = leftSecs > 0 ? 'waiting' : 'verifying';
  else screen = qrSecs > 0 ? 'pay' : 'expired';

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (screen !== 'pay' && screen !== 'waiting' && screen !== 'verifying') return;
    let stopped = false;
    async function tick() {
      try {
        const o = await getOrder(order.order_id, authRef.current);
        if (!stopped) onUpdate(o);
      } catch (e) {
        captureException(e, { where: 'shop_checkout_poll' });
      }
    }
    const id = window.setInterval(() => void tick(), screen === 'verifying' ? POLL_REVIEW_MS : POLL_WAIT_MS);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.order_id, screen]);

  const upi = order.upi?.uri ?? order.payment.upi_url;
  useEffect(() => {
    let active = true;
    setQr(null); setQrError('');
    if (upi) {
      void QRCode.toDataURL(upi, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
        .then((img: string) => { if (active) setQr(img); })
        .catch((e: unknown) => {
          captureException(e, { where: 'shop_checkout_qr' });
          if (active) setQrError('QR unavailable. Pay to the UPI ID below and type the exact amount.');
        });
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
      const o = await markPaid(order.order_id, authRef.current);
      capture('shop_pay_paid_claimed', { order_id: order.order_id });
      onUpdate(o);
    } catch (e) {
      captureException(e, { where: 'shop_checkout_paid', order_id: order.order_id });
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
      const o = await submitUtr(order.order_id, utr, order.payment.reference_revision, authRef.current);
      capture('shop_pay_utr', { order_id: order.order_id, ok: true });
      setUtrSent(true);
      onUpdate(o);
    } catch (e) {
      capture('shop_pay_utr', { order_id: order.order_id, ok: false });
      captureException(e, { where: 'shop_checkout_utr', order_id: order.order_id });
      const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { message?: string }) : null;
      setUtrErr(body?.message || 'That didn’t work. Please try again.');
    } finally {
      setUtrBusy(false);
    }
  }

  const payPaise = typeof order.pay_amount_paise === 'number' ? order.pay_amount_paise : Math.round(order.payment.amount_rupees * 100);
  const payable = inrPaise(payPaise);
  const mailto = `mailto:${SUPPORT}?subject=${encodeURIComponent(`Order ${order.order_no}`)}`;
  const vpa = order.upi?.vpa ?? order.payment.vpa;
  const rounding = order.rounding_discount_paise ?? 0;

  /* ── not mocked: verifying / notfound / expired, in the mockup's panel language ── */
  if (screen === 'verifying') {
    return (
      <>
        <StepsBar step={45} />
        <div className="sh-panel sh-done">
          <p className="sh-eyebrow">Order received</p>
          <h2>We’ve got your order</h2>
          <p>Our team will verify your payment and send your receipt and order confirmation on WhatsApp and email, usually within a few hours. If your bank message arrives late, we confirm your order automatically.</p>
          <p>Order <b>{order.order_no}</b> · {payable}</p>
          <p>Need help? Email <a className="sh-link" href={mailto}>{SUPPORT}</a> and quote order <b>{order.order_no}</b>.</p>
          <a className="sh-btn sh-btn--ghost" href="/shop">Keep shopping</a>
        </div>
      </>
    );
  }
  if (screen === 'notfound') {
    return (
      <>
        <StepsBar step={4} />
        <div className="sh-panel sh-done">
          <p className="sh-eyebrow">Payment check</p>
          <h2>We couldn’t find your payment</h2>
          <p>Sorry for the trouble. We couldn’t match a payment of <b>{payable}</b> to order <b>{order.order_no}</b>, so it is not confirmed yet. If money left your account, please contact us with your 12-digit UPI reference and we will sort it out quickly.</p>
          <p>Email <a className="sh-link" href={mailto}>{SUPPORT}</a> and quote order <b>{order.order_no}</b>.</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a className="sh-btn sh-btn--red" href={mailto}>Contact support</a>
            <button type="button" className="sh-btn sh-btn--ghost" onClick={onStartAgain}>Try ordering again</button>
          </div>
        </div>
      </>
    );
  }
  if (screen === 'expired') {
    return (
      <>
        <StepsBar step={4} />
        <div className="sh-panel sh-done">
          <p className="sh-eyebrow">Payment</p>
          <h2>This payment expired</h2>
          <p>If you already paid, keep your receipt and contact us with your UPI reference. Otherwise, start again to get a fresh QR.</p>
          <p>Email <a className="sh-link" href={mailto}>{SUPPORT}</a> and quote order <b>{order.order_no}</b>.</p>
          <button type="button" className="sh-btn sh-btn--red" onClick={onStartAgain}>Start again →</button>
        </div>
      </>
    );
  }

  /* ── mockup "Waiting for bank to confirm" ── */
  if (screen === 'waiting') {
    return (
      <>
        <StepsBar step={45} />
        <div className="sh-panel">
          <p className="sh-eyebrow">Payment · Step 2 of 2</p>
          <h2>Waiting for bank to confirm</h2>
          <p>Your bank usually confirms within a minute. This page updates by itself.</p>
          <div className="sh-wait">
            <div className="ok"><i>✓</i>You paid in your UPI app</div>
            <div className="spin"><i>…</i>Bank is confirming your payment</div>
            <div><i></i>Order confirmed and receipt sent</div>
          </div>
          <p style={{ font: '800 14px Nunito', color: '#5a1f14', margin: '14px 0 6px' }}>Have your 12-digit UPI reference? Enter it to speed things up</p>
          <div className="sh-utr">
            <input
              placeholder="12-digit UTR" maxLength={12} inputMode="numeric" value={utr} disabled={utrBusy}
              aria-label="12-digit UPI reference (UTR)"
              onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, 12))}
            />
            <button type="button" className="sh-btn sh-btn--teal" style={{ minHeight: 46 }} disabled={utrBusy || utr.length !== 12} onClick={() => void sendUtr()}>
              {utrBusy ? 'Sending…' : utrSent ? 'Sent' : 'Submit'}
            </button>
          </div>
          {utrErr && <p className="sh-err" role="alert">{utrErr}</p>}
        </div>
      </>
    );
  }

  /* ── mockup step 4: Pay with UPI ── */
  return (
    <>
      <StepsBar step={4} />
      <div className="sh-panel">
        <p className="sh-eyebrow">Last step · Pay</p>
        <h2>Pay with UPI</h2>
        <p>Same as event bookings — scan the QR or pay to the UPI ID. No card, no app redirect.</p>
        <div className="sh-pay">
          <div className="sh-qr">
            {qr && <img src={qr} alt="UPI payment QR code" />}
            {!qr && !qrError && <p role="status" style={{ margin: 0 }}>Loading QR…</p>}
            {qrError && <p className="sh-err" role="alert">{qrError}</p>}
            <small>Scan with any UPI app</small>
            {qr && (
              <a className="sh-link" style={{ fontSize: 14 }} href={qr} download={`pay-${order.order_no}.png`}
                onClick={() => capture('shop_pay_qr_saved', { order_id: order.order_id })}>Save QR</a>
            )}
          </div>
          <div>
            <div className="sh-amt">
              <small>Please pay this exact amount</small>
              <b>{payable}</b>
              {rounding > 0 && <em>UPI rounding discount −{inrPaise(rounding)} (helps us match your payment)</em>}
            </div>
            <div className="sh-upi">
              <span>UPI ID <b>{vpa}</b></span>
              {vpa && (
                <button type="button" className="sh-link" style={{ fontSize: 14 }}
                  onClick={() => {
                    capture('shop_pay_copy_upi', { order_id: order.order_id });
                    void navigator.clipboard?.writeText(vpa).then(
                      () => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); },
                      (e) => captureException(e, { where: 'shop_pay_copy' }),
                    );
                  }}>{copied ? 'Copied' : 'Copy'}</button>
              )}
            </div>
            <ol className="sh-how">
              <li>Open GPay, PhonePe, Paytm or BHIM</li>
              <li>Scan the QR or pay to the UPI ID</li>
              <li>Pay exactly <b>{payable}</b>, then tap the button below</li>
            </ol>
            {paidErr && <p className="sh-err" role="alert">{paidErr}</p>}
            <button type="button" className="sh-btn sh-btn--red sh-btn--wide" disabled={paidBusy} onClick={() => void iHavePaid()}>
              {paidBusy ? 'Please wait…' : 'I’ve paid →'}
            </button>
            <p style={{ font: '700 13px Nunito', color: '#7a6a55', margin: '10px 0 0' }}>This QR is held for 30 minutes.</p>
          </div>
        </div>
      </div>
    </>
  );
}
