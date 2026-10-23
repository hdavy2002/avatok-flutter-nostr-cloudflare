/* [HF-MERCH-CREATOR-WEB-1] Orders: status chips, each row slides down to show money, buyer (first name, city, masked address ONLY), courier and timeline. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { Empty, Failed, Skel } from '../v3/ui';
import { dayText, dayTimeText, getOrder, listOrders, merchConfig, rupees, type OrderStatus, type SellerOrder } from './api';

const FILTERS: ['all' | OrderStatus, string][] = [['all', 'All'], ['new', 'New'], ['processing', 'Processing'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']];
const CHIP: Record<OrderStatus, { label: string; cls: string }> = {
  new: { label: 'New', cls: 'gold' }, processing: { label: 'Processing', cls: 'lav' }, shipped: { label: 'Shipped', cls: '' }, delivered: { label: 'Delivered', cls: '' }, cancelled: { label: 'Cancelled', cls: 'dec' },
};

export default function OrdersTab({ counts }: { counts: Partial<Record<OrderStatus, number>> }) {
  const [filter, setFilter] = useState<'all' | OrderStatus>('all');
  const [items, setItems] = useState<SellerOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState<Record<string, SellerOrder>>({});
  const [holdDays, setHoldDays] = useState(7);
  const gen = useRef(0);

  useEffect(() => { void merchConfig().then(c => setHoldDays(c.holdDays)); }, []);
  const load = useCallback(() => {
    const run = ++gen.current;
    setFailed(false); setItems(null);
    void listOrders(filter).then(r => {
      if (run !== gen.current) return;
      if (r.ok) setItems(r.data.orders);
      else { setFailed(true); setItems([]); if (r.status !== 401) captureException(new Error(`merch_orders_${r.status}_${r.code}`), { area: 'hf_merch_creator', part: 'orders' }); }
    });
  }, [filter]);
  useEffect(load, [load]);

  function toggle(o: SellerOrder) {
    const next = openId === o.id ? null : o.id;
    setOpenId(next);
    if (!next) return;
    capture('merch_order_opened', { order_id: o.id, status: o.status });
    if (!full[o.id]) void getOrder(o.id).then(r => { if (r.ok) setFull(f => ({ ...f, [o.id]: r.data.order })); else if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_order_${r.status}_${r.code}`), { area: 'hf_merch_creator' }); });
  }

  return <>
    <div className="mc-chips" role="group" aria-label="Filter orders">{FILTERS.map(([k, l]) =>
      <button key={k} type="button" className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}{k !== 'all' && counts[k] ? <span className="c">{counts[k]}</span> : null}</button>)}</div>
    {failed && <Failed onRetry={load} text="We could not load your orders." />}
    {items === null && <div className="mc-list"><Skel h={84} /><Skel h={84} /></div>}
    {items && !failed && items.length === 0 && <Empty text={filter === 'all' ? 'No orders yet. Share your product link and they will show up here.' : 'No orders in this list.'} />}
    <div className="mc-list">{items?.map(o => {
      const d = full[o.id] ?? o, st = CHIP[o.status], open = openId === o.id;
      return <div key={o.id} className="mc-order">
        <button type="button" aria-expanded={open} onClick={() => toggle(o)}>
          {o.product.imageUrl ? <img className="mc-thumb" src={o.product.imageUrl} alt="" loading="lazy" /> : <span className="mc-thumb" />}
          <span className="main"><b>{o.product.title}</b><span className="small muted">Size {o.product.size} · {o.product.colour} · qty {o.product.qty} · {dayText(o.createdAt)}</span></span>
          <span style={{ textAlign: 'right' }}><span className={`h3-chip ${st.cls}`}>{st.label}</span><span className="small mc-earn" style={{ display: 'block', marginTop: 4 }}>{o.status === 'cancelled' ? '₹0' : `+${rupees(o.money.youEarnPaise)}`}</span></span>
        </button>
        {open && <div className="det">
          <div><h3>Order</h3>
            <div className="mc-kv"><span>Order no.</span><b>{d.orderNo}</b></div>
            <div className="mc-kv"><span>Placed</span><span>{dayTimeText(d.createdAt)}</span></div>
            <div className="mc-kv"><span>Product</span><span style={{ textAlign: 'right' }}>{d.product.title}<br />{d.product.colour}, size {d.product.size}, qty {d.product.qty}</span></div>
            <h3>Money</h3>
            <div className="mc-kv"><span>Fan paid (incl. GST &amp; delivery)</span><span>{rupees(d.money.pricePaise)}</span></div>
            <div className="mc-kv"><span>Base price (print and delivery)</span><span>{rupees(d.money.basePaise)}</span></div>
            <div className="mc-kv"><span>You earn (royalty)</span><b className="mc-earn">{d.status === 'cancelled' ? '₹0' : rupees(d.money.youEarnPaise)}</b></div>
            <div className="mc-kv"><span>Withdrawable</span><span>{d.status === 'cancelled' ? 'Cancelled, nothing to pay' : d.money.credited && (!d.money.availableAt || d.money.availableAt <= Date.now()) ? 'Available now' : d.money.availableAt ? `From ${dayText(d.money.availableAt)}` : `${holdDays} days after delivery`}</span></div>
          </div>
          <div><h3>Delivering to</h3>
            <div className="mc-kv"><span>Name</span><span>{d.buyer.firstName}</span></div>
            <div className="mc-kv"><span>Place</span><span>{[d.buyer.city, d.buyer.state].filter(Boolean).join(', ')}</span></div>
            <div className="mc-kv"><span>Address</span><span>{d.buyer.addressMasked}</span></div>
            <p className="small muted" style={{ marginTop: 6 }}>The fan’s full address and phone are kept private. We print and ship for you.</p>
            <h3>Courier</h3>
            {d.shipping ? <>
              <div className="mc-kv"><span>Courier</span><span>{d.shipping.courier || '—'}</span></div>
              {d.shipping.awb && <div className="mc-kv"><span>Tracking no.</span><span>{d.shipping.awb}</span></div>}
              {d.shipping.trackingUrl && /^https?:\/\//.test(d.shipping.trackingUrl) && <a className="h3-btn sm ghost" style={{ marginTop: 8 }} href={d.shipping.trackingUrl} target="_blank" rel="noopener noreferrer">Track parcel</a>}
            </> : <p className="small muted">Tracking shows here once it is shipped.</p>}
            <h3>Timeline</h3>
            {d.timeline ? <ul className="mc-tl">{d.timeline.map((t, i) => <li key={i}><b>{t.label}</b><span className="small muted">{dayTimeText(t.at)}</span></li>)}</ul> : <Skel h={60} />}
          </div>
        </div>}
      </div>;
    })}</div>
  </>;
}
