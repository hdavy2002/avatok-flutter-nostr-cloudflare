/* [HF-MERCH-FAN-WEB-1] My orders: the merch the fan bought. A tracker (Placed, Approved, Printing, Shipped, Delivered), the courier link,
 * the receipt, and "Report a problem" (wrong or damaged, with a photo, within 48 hours of delivery).
 * /dashboard/orders?order=<id> is where Cashfree returns the buyer: that order opens at once and, while it is still awaiting payment,
 * shows a payment-confirming state and asks the worker again every few seconds (the worker reads Cashfree itself).
 * Worker: GET /api/hf/merch/my-orders(/:id), POST .../problem-photo, POST .../problem. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toMs } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import { getMyOrder, listMyOrders, openReceipt, reportProblem, uploadProblemPhoto, type FanOrder, type FanOrderFull, type FanStatus } from '../../../lib/merchApi';
import '../../../styles/hf-merch.css';
import { Dialog, Empty, Failed, Ic, PageHead, Skel, Sticker, istDay, istTime, useToast } from './ui';

const STEPS = ['Placed', 'Approved', 'Printing', 'Shipped', 'Delivered'] as const;
const STEP_OF: Partial<Record<FanStatus, number>> = { placed: 0, approved: 1, printing: 2, shipped: 3, delivered: 4 };
const LABEL: Record<FanStatus, string> = { awaiting_payment: 'Awaiting payment', placed: 'Placed', approved: 'Approved', printing: 'Printing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
const POLL_MS = 3000, POLL_MAX = 40;

const when = (v: number | string) => { const ms = toMs(v); return ms ? `${istDay(ms)}, ${istTime(ms)}` : ''; };

export default function Orders() {
  const toast = useToast();
  const [orders, setOrders] = useState<FanOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('order') : null));
  const [detail, setDetail] = useState<Record<string, FanOrderFull>>({});
  const [timedOut, setTimedOut] = useState<Record<string, boolean>>({});
  const [report, setReport] = useState<FanOrderFull | null>(null);
  const polls = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    setFailed(false);
    const r = await listMyOrders();
    if (r.ok) setOrders(r.data.orders);
    else { setFailed(true); if (r.status !== 401) captureException(new Error(`merch_orders_${r.status}_${r.code}`), { area: 'hf_merch_fan', step: 'orders_list' }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const fetchOne = useCallback(async (id: string) => {
    const r = await getMyOrder(id);
    if (r.ok) { setDetail(d => ({ ...d, [id]: r.data.order })); return r.data.order; }
    if (r.status !== 401 && r.status !== 404) captureException(new Error(`merch_order_${r.status}_${r.code}`), { area: 'hf_merch_fan', step: 'order_detail' });
    return null;
  }, []);

  // Open an order: load its detail once, and keep asking while it is awaiting payment.
  useEffect(() => {
    if (!openId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const o = await fetchOne(openId);
      if (!live || !o) return;
      if (o.status === 'awaiting_payment') {
        polls.current[openId] = (polls.current[openId] ?? 0) + 1;
        if (polls.current[openId] >= POLL_MAX) { setTimedOut(t => ({ ...t, [openId]: true })); return; }
        timer = setTimeout(tick, POLL_MS);
      } else if ((polls.current[openId] ?? 0) > 0) {
        polls.current[openId] = 0; toast('Payment received. Thank you!'); void load();
      }
    };
    polls.current[openId] = 0; setTimedOut(t => ({ ...t, [openId]: false }));
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [openId, fetchOne, load, toast]);

  const toggle = (o: FanOrder) => {
    const next = openId === o.id ? null : o.id;
    setOpenId(next);
    if (next) capture('merch_order_opened', { order_id: o.id, status: o.status, source: 'list' });
  };
  useEffect(() => { if (openId && new URLSearchParams(location.search).get('order') === openId) capture('merch_order_opened', { order_id: openId, source: 'return_url' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An order opened from the return URL may not be in the list yet (it was created seconds ago).
  const list = (() => {
    const base = orders ?? [];
    const d = openId ? detail[openId] : undefined;
    return d && !base.some(o => o.id === d.id) ? [d, ...base] : base;
  })();

  return <>
    <PageHead eyebrow="My orders" title="Aapka merch, raste mein" sub="T-shirts you bought from influencers. Printed to order, so it takes a few days to reach you." art={<Sticker name="swag" w={110} rot={6} />} />
    {failed ? <Failed onRetry={() => void load()} /> : !orders && !(openId && detail[openId]) ? <Skel h={220} /> : list.length === 0 ?
      <Empty text="You have not bought any merch yet. Find an influencer you like and look for their Merch."><a className="h3-btn rani" href="/marketplace"><Ic name="search" className="" />Find influencers</a></Empty> :
      <div className="hfo hfo-list">
        {list.map(o => <OrderCard key={o.id} o={detail[o.id] ?? o} open={openId === o.id} loading={openId === o.id && !detail[o.id]} timedOut={!!timedOut[o.id]} onToggle={() => toggle(o)} onReport={() => setReport(detail[o.id] ?? o)} />)}
      </div>}
    <ReportDialog order={report} onClose={() => setReport(null)} onDone={() => { toast('Thanks. We have your report and will contact you.'); const id = report?.id; setReport(null); if (id) { void fetchOne(id); void load(); } }} />
  </>;
}

function OrderCard({ o, open, loading, timedOut, onToggle, onReport }: { o: FanOrderFull; open: boolean; loading: boolean; timedOut: boolean; onToggle: () => void; onReport: () => void }) {
  const toast = useToast();
  const [rcpt, setRcpt] = useState(false);
  const step = STEP_OF[o.status];
  const closed = o.status === 'cancelled' || o.status === 'refunded';
  const get = async () => { if (!o.receiptUrl || rcpt) return; setRcpt(true); const ok = await openReceipt(o.receiptUrl); setRcpt(false); if (!ok) toast('We could not open the receipt. Please try again.'); };
  return <article className={`hfo-item${open ? ' open' : ''}`}>
    <button type="button" className="hfo-row" aria-expanded={open} aria-controls={`o-${o.id}`} onClick={onToggle}>
      {o.product.imageUrl ? <img src={o.product.imageUrl} alt="" width="64" height="64" loading="lazy" /> : <span className="ph" aria-hidden="true" />}
      <span className="tx"><b>{o.product.title}</b><small>{o.product.hostName} · {o.product.colour} · {o.product.size} · Qty {o.product.qty}</small><small>Order {o.orderNo} · {when(o.createdAt)}</small></span>
      <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}><span className="amt">{formatPaise(o.totalPaise)}</span><span className={`h3-chip ${closed ? 'miss' : o.status === 'awaiting_payment' ? 'gold' : ''}`}>{LABEL[o.status]}</span></span>
    </button>
    {open && <div id={`o-${o.id}`} className="hfo" style={{ gap: 14 }}>
      {o.status === 'awaiting_payment' && <div className="hfo-notice" role="status" aria-live="polite">
        {timedOut ? <>We have not heard from the bank yet. If money was taken from your account, it will show here soon, and we refund anything that does not go through. <button type="button" className="h3-link" onClick={onToggle}>Close</button></> : <>Confirming your payment with the bank… this usually takes a few seconds. Please keep this page open.</>}
      </div>}
      {step != null && <ol className="hfo-track" aria-label="Order progress">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'done now' : ''} aria-current={i === step ? 'step' : undefined}><i aria-hidden="true">{i <= step ? '✓' : i + 1}</i>{s}</li>)}</ol>}
      {closed && <div className="hfo-notice bad" role="status">
        <b>This order was {o.status === 'refunded' ? 'refunded' : 'cancelled'}.</b>{o.rejectReason ? <> {o.rejectReason}</> : null}
        {' '}{o.refundStatus === 'done' ? 'Your money has been sent back.' : o.refundStatus === 'refunding' ? 'Your refund is on its way.' : o.refundStatus === 'pending_manual' ? 'Our team is sending your refund by hand. We will message you when it is done.' : ''}
      </div>}
      {loading && <Skel h={60} />}
      <dl className="hfo-facts">
        <div><dt>Paid with</dt><dd>{o.payMethod === 'wallet' ? 'Wallet' : o.payMethod === 'cashfree' ? 'UPI / card' : '—'}</dd></div>
        {o.shipping?.courier && <div><dt>Courier</dt><dd>{o.shipping.courier}</dd></div>}
        {o.shipping?.awb && <div><dt>Tracking number</dt><dd>{o.shipping.awb}</dd></div>}
      </dl>
      {o.timeline && o.timeline.length > 0 && <ul className="hfo-time" aria-label="Order history">{o.timeline.map(t => <li key={`${t.at}-${t.label}`}>{when(t.at)} · {t.label}</li>)}</ul>}
      <div className="hfo-acts">
        {o.shipping?.trackingUrl && /^https:\/\//.test(o.shipping.trackingUrl) && <a className="h3-btn sm" href={o.shipping.trackingUrl} target="_blank" rel="noopener noreferrer" onClick={() => capture('merch_tracking_opened', { order_id: o.id })}>Track parcel</a>}
        {o.receiptUrl && <button type="button" className="h3-btn sm ghost" disabled={rcpt} onClick={() => void get()}>{rcpt ? 'Opening…' : 'Receipt'}</button>}
        <a className="h3-btn sm ghost" href={`/h/${o.product.hostSlug}`}>{o.product.hostName}’s page</a>
        {o.canReportProblem && <button type="button" className="h3-btn sm ghost" onClick={onReport}>Report a problem</button>}
      </div>
      {o.status === 'delivered' && !o.canReportProblem && <p className="small muted">Problems with an order can be reported within 48 hours of delivery.</p>}
    </div>}
  </article>;
}

function ReportDialog({ order, onClose, onDone }: { order: FanOrderFull | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'wrong' | 'damaged'>('damaged');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (order) { setKind('damaged'); setNote(''); setFile(null); setErr(''); setBusy(false); } }, [order?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const len = note.trim().length;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!order || busy) return;
    if (len < 10) { setErr('Please tell us a little more (at least 10 characters).'); return; }
    setBusy(true); setErr('');
    let photoKey: string | undefined;
    if (file) {
      const up = await uploadProblemPhoto(order.id, file);
      if (!up.ok) { setBusy(false); setErr(up.message); return; }
      photoKey = up.photoKey;
    }
    const r = await reportProblem(order.id, { kind, note: note.trim(), ...(photoKey ? { photoKey } : {}) });
    setBusy(false);
    capture('merch_problem_submitted', { order_id: order.id, kind, has_photo: !!photoKey, ok: r.ok, reason: r.ok ? undefined : r.code });
    if (r.ok) { onDone(); return; }
    if (r.status === 0 || r.status >= 500) captureException(new Error(`merch_problem_${r.status}_${r.code}`), { area: 'hf_merch_fan', step: 'problem' });
    setErr(r.code === 'window_closed' ? 'The 48 hours to report a problem have passed.' : r.code === 'already_reported' ? 'You have already reported a problem with this order.' : r.message || 'We could not send your report. Please try again.');
  };
  return <Dialog open={!!order} onClose={onClose} label="Report a problem">
    {order && <form className="hfo-form" onSubmit={submit}>
      <h2>Report a problem</h2>
      <p className="muted small">Order {order.orderNo} · {order.product.title}. Tell us within 48 hours of delivery and we will make it right.</p>
      <div role="radiogroup" aria-label="What is wrong?">
        <label className="k"><input type="radio" name="kind" checked={kind === 'damaged'} onChange={() => setKind('damaged')} /> It arrived damaged</label>
        <label className="k"><input type="radio" name="kind" checked={kind === 'wrong'} onChange={() => setKind('wrong')} /> It is the wrong item, size or print</label>
      </div>
      <label htmlFor="hfo-note" style={{ fontWeight: 800 }}>What happened?</label>
      <textarea id="hfo-note" value={note} maxLength={1000} onChange={e => setNote(e.target.value)} aria-describedby="hfo-count" />
      <small id="hfo-count" className="muted">{len}/1000 · at least 10 characters</small>
      <label htmlFor="hfo-photo" style={{ fontWeight: 800 }}>Add a photo (optional, up to 5 MB)</label>
      <input id="hfo-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      {err && <p role="alert" style={{ color: 'var(--bad)', fontWeight: 800 }}>{err}</p>}
      <div className="acts"><button type="submit" className="h3-btn rani" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button><button type="button" className="h3-btn ghost" onClick={onClose} disabled={busy}>Cancel</button></div>
    </form>}
  </Dialog>;
}
