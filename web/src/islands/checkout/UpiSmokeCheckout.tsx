import { useState } from 'react';
import QRCode from 'qrcode';
import { ClerkIsland, getActiveToken, requireGuestAuth } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';

const LISTING_ID = 'avatok-upi-smoke-2026';

type Intent = { intent_id: string; total_amount: number; upi_url: string; expires_at: number };

function UpiSmokeCheckoutInner() {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<'ready'|'loading'|'waiting'|'confirmed'|'error'>('ready');
  const [error, setError] = useState('');

  async function start() {
    setState('loading'); setError('');
    try {
      const token = (await getActiveToken()) ?? await requireGuestAuth();
      const next = await request<Intent>('/api/pay/hdfc-sms/order', {
        method: 'POST', auth: token, body: { listingId: LISTING_ID },
      });
      setIntent(next);
      setQr(await QRCode.toDataURL(next.upi_url, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
      setState('waiting');
      void poll(next.intent_id, token);
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.error : 'Could not create the UPI test order.');
    }
  }

  async function poll(intentId: string, token: string, attempt = 0): Promise<void> {
    if (attempt >= 120) { setState('error'); setError('Timed out waiting for the bank SMS.'); return; }
    try {
      const result = await request<{ status: string }>('/api/pay/hdfc-sms/status', { auth: token, query: { intent_id: intentId } });
      if (result.status === 'confirmed') { setState('confirmed'); return; }
      if (result.status === 'review_pending' || result.status === 'expired') {
        setState('error'); setError(result.status === 'expired' ? 'The test payment window expired.' : 'SMS received but needs review.'); return;
      }
    } catch { /* transient browser/network failure; keep polling */ }
    window.setTimeout(() => void poll(intentId, token, attempt + 1), 2500);
  }

  return <section style={{ width:'min(100%, 520px)', background:'#fff', border:'2px solid #171717', borderRadius:24, padding:28, boxShadow:'8px 8px 0 #171717', fontFamily:'Nunito, sans-serif' }}>
    <div style={{ fontSize:12, fontWeight:900, letterSpacing:'.12em', textTransform:'uppercase' }}>AvaTOK internal test</div>
    <h1 style={{ margin:'10px 0 6px', fontSize:32 }}>UPI payment smoke test</h1>
    <p style={{ margin:'0 0 20px', lineHeight:1.5 }}>Dummy event · 1 seat · future date · final test amount ₹1</p>
    {state === 'ready' || state === 'loading' || state === 'error' ? <button onClick={() => void start()} disabled={state === 'loading'} style={{ width:'100%', padding:'14px 18px', border:0, borderRadius:14, background:'#0b6bff', color:'#fff', fontWeight:900, fontSize:16 }}>{state === 'loading' ? 'Preparing QR…' : 'Create ₹1 UPI QR'}</button> : null}
    {error ? <p style={{ color:'#a40000', fontWeight:800 }}>{error}</p> : null}
    {qr && intent && state === 'waiting' ? <div style={{ textAlign:'center', marginTop:20 }}><img src={qr} alt="₹1 UPI payment QR code" style={{ width:320, maxWidth:'100%', imageRendering:'pixelated' }} /><p style={{ fontWeight:900 }}>Scan with PhonePe, Paytm or any UPI app.</p><p>Waiting for the signed HDFC SMS…</p></div> : null}
    {state === 'confirmed' ? <div style={{ marginTop:20, padding:20, borderRadius:16, background:'#d9f8df', border:'2px solid #167a2c' }}><h2 style={{ marginTop:0 }}>Payment received ✓</h2><p style={{ marginBottom:0 }}>Thank you. Your seat is booked for the AvaTOK UPI ₹1 Smoke Test.</p></div> : null}
  </section>;
}

export default function UpiSmokeCheckout() {
  return <ClerkIsland><UpiSmokeCheckoutInner /></ClerkIsland>;
}
