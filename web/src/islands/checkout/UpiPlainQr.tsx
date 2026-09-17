import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { API_BASE } from '../../lib/config';
import { UPI_APPS, upiAppHref, upiPlatform } from './upiAppLinks';
import type { UpiPlatform } from './upiAppLinks';

export default function UpiPlainQr() {
  const [attempt, setAttempt] = useState(0);
  const [upi, setUpi] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [platform, setPlatform] = useState<UpiPlatform>('desktop');
  useEffect(() => {
    setPlatform(upiPlatform(navigator.userAgent, navigator.maxTouchPoints));
    // Old invitation links are deliberately ignored by this public page.
    window.history.replaceState(null, '', window.location.pathname);
    const controller = new AbortController();
    let active = true;
    setUpi(null); setQr(null); setError('');
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/pay/hdfc-sms/qr`, {
          signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error('unavailable');
        const value = await response.json();
        const url = new URL(value.upi_url);
        if (value.amount_paise !== 100 || value.currency !== 'INR' || url.protocol !== 'upi:' || url.hostname !== 'pay'
          || url.searchParams.get('am') !== '1.00' || url.searchParams.get('cu') !== 'INR' || !url.searchParams.get('pa')) throw new Error('invalid');
        if (!active) return;
        setUpi(value.upi_url);
        try {
          const image = await QRCode.toDataURL(value.upi_url, {width: 320, margin: 4, errorCorrectionLevel: 'M'});
          if (active) setQr(image);
        } catch { if (active) setError('QR unavailable. Choose a payment app below.'); }
      } catch { if (active) setError('Payment QR is temporarily unavailable.'); }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return <section style={{textAlign: 'center', width: 'min(100%, 360px)', fontFamily: 'system-ui, sans-serif'}}>
    <h1 style={{fontSize: 28}}>Scan to pay ₹1</h1>
    {qr && <img id="payment-qr" src={qr} alt="UPI payment QR code" width={320} height={320} style={{maxWidth: '100%', height: 'auto'}} />}
    {!qr && !error && <p role="status">Loading QR…</p>}
    {error && <p role="alert">{error}</p>}
    {upi && <>
      <p>Pay ₹1 with</p>
      <nav aria-label="Payment apps" style={{display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10}}>
        {UPI_APPS.map(app => <a key={app.id} href={upiAppHref(app, upi, platform)} aria-label={`Pay ₹1 with ${app.name}`}
          aria-describedby="payment-app-help" style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, minHeight: 96, minWidth: 44, boxSizing: 'border-box', padding: '12px 4px', border: '1px solid #d4d4d4',
            borderRadius: 12, background: '#fff', color: '#171717', fontSize: 14, fontWeight: 600, textDecoration: 'none'}}>
          <img src={app.icon} alt="" width={48} height={48} style={{objectFit: 'contain'}} />
          <span>{app.name}</span>
        </a>)}
      </nav>
      <p id="payment-app-help" style={{fontSize: 14, lineHeight: 1.5, color: '#525252'}}>
        {platform === 'desktop' ? 'On your phone, open this page to choose an app, or scan the QR with Paytm, Google Pay or PhonePe.'
          : 'Choose an installed app, then check the recipient and confirm ₹1 in the app. If it does not open, scan this QR using your payment app.'}
      </p>
    </>}
    {error && !upi && <button onClick={() => setAttempt(value => value + 1)}>Try again</button>}
  </section>;
}
