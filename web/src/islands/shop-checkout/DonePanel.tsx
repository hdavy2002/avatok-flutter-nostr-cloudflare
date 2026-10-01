/* [SAATHUM-SHOP-WEB-CHECKOUT-1] Mockup step 5 — the confirmation panel. The right-hand "Paid" summary is drawn by
 * ShopCheckout (it owns the aside). */
import { useEffect, useState } from 'react';
import { capture, captureException } from '../../lib/analytics';
import { fetchReceiptBlob } from './api';
import { inrPaise } from './parts';
import type { ShopOrder } from './types';

export function DonePanel({ order, auth, firstName }: { order: ShopOrder; auth: string; firstName: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    capture('shop_order_confirmed_seen', { order_id: order.order_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    setErr(null);
    setBusy(true);
    try {
      const blob = await fetchReceiptBlob(order.order_id, auth);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `receipt-${order.order_no}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      capture('shop_receipt_download', { order_id: order.order_id });
    } catch (e) {
      captureException(e, { where: 'shop_checkout_receipt', order_id: order.order_id });
      setErr('The receipt isn’t ready yet. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  const paid = inrPaise(order.pay_amount_paise ?? order.payment.amount_paise);
  return (
    <div className="sh-panel sh-done">
      <div className="big">✓</div>
      <p className="sh-eyebrow">Order {order.order_no} confirmed</p>
      <h2>{firstName ? `Thank you, ${firstName}!` : 'Thank you!'}</h2>
      <p>Payment of {paid} received. Your T-shirts go to print now. We send the tracking link on WhatsApp and email the moment they ship (usually 3–5 days).</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <a className="sh-btn sh-btn--red" href="/dashboard/orders">Track in My orders →</a>
        <button type="button" className="sh-btn sh-btn--ghost" disabled={busy} onClick={() => void download()}>{busy ? 'Preparing…' : 'Download receipt (PDF)'}</button>
        <a className="sh-btn sh-btn--ghost" href="/shop">Keep shopping</a>
      </div>
      {err && <p className="sh-err" role="alert" style={{ color: '#b3261e' }}>{err}</p>}
    </div>
  );
}
