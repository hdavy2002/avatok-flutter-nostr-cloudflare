/* [AUMFE-CONSULT-F2-1 2026-10-02] UPI pay panel for a held booking — modelled on islands/shop-checkout/PayPanel.tsx.
 * QR (server qr_svg, else rendered from upi_uri) + UPI ID + the exact amount, "I've paid", optional 12-digit UTR,
 * hold countdown, polling (3 s paying/waiting, 20 s verifying). No "open UPI app" buttons (UPI apps refuse unsigned
 * links from a website — same owner decision as events and the shop). The wizard decides what to do when the booking
 * turns `confirmed` (Done page) or `expired` / `cancelled`. */
import { useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { BRAND } from '../../lib/brand';
import { cancelBooking, consultMessage, getBooking, markPaid } from '../../lib/consultApi';
import type { PayInfo } from '../../lib/consultApi';
import type { BookingDTO } from '../../lib/consultTypes';
import { inr } from '../../lib/shopUi';
import { mmss } from './bookLogic';

const CLAIM_WINDOW_MS = 180_000;

export function UpiPanel({ booking, pay, getAuth, onBooking, onRestart }: {
  booking: BookingDTO; pay: PayInfo; getAuth: () => Promise<string>;
  onBooking: (b: BookingDTO) => void; onRestart: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrErr, setQrErr] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [utr, setUtr] = useState('');
  const [claimedAt, setClaimedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bookingRef = useRef(booking);
  bookingRef.current = booking;

  const dead = booking.status === 'expired' || booking.status === 'cancelled';
  const verifying = booking.status === 'awaiting_review' || (claimedAt != null && now - claimedAt > CLAIM_WINDOW_MS);
  const waiting = !verifying && claimedAt != null;
  const expiresAt = booking.expires_at ?? pay.expires_at;
  const left = Math.max(0, expiresAt - now);
  const screen: 'pay' | 'waiting' | 'verifying' | 'expired' = dead || (!verifying && !waiting && left <= 0) ? 'expired' : verifying ? 'verifying' : waiting ? 'waiting' : 'pay';

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  useEffect(() => {
    let live = true;
    setQr(null); setQrErr(false);
    if (pay.qr_svg) { setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pay.qr_svg)}`); return () => { live = false; }; }
    import('qrcode')
      .then((m) => m.default.toDataURL(pay.upi_uri, { width: 480, margin: 1, errorCorrectionLevel: 'M' }))
      .then((img) => { if (live) setQr(img); })
      .catch((e) => { captureException(e, { where: 'consult_pay_qr' }); if (live) setQrErr(true); });
    return () => { live = false; };
  }, [pay.qr_svg, pay.upi_uri]);

  useEffect(() => {
    if (screen === 'expired') return;
    let live = true;
    const tick = async () => {
      try {
        const r = await getBooking(bookingRef.current.id, await getAuth());
        if (live) onBooking(r.booking);
      } catch (e) { captureException(e, { where: 'consult_pay_poll' }); }
    };
    const id = window.setInterval(() => void tick(), screen === 'verifying' ? 20_000 : 3_000);
    return () => { live = false; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, booking.id]);

  async function iHavePaid() {
    setErr(null); setBusy(true);
    try {
      await markPaid(booking.id, /^\d{12}$/.test(utr) ? utr : undefined, await getAuth());
      capture('consult_pay_paid_claimed', { method: 'upi', utr: /^\d{12}$/.test(utr) });
      setClaimedAt(Date.now());
      const r = await getBooking(booking.id, await getAuth());
      onBooking(r.booking);
    } catch (e) {
      captureException(e, { where: 'consult_pay_paid', booking_id: booking.id });
      setErr(consultMessage(e, 'That didn’t work. Please try again.'));
    } finally { setBusy(false); }
  }
  async function sendUtr() {
    if (!/^\d{12}$/.test(utr)) return;
    setErr(null); setBusy(true);
    try { await markPaid(booking.id, utr, await getAuth()); capture('consult_pay_utr', { ok: true }); }
    catch (e) { capture('consult_pay_utr', { ok: false }); captureException(e, { where: 'consult_pay_utr' }); setErr(consultMessage(e, 'That didn’t work. Please try again.')); }
    finally { setBusy(false); }
  }
  async function cancelAndRestart() {
    setBusy(true);
    try { await cancelBooking(booking.id, await getAuth()); } catch (e) { captureException(e, { where: 'consult_pay_cancel' }); }
    setBusy(false);
    onRestart();
  }

  const amount = inr(pay.amount_paise / 100);
  const mailto = `mailto:${BRAND.emails.support}?subject=${encodeURIComponent(`Booking ${booking.ref}`)}`;

  if (screen === 'expired') {
    return (
      <div className="cb-pay">
        <h2>This booking expired</h2>
        <p>If you already paid, keep your receipt and write to <a href={mailto}>{BRAND.emails.support}</a> quoting <b>{booking.ref}</b>. Otherwise start again to pick a time.</p>
        <button type="button" className="btn red" onClick={onRestart}>Start again</button>
      </div>
    );
  }
  if (screen === 'verifying') {
    return (
      <div className="cb-pay">
        <h2>We&rsquo;ve got your payment</h2>
        <p>We&rsquo;re matching it with your bank. You&rsquo;ll get a WhatsApp and email confirmation as soon as it matches, usually within a few hours. This page updates by itself.</p>
        <p className="hint">Booking <b>{booking.ref}</b> · {amount}. Questions? <a href={mailto}>{BRAND.emails.support}</a></p>
      </div>
    );
  }
  if (screen === 'waiting') {
    return (
      <div className="cb-pay">
        <h2>Waiting for the bank to confirm</h2>
        <p>Your bank usually confirms within a minute. This page updates by itself.</p>
        <div className="cb-wait">
          <div className="ok"><i>✓</i>You paid in your UPI app</div>
          <div><i>…</i>Bank is confirming your payment</div>
          <div><i /> Booking confirmed and receipt sent</div>
        </div>
        <p className="label">Have your 12-digit UPI reference? Enter it to speed things up</p>
        <div className="cb-utr">
          <input className="cb-input" placeholder="12-digit UTR" maxLength={12} inputMode="numeric" value={utr} disabled={busy} aria-label="12-digit UPI reference (UTR)" onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, 12))} />
          <button type="button" className="btn small" disabled={busy || utr.length !== 12} onClick={() => void sendUtr()}>Submit</button>
        </div>
        {err && <p className="cb-err" role="alert">{err}</p>}
      </div>
    );
  }
  return (
    <div className="cb-pay">
      <div>
        <h2>Pay with UPI</h2>
        <p className="muted" style={{ marginTop: 6 }}>Scan the QR or pay to the UPI ID. No card, no app redirect.</p>
      </div>
      <div className="cb-qr">
        {qr && <img src={qr} alt="UPI payment QR code" />}
        {!qr && !qrErr && <p role="status">Loading QR…</p>}
        {qrErr && <p className="cb-err" role="alert">QR unavailable. Pay to the UPI ID below and type the exact amount.</p>}
        <span className="hint">Scan with any UPI app</span>
      </div>
      <div className="cb-amt"><span className="hint">Please pay this exact amount</span><b>{amount}</b></div>
      <div className="cb-upi">
        <span>UPI ID <b>{pay.payee_vpa}</b></span>
        <button type="button" className="edit" onClick={() => {
          capture('consult_pay_copy_upi');
          void navigator.clipboard?.writeText(pay.payee_vpa).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }, (e) => captureException(e, { where: 'consult_pay_copy' }));
        }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <ol className="cb-how">
        <li>Open GPay, PhonePe, Paytm or BHIM</li>
        <li>Scan the QR or pay to the UPI ID</li>
        <li>Pay exactly <b>{amount}</b>, then tap the button below</li>
      </ol>
      <div className="field" style={{ width: '100%', textAlign: 'left' }}>
        <label htmlFor="utr">12-digit UPI reference (optional)</label>
        <input id="utr" className="cb-input" inputMode="numeric" maxLength={12} placeholder="Helps us match your payment faster" value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, 12))} />
      </div>
      {err && <p className="cb-err" role="alert">{err}</p>}
      <button type="button" className="btn red block" disabled={busy} onClick={() => void iHavePaid()}>{busy ? 'Please wait…' : 'I’ve paid'}</button>
      <p className="hint" role="timer">Your slot is held for <b>{mmss(left)}</b>.</p>
      <button type="button" className="edit" disabled={busy} onClick={() => void cancelAndRestart()}>Cancel and choose another time</button>
    </div>
  );
}
