/* MyOrders — [SAATHUM-SHOP-DASH-1] /dashboard/orders, a replica of the approved mockup view
 * "Customer: My orders" (Specs/shop-mockup/shop.js renderOrders). GET /api/shop/my-orders
 * (spec §4.2), receipt via the authed blob route, problem report via ReportProblem.
 * Telemetry: dash_orders_viewed {count}, dash_order_problem_reported (in the modal),
 * dash2_receipt_download; failures -> captureException. No Clerk provider (DashNav owns it). */
import { useCallback, useEffect, useState } from 'react';
import './shopDash.css';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { errCode, errMessage, isAbort, istDate, meApi, meBlob } from '../accountApi';
import { inr } from './ProductCard';
import ReportProblem from './ReportProblem';

interface Line { product_id: string; slug: string; name: string; colour: string; size: string; qty: number; unit_rupees: number; image_url: string | null }
interface Shipment { courier: string | null; awb: string | null; tracking_url: string | null; eta_text: string | null; shipped_at: number | null; delivered_at: number | null }
export interface ShopOrder {
  order_id: string; order_no: string;
  status: 'awaiting_payment' | 'confirmed' | 'review_pending' | 'expired';
  fulfil_status: string;
  step: 'ordered' | 'paid' | 'printing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  items: Line[];
  quote: { total_rupees: number };
  created_at: number; confirmed_at: number | null;
  receipt_url: string | null;
  shipment: Shipment | null;
  can_report_problem: boolean;
}

const STEPS = ['Ordered', 'Paid', 'Printing', 'Shipped', 'Delivered'];
const RANK: Record<string, number> = { ordered: 0, paid: 1, printing: 2, shipped: 3, delivered: 4 };

/** Mockup chip classes/labels: st-pending|paid|packed|shipped|delivered|cancelled. */
function chip(o: ShopOrder): { cls: string; label: string } {
  if (o.step === 'cancelled') return { cls: 'st-cancelled', label: 'Cancelled' };
  if (o.step === 'refunded') return { cls: 'st-cancelled', label: 'Refunded' };
  if (o.status !== 'confirmed') return { cls: 'st-pending', label: o.status === 'expired' ? 'Expired' : 'Awaiting payment' };
  switch (o.step) {
    case 'printing': return { cls: 'st-packed', label: 'Printing at Printrove' };
    case 'shipped': return { cls: 'st-shipped', label: 'Shipped' };
    case 'delivered': return { cls: 'st-delivered', label: 'Delivered' };
    default: return { cls: 'st-paid', label: 'Paid · going to print' };
  }
}
const rankOf = (o: ShopOrder) => (o.step in RANK ? RANK[o.step] : o.confirmed_at ? 1 : 0);

function OrderCard({ o, onReport, onReceipt, busy }: { o: ShopOrder; onReport: () => void; onReceipt: () => void; busy: boolean }) {
  const st = chip(o);
  const r = rankOf(o);
  const awb = o.shipment?.awb;
  return (
    <div className="sh-order">
      <div className="sh-oh">
        <div><b>{o.order_no}</b><small>Placed {istDate(o.created_at)} · {inr(o.quote.total_rupees)} {o.status === 'confirmed' ? 'paid by UPI' : 'to pay by UPI'}</small></div>
        <span className={`sh-st ${st.cls}`}>{st.label}</span>
      </div>
      <div className="sh-oitems">
        {o.items.map((i, k) => (
          <div className="sh-oitem" key={`${i.product_id}-${i.colour}-${i.size}-${k}`}>
            {i.image_url ? <img src={i.image_url} alt="" loading="lazy" /> : <div className="sh-ph"><span>T-shirt photo</span></div>}
            <div><b>{i.name}</b><small>{i.colour} · {i.size} · Qty {i.qty}</small></div>
          </div>
        ))}
      </div>
      <div className="sh-track">
        {STEPS.map((s, k) => <div key={s} className={k <= r ? 'ok' : ''}>{s}{k === 3 && awb ? <small>{awb}</small> : null}</div>)}
      </div>
      <div className="sh-oact">
        {o.step === 'shipped' && o.shipment?.tracking_url && (
          <a className="sh-btn sh-btn--teal" href={o.shipment.tracking_url} target="_blank" rel="noopener noreferrer">Track parcel{o.shipment.courier ? ` (${o.shipment.courier})` : ''} →</a>
        )}
        {o.receipt_url && <button type="button" className="sh-btn sh-btn--ghost" onClick={onReceipt} disabled={busy}>{busy ? 'Preparing…' : 'Receipt PDF'}</button>}
        {o.can_report_problem && <button type="button" className="sh-btn sh-btn--ghost" onClick={onReport}>Wrong item? Report it</button>}
        <a className="sh-btn sh-btn--ghost" href="/contact">Need help?</a>
      </div>
    </div>
  );
}

export default function MyOrders() {
  const [orders, setOrders] = useState<ShopOrder[] | null>(null);
  const [error, setError] = useState('');
  const [reporting, setReporting] = useState<ShopOrder | null>(null);
  const [dl, setDl] = useState<string | null>(null);

  const load = useCallback(() => {
    setError('');
    meApi<{ items: ShopOrder[] }>('/api/shop/my-orders')
      .then((r) => { setOrders(r.items); capture('dash_orders_viewed', { count: r.items.length }); })
      .catch((e) => {
        if (isAbort(e)) return;
        captureException(e, { where: 'dash_orders_load' });
        setError(errMessage(e, 'We could not load your orders. Please try again.'));
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const receipt = async (o: ShopOrder) => {
    if (!o.receipt_url || dl) return;
    setDl(o.order_id);
    const t0 = performance.now();
    try {
      const { blob, filename } = await meBlob(o.receipt_url);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename ?? `receipt-${o.order_no}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      capture('dash2_receipt_download', { payment_id: o.order_id, kind: 'shop', ok: true, bytes: blob.size, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      capture('dash2_receipt_download', { payment_id: o.order_id, kind: 'shop', ok: false, reason: errCode(e) ?? 'network' });
      captureException(e, { where: 'dash_order_receipt', order_id: o.order_id });
      toast.error(errMessage(e, 'We could not download the receipt. Please try again.'));
    } finally { setDl(null); }
  };

  return (
    <div className="shop-dash">
      {error && <div className="sh-empty"><b>Something went wrong</b><p style={{ margin: '0 0 16px' }}>{error}</p><button type="button" className="sh-btn sh-btn--red" onClick={load}>Try again</button></div>}
      {!error && orders === null && <p className="sh-note">Loading your orders…</p>}
      {!error && orders && orders.length === 0 && (
        <div className="sh-empty"><b>No shop orders yet</b><p style={{ margin: '0 0 16px', font: '600 15px Nunito', color: 'var(--sub)' }}>When you order a T-shirt, it shows up here with its payment and where the parcel is.</p><a className="sh-btn sh-btn--red" href="/shop/all">Browse T-shirts</a></div>
      )}
      {!error && orders && orders.map((o) => (
        <OrderCard key={o.order_id} o={o} busy={dl === o.order_id} onReceipt={() => void receipt(o)} onReport={() => setReporting(o)} />
      ))}
      {reporting && (
        <ReportProblem
          orderId={reporting.order_id}
          orderNo={reporting.order_no}
          onClose={() => setReporting(null)}
          onDone={(closed) => {
            const id = reporting.order_id;
            setReporting(null);
            setOrders((cur) => cur && cur.map((x) => (x.order_id === id ? { ...x, can_report_problem: false } : x)));
            if (closed) toast.error('The 48-hour window for reporting this order has closed. Please contact support.');
            else toast.success('Report sent', { description: 'We will get back to you soon.' });
          }}
        />
      )}
    </div>
  );
}
