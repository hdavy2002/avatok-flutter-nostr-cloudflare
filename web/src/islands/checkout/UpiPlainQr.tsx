import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { API_BASE } from '../../lib/config';
import { UPI_APPS, upiAppHref, upiPlatform } from './upiAppLinks';
import type { UpiPlatform } from './upiAppLinks';
import { paymentAmount, UpiPublicController } from './upiPublicController';
import type { PublicPaymentState } from './upiPublicController';

export default function UpiPlainQr() {
  const controller = useRef<UpiPublicController | null>(null);
  const [state, setState] = useState<PublicPaymentState>({intent: null, enabled: false, busy: true, error: ''});
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState('');
  const [platform, setPlatform] = useState<UpiPlatform>('desktop');
  const [now, setNow] = useState(Date.now);
  const [showRecovery, setShowRecovery] = useState(false);
  const [reference, setReference] = useState('');
  const intent = state.intent;
  const confirmed = intent?.status === 'confirmed';
  const expired = Boolean(intent && (intent.status === 'expired' || intent.expires_at <= now));
  const recoverable = Boolean(intent && !confirmed && intent.recover_until > now);
  const payable = Boolean(state.enabled && !state.error && intent?.status === 'pending' && !expired
    && intent.reference_revision === 0 && intent.upi_url);
  const upi = payable ? intent!.upi_url! : null;
  const amount = intent ? paymentAmount(intent.amount_paise) : '';

  useEffect(() => {
    setPlatform(upiPlatform(navigator.userAgent, navigator.maxTouchPoints));
    window.history.replaceState(null, '', window.location.pathname);
    const current = new UpiPublicController(API_BASE, setState);
    controller.current = current;
    const refresh = () => { setNow(Date.now()); void current.refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    void current.start();
    return () => {
      current.stop();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    if (intent?.reason_code === 'reference_required') setShowRecovery(true);
  }, [intent?.reason_code]);
  useEffect(() => {
    setNow(Date.now());
    if (!intent || confirmed) return;
    const deadline = intent.expires_at > Date.now() ? intent.expires_at : intent.recover_until;
    if (deadline <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(deadline - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [intent?.expires_at, intent?.recover_until, confirmed, expired]);
  useEffect(() => {
    let active = true;
    setQr(null); setQrError('');
    if (upi) void QRCode.toDataURL(upi, {width: 320, margin: 4, errorCorrectionLevel: 'M'})
      .then(image => { if (active) setQr(image); })
      .catch(() => { if (active) setQrError('QR unavailable. Choose a payment app below.'); });
    return () => { active = false; };
  }, [upi]);

  if (confirmed && intent) return <section style={sectionStyle} aria-live="polite">
    <h1 style={{fontSize: 28}}>Payment received</h1>
    <p>We have received your payment.</p>
    <p style={{fontSize: 24, fontWeight: 700}}>{amount}</p>
    <p>Payment reference</p>
    <p style={{overflowWrap: 'anywhere'}}>{intent.intent_id}</p>
  </section>;

  return <section style={sectionStyle}>
    <h1 style={{fontSize: 28}}>{payable ? 'Scan to pay ' + amount : intent ? 'Waiting for payment confirmation' : 'Preparing your payment'}</h1>
    {intent && <p role="status" aria-live="polite">
      {!recoverable ? 'The payment recovery window has ended. Keep your receipt for support. Do not pay again.'
        : expired ? 'The QR expired. If you already paid, we will keep checking this payment. Do not pay again.'
        : intent.status === 'review_pending' ? 'Your payment needs review. Keep your receipt and do not pay again.'
        : intent.reference_revision > 0 ? 'Checking your payment receipt. Do not pay again.'
        : 'Waiting for your payment. This page will update when the bank receipt is verified.'}
    </p>}
    {payable && qr && <img id="payment-qr" src={qr} alt="UPI payment QR code" width={320} height={320} style={{maxWidth: '100%', height: 'auto'}} />}
    {payable && !qr && !qrError && <p role="status">Loading QR…</p>}
    {!intent && state.busy && <p role="status">Loading payment…</p>}
    {(state.error || qrError) && <p role="alert">{state.error || qrError}</p>}
    {upi && <>
      <p>Pay {amount} with</p>
      <nav aria-label="Payment apps" style={{display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10}}>
        {UPI_APPS.map(app => <a key={app.id} href={upiAppHref(app, upi, platform)} aria-label={`Pay ${amount} with ${app.name}`}
          aria-describedby="payment-app-help" style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, minHeight: 96, minWidth: 44, boxSizing: 'border-box', padding: '12px 4px', border: '1px solid #d4d4d4',
            borderRadius: 12, background: '#fff', color: '#171717', fontSize: 14, fontWeight: 600, textDecoration: 'none'}}>
          <img src={app.icon} alt="" width={48} height={48} style={{objectFit: 'contain'}} />
          <span>{app.name}</span>
        </a>)}
      </nav>
      <p id="payment-app-help" style={{fontSize: 14, lineHeight: 1.5, color: '#525252'}}>
        {platform === 'desktop' ? 'Scan this QR using your phone. Keep this page open for confirmation.'
          : `Choose an installed app, then check the recipient and confirm ${amount} in the app. If it does not open, scan this QR using your payment app.`}
      </p>
    </>}
    {intent && !payable && <p>Amount: {amount}</p>}
    {intent && !state.enabled && <p>Payments are temporarily unavailable. If you already paid, keep your receipt and do not pay again.</p>}
    {recoverable && <>
      <button type="button" onClick={() => setShowRecovery(value => !value)} aria-expanded={showRecovery}
        aria-controls="payment-recovery">Paid but still waiting?</button>
      {showRecovery && <form id="payment-recovery" onSubmit={event => {event.preventDefault(); void controller.current?.claim(reference);}}
        style={{marginTop: 16, textAlign: 'left'}}>
        <p>Enter the 12-digit UPI transaction reference to confirm this payment.</p>
        <label htmlFor="payment-reference">UPI transaction reference (UTR)</label>
        <input id="payment-reference" value={reference} onChange={event => setReference(event.target.value)} required
          inputMode="numeric" pattern="[0-9]{12}" minLength={12} maxLength={12} autoComplete="off"
          style={{display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 10}} />
        <button disabled={state.busy || !/^[0-9]{12}$/.test(reference)}>Check payment reference</button>
        <p>Entering a reference does not confirm payment. We verify it against the bank receipt.</p>
      </form>}
      <p><button type="button" disabled={state.busy} onClick={() => void controller.current?.refresh(true)}>Check again</button></p>
    </>}
    {intent && !recoverable && <p>The recovery window has ended. Keep your receipt and payment reference for support. Do not pay again.</p>}
    {intent && <p style={{fontSize: 12, overflowWrap: 'anywhere'}}>Payment reference: {intent.intent_id}</p>}
    {!intent && state.error && <button disabled={state.busy} onClick={() => void controller.current?.start()}>Try again</button>}
  </section>;
}

const sectionStyle = {textAlign: 'center', width: 'min(100%, 360px)', fontFamily: 'system-ui, sans-serif'} as const;
