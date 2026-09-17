import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { API_BASE } from '../../lib/config';

export default function UpiPlainQr() {
  const [attempt, setAttempt] = useState(0);
  const [upi, setUpi] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
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
        } catch { if (active) setError('QR unavailable. Use the payment link below.'); }
      } catch { if (active) setError('Payment QR is temporarily unavailable.'); }
      finally { clearTimeout(timer); }
    })();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return <section style={{textAlign: 'center', width: 'min(100%, 360px)', fontFamily: 'system-ui, sans-serif'}}>
    <h1 style={{fontSize: 28}}>Scan to pay ₹1</h1>
    {qr && <img src={qr} alt="UPI payment QR code" width={320} height={320} style={{maxWidth: '100%', height: 'auto'}} />}
    {!qr && !error && <p role="status">Loading QR…</p>}
    {error && <p role="alert">{error}</p>}
    {upi && <p><a href={upi} style={{display: 'inline-block', padding: '14px 24px', background: '#171717', color: '#fff', borderRadius: 8, textDecoration: 'none'}}>Pay ₹1 with UPI</a></p>}
    {error && !upi && <button onClick={() => setAttempt(value => value + 1)}>Try again</button>}
  </section>;
}
