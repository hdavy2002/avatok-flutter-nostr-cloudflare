/* MerchOrders — [HF-MERCH-ADMIN-1] Admin queue of influencer merch orders. Each order is a row that slides down into a full card.
 * Worker: GET /api/admin/merch/orders?tab= · GET /api/admin/merch/orders/:id?quote=1 · POST .../orders/:id/(approve|reject|tracking|delivered|refund|refund-done). */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DesiEmpty } from '../desi';
import { ApiError } from '../adminApi';
import {
  Banner, OTHER, REASONS, adminCall, click, dateIST, errBody, errCode, fail, money, usePageView,
  type AdminOrder, type LiveQuote,
} from './merchKit';

type Tab = 'pending' | 'printer' | 'shipped' | 'delivered' | 'problem' | 'cancelled';
const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Waiting for approval' }, { key: 'printer', label: 'At printer' }, { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' }, { key: 'problem', label: 'Problems' }, { key: 'cancelled', label: 'Cancelled' },
];
type Counts = Partial<Record<Tab, number>>;
interface ListRes { orders: AdminOrder[]; counts: Counts }
interface DetailRes { order: AdminOrder }

const post = <T,>(path: string, body: unknown = {}) => adminCall<T>(path, { method: 'POST', body });

function stateOf(o: AdminOrder): { label: string; tone: string } {
  if (o.refund.status === 'pending_manual') return { label: 'Refund to send by hand', tone: 'bad' };
  if (o.refund.status === 'refunding') return { label: 'Refunding', tone: 'rani' };
  if (o.problem && o.fulfilment.status !== 'refunded') return { label: 'Fan reported a problem', tone: 'bad' };
  if (o.fulfilment.status === 'refunded' || o.refund.status === 'done') return { label: 'Refunded', tone: 'rani' };
  if (o.approval.status === 'rejected' || o.fulfilment.status === 'cancelled') return { label: 'Rejected', tone: 'rani' };
  if (o.fulfilment.status === 'delivered') return { label: 'Delivered', tone: 'tea' };
  if (o.fulfilment.status === 'shipped') return { label: 'Shipped', tone: 'lav' };
  if (o.approval.status === 'approved') return { label: 'At printer', tone: 'lav' };
  return { label: 'Waiting for approval', tone: '' };
}

function Breakdown({ o, q }: { o: AdminOrder; q: LiveQuote | undefined }) {
  const m = o.merch.money;
  if (!m) return <p className="hfa-note">No money snapshot on this order.</p>;
  const live = q?.quoteAvailable === false ? null : q?.liveBasePaise;
  const rose = q?.costRose || (q?.risePaise ?? 0) > 0;
  return (
    <dl className="mx-kv">
      <dt>Fan paid ({o.payMethod === 'cashfree' ? 'Cashfree' : o.payMethod === 'wallet' ? 'wallet' : o.payMethod ?? '—'})</dt><dd>{money(m.totalPaise)}</dd>
      <dt>Frozen base (print + shipping)</dt><dd>{money(m.basePaise)}</dd>
      {q && <><dt>Live Printrove cost now</dt><dd className={rose ? 'amber' : ''}>{live == null ? 'Not available' : money(live)}{q.risePaise ? ` (${q.risePaise > 0 ? '+' : ''}${money(q.risePaise)})` : ''}</dd></>}
      <dt>Influencer markup</dt><dd>{money(m.markupPaise)}</dd>
      <dt>Influencer gets {(10000 - m.shareBps) / 100}%</dt><dd>{money(m.influencerPaise)}</dd>
      <dt>Platform gets {m.shareBps / 100}%</dt><dd>{money(m.platformPaise)}</dd>
      <dt>Cashfree fee (estimate)</dt><dd>−{money(m.cashfreeFeeEstPaise)}</dd>
      <dt>GST (estimate)</dt><dd>−{money(m.gstEstPaise)}</dd>
      <dt className="tot">Platform net</dt><dd className="tot">{money(m.platformNetPaise)}</dd>
      {q && q.platformNetAfterPaise != null && <><dt className="tot">Platform net at today’s cost</dt><dd className={`tot ${rose ? 'amber' : ''}`}>{money(q.platformNetAfterPaise)}</dd></>}
    </dl>
  );
}

function ReasonPicker({ reason, setReason }: { reason: { pick: string; text: string }; setReason: (r: { pick: string; text: string }) => void }) {
  return (
    <>
      <label>Reason (the fan is told)
        <select className="mx-in" value={reason.pick} onChange={(e) => setReason({ ...reason, pick: e.target.value })}>
          <option value="">Pick a reason…</option>
          {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value={OTHER}>{OTHER}</option>
        </select>
      </label>
      {reason.pick === OTHER && <input className="mx-in" aria-label="Reason" maxLength={300} placeholder="Write the reason" value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} />}
    </>
  );
}
const reasonText = (r: { pick: string; text: string }) => (r.pick === OTHER ? r.text.trim() : r.pick);

function OrderRow({ initial, onChanged, startOpen }: { initial: AdminOrder; onChanged: (msg?: string) => void; startOpen: boolean }) {
  const [o, setO] = useState<AdminOrder>(initial);
  const [open, setOpen] = useState(startOpen);
  const [form, setForm] = useState<null | 'reject' | 'refund' | 'tracking' | 'force' | 'refunddone'>(null);
  const [reason, setReason] = useState({ pick: '', text: '' });
  const [trk, setTrk] = useState({ courier: o.fulfilment.courier ?? '', awb: o.fulfilment.awb ?? '', url: o.fulfilment.trackingUrl ?? '' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loadedQuote, setLoadedQuote] = useState(false);
  const base = `/api/admin/merch/orders/${encodeURIComponent(o.id)}`;
  const awaiting = o.payStatus === 'confirmed' && o.approval.status === 'pending' && o.fulfilment.status === 'new';

  const loadDetail = useCallback(async () => {
    setErr(null);
    try {
      const r = await adminCall<DetailRes>(base, { query: awaiting ? { quote: '1' } : undefined });
      setO(r.order); setLoadedQuote(true);
    } catch (e) { setErr(fail('merch_order_detail', e, { order_id: o.id })); }
  }, [base, awaiting, o.id]);
  useEffect(() => { if (open && !loadedQuote) void loadDetail(); }, [open, loadedQuote, loadDetail]);

  const toggle = () => { const next = !open; setOpen(next); if (next) click('merch_order_opened', { order_id: o.id, status: o.status }); };
  const q = o.liveQuote;
  const costRose = q?.costRose === true;
  const quoteDown = q?.quoteAvailable === false;

  const run = async (action: string, fn: () => Promise<unknown>, done?: (r: unknown) => string | null) => {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await fn();
      setForm(null);
      const msg = done ? done(r) : null;
      if (msg) setInfo(msg);
      await loadDetail();
      onChanged(msg ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && errCode(e) === 'cost_rose') {
        const lq = (errBody(e) as { liveQuote?: LiveQuote }).liveQuote;
        setO((p) => ({ ...p, liveQuote: lq ?? { costRose: true, canApprove: false } }));
        setErr('The printer’s price went up. Approving would lose money, so only Reject and refund is possible.');
        click('merch_cost_rose_seen', { order_id: o.id });
      } else if (e instanceof ApiError && errCode(e) === 'quote_unavailable') {
        setO((p) => ({ ...p, liveQuote: { quoteAvailable: false, costRose: false, canApprove: false, canForce: true } }));
        setErr(fail(action, e, { order_id: o.id }));
      } else setErr(fail(action, e, { order_id: o.id }));
    }
    setBusy(false);
  };

  const approve = (force: boolean) => {
    click('merch_order_approved_clicked', { order_id: o.id, force });
    return run('merch_order_approve', () => post(`${base}/approve`, force ? { force: true } : {}), (r) => {
      const x = r as { manual?: boolean; partnerError?: string | null };
      return x.manual || x.partnerError ? `Approved, but the printer did not take it automatically${x.partnerError ? `: ${x.partnerError}` : ''}. Place it by hand.` : 'Approved and sent to the printer.';
    });
  };
  const reject = (kind: 'reject' | 'refund') => {
    click(kind === 'reject' ? 'merch_order_rejected_clicked' : 'merch_order_refund_clicked', { order_id: o.id });
    return run(`merch_order_${kind}`, () => post(`${base}/${kind}`, { reason: reasonText(reason) }), (r) =>
      (r as { refund?: string }).refund === 'pending_manual' ? 'Rejected. The automatic refund failed, so send the money by hand, then press “Refund sent”.' : 'Rejected and refunded.');
  };
  const saveTracking = () => {
    click('merch_order_tracking_clicked', { order_id: o.id });
    return run('merch_order_tracking', () => post(`${base}/tracking`, { courier: trk.courier.trim(), awb: trk.awb.trim(), trackingUrl: trk.url.trim() }), () => 'Tracking saved. The order is now shipped.');
  };
  const delivered = () => {
    click('merch_order_delivered_clicked', { order_id: o.id });
    return run('merch_order_delivered', () => post(`${base}/delivered`), () => 'Marked as delivered.');
  };
  const refundDone = () => {
    click('merch_order_refund_done_clicked', { order_id: o.id });
    return run('merch_order_refund_done', () => post(`${base}/refund-done`, { note: note.trim() }), () => 'Refund marked as sent.');
  };

  const st = stateOf(o);
  const m = o.merch;
  const a = o.buyer.address;
  const f = o.fulfilment;
  const reasonOk = reasonText(reason).length >= 3;
  const approved = o.approval.status === 'approved';
  const canTrack = approved && ['new', 'at_printer', 'shipped'].includes(f.status);
  const canRefund = approved && ['at_printer', 'shipped', 'delivered'].includes(f.status) && o.refund.status === 'none';

  return (
    <article className={`mx-row${open ? ' open' : ''}`}>
      <button type="button" className="mx-head" aria-expanded={open} onClick={toggle}>
        {m.imageUrl ? <img className="mx-thumb" src={m.imageUrl} alt="" loading="lazy" /> : <span className="mx-thumb" aria-hidden="true" />}
        <span>
          <div className="mx-title">{m.title ?? 'Order'} <ChevronDown size={16} aria-hidden="true" style={{ verticalAlign: -2, transform: open ? 'rotate(180deg)' : undefined }} /></div>
          <div className="mx-sub">{o.orderNo} · {o.seller.displayName ?? 'Influencer'} · {m.size} · {m.colour} · ×{m.qty ?? 1} · {dateIST(o.createdAt)}</div>
        </span>
        <span className="mx-amt">{money(o.totalPaise)}<br /><span className={`mx-chip ${st.tone}`}>{st.label}</span></span>
      </button>
      <div className="mx-slide"><div><div className="mx-body">
        {err && <Banner tone="error">{err}</Banner>}
        {info && <Banner tone="info">{info}</Banner>}
        <div className="mx-cols">
          <div>
            {m.imageUrl && <img className="mx-mock" src={m.imageUrl} alt={`${m.title ?? 'Product'} mockup`} loading="lazy" />}
            <h3 className="mx-h" style={{ marginTop: 12 }}>Order</h3>
            <dl className="mx-kv">
              <dt>Product</dt><dd>{m.title}</dd><dt>Shirt</dt><dd>{m.catalogName}</dd><dt>Size / colour / qty</dt><dd>{m.size} / {m.colour} / {m.qty ?? 1}</dd>
              <dt>Print on</dt><dd>{m.side}</dd>
              <dt>Influencer</dt><dd>{o.seller.displayName ?? '—'}{o.seller.slug ? ` (/${o.seller.slug})` : ''}</dd>
            </dl>
          </div>
          <div>
            <h3 className="mx-h">Fan and delivery</h3>
            <p style={{ margin: 0, fontWeight: 800, fontSize: 16, lineHeight: 1.45 }}>
              {a.name || o.buyer.name}<br />{a.line1}{a.line2 ? `, ${a.line2}` : ''}<br />{a.city}, {a.state} {a.pincode}<br />
              Phone {a.phone || o.buyer.phone || '—'}{o.buyer.email ? <><br />{o.buyer.email}</> : null}
            </p>
            <h3 className="mx-h" style={{ marginTop: 14 }}>Payment</h3>
            <dl className="mx-kv"><dt>Method</dt><dd>{o.payMethod ?? '—'}</dd><dt>Reference</dt><dd style={{ wordBreak: 'break-all' }}>{o.reference ?? '—'}</dd><dt>Order id</dt><dd style={{ wordBreak: 'break-all' }}>{o.id}</dd></dl>
          </div>
          <div>
            <h3 className="mx-h">Money</h3>
            <Breakdown o={o} q={q} />
          </div>
        </div>

        {costRose && <div className="mx-warn" role="alert">The printer’s price went up since the fan paid ({money(q?.risePaise)} more). Approving would leave the platform with {money(q?.platformNetAfterPaise)}, so approving is blocked. Reject and refund the fan.</div>}
        {quoteDown && awaiting && <div className="mx-warn" role="status">{q?.message ?? 'The printer’s live price could not be checked.'} You can still approve at the frozen price if you are sure.</div>}
        {o.refund.status === 'pending_manual' && <div className="mx-warn bad" role="alert">The automatic refund did not go through. Send {money(o.totalPaise)} to the fan by hand (Cashfree dashboard or bank), then press “Refund sent”.</div>}
        {o.approval.rejectReason && <p className="hfa-note">Rejected: {o.approval.rejectReason}</p>}

        <div>
          <h3 className="mx-h">Printing and tracking</h3>
          <dl className="mx-kv">
            <dt>Printer status</dt><dd>{f.status}{f.partner?.status ? ` · ${f.partner.status}` : ''}</dd>
            <dt>Printer order</dt><dd>{f.partnerRef ?? f.partner?.provider_order_id ?? '—'}</dd>
            <dt>Courier / AWB</dt><dd>{f.courier ? `${f.courier} · ${f.awb ?? ''}` : '—'}</dd>
            <dt>Tracking link</dt><dd>{f.trackingUrl ? <a href={f.trackingUrl} target="_blank" rel="noopener noreferrer">Open</a> : '—'}</dd>
            <dt>Sent to printer</dt><dd>{dateIST(f.sentToPrinterAt)}</dd><dt>Shipped</dt><dd>{dateIST(f.shippedAt)}</dd><dt>Delivered</dt><dd>{dateIST(f.deliveredAt)}</dd>
          </dl>
          {f.partner?.last_error && <p className="mx-warn" style={{ marginTop: 8 }}>Printer error: {f.partner.last_error}</p>}
        </div>

        {o.problem && (
          <div className="mx-warn bad">
            <b>Fan problem ({o.problem.kind})</b>: {o.problem.note}
            {o.problem.photoUrl && <div><a href={o.problem.photoUrl} target="_blank" rel="noopener noreferrer">Open the photo the fan sent</a></div>}
          </div>
        )}

        {form === 'reject' || form === 'refund' ? (
          <div className="mx-form">
            <ReasonPicker reason={reason} setReason={setReason} />
            <div className="mx-acts">
              <button type="button" className="hfa-btn danger" disabled={busy || !reasonOk} onClick={() => void reject(form)}>{busy ? 'Working…' : form === 'reject' ? 'Reject and refund the fan' : 'Refund the fan'}</button>
              <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setForm(null)}>Go back</button>
            </div>
          </div>
        ) : null}
        {form === 'tracking' && (
          <div className="mx-form">
            <label>Courier<input className="mx-in" maxLength={60} value={trk.courier} onChange={(e) => setTrk({ ...trk, courier: e.target.value })} placeholder="Delhivery, India Post…" /></label>
            <label>AWB number<input className="mx-in" maxLength={60} value={trk.awb} onChange={(e) => setTrk({ ...trk, awb: e.target.value })} /></label>
            <label>Tracking link (optional, https://)<input className="mx-in" maxLength={300} inputMode="url" value={trk.url} onChange={(e) => setTrk({ ...trk, url: e.target.value })} /></label>
            <div className="mx-acts">
              <button type="button" className="hfa-btn tea" disabled={busy || !trk.courier.trim() || !trk.awb.trim()} onClick={() => void saveTracking()}>{busy ? 'Saving…' : 'Save tracking'}</button>
              <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setForm(null)}>Go back</button>
            </div>
          </div>
        )}
        {form === 'force' && (
          <div className="mx-form">
            <p style={{ margin: 0, fontWeight: 800 }}>Approve without checking today’s printer price? The fan’s price stays as paid.</p>
            <div className="mx-acts">
              <button type="button" className="hfa-btn gold" disabled={busy} onClick={() => void approve(true)}>{busy ? 'Working…' : 'Yes, approve at frozen price'}</button>
              <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setForm(null)}>Go back</button>
            </div>
          </div>
        )}
        {form === 'refunddone' && (
          <div className="mx-form">
            <label>Note (optional, for your records)<input className="mx-in" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="UTR or Cashfree refund id" /></label>
            <div className="mx-acts">
              <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void refundDone()}>{busy ? 'Working…' : 'Yes, I sent the refund'}</button>
              <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setForm(null)}>Go back</button>
            </div>
          </div>
        )}

        {!form && (
          <div className="mx-acts">
            {awaiting && !costRose && !quoteDown && <button type="button" className="hfa-btn tea" disabled={busy || !q?.canApprove} onClick={() => void approve(false)}>{busy ? 'Working…' : q ? 'Approve and send to printer' : 'Checking printer price…'}</button>}
            {awaiting && quoteDown && <button type="button" className="hfa-btn gold" disabled={busy} onClick={() => setForm('force')}>Approve at frozen price</button>}
            {awaiting && <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setReason({ pick: costRose ? REASONS[3] : '', text: '' }); setForm('reject'); }}>{costRose ? 'Reject and refund' : 'Reject'}</button>}
            {canTrack && <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setForm('tracking')}>{f.courier ? 'Edit tracking' : 'Add tracking'}</button>}
            {approved && f.status === 'shipped' && <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void delivered()}>Mark delivered</button>}
            {canRefund && <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setReason({ pick: o.problem ? REASONS[5] : '', text: '' }); setForm('refund'); }}>Refund this order</button>}
            {o.refund.status === 'pending_manual' && <button type="button" className="hfa-btn gold" disabled={busy} onClick={() => setForm('refunddone')}>Refund sent</button>}
            <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => { setLoadedQuote(false); }}>Refresh</button>
          </div>
        )}

        {o.events && o.events.length > 0 && (
          <div>
            <h3 className="mx-h">History</h3>
            <ul className="mx-timeline">{o.events.map((ev, i) => <li key={i}><b>{dateIST(ev.at)}</b> · {ev.kind.replace(/_/g, ' ')}{ev.note ? ` — ${ev.note}` : ''}</li>)}</ul>
          </div>
        )}
      </div></div></div>
    </article>
  );
}

export default function MerchOrders() {
  usePageView('orders');
  const [tab, setTab] = useState<Tab>(() => {
    try { const t = new URLSearchParams(window.location.search).get('tab') as Tab | null; if (t && TABS.some((x) => x.key === t)) return t; } catch { /* no window */ }
    return 'pending';
  });
  const [data, setData] = useState<ListRes | null>(null);
  const [counts, setCounts] = useState<Counts>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const focus = (() => { try { return new URLSearchParams(window.location.search).get('order'); } catch { return null; } })();

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await adminCall<ListRes>('/api/admin/merch/orders', { query: { tab } });
      setData(r); setCounts(r.counts ?? {});
      try { window.dispatchEvent(new CustomEvent('merch-admin:pending', { detail: r.counts?.pending ?? 0 })); } catch { /* not in a browser */ }
    } catch (e) { setError(fail('merch_orders_list', e, { tab })); setData({ orders: [], counts: {} }); }
  }, [tab]);
  useEffect(() => { setData(null); void load(); }, [load]);

  return (
    <div className="hfa-stack">
      <div className="hfa-pills" style={{ alignItems: 'center' }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" className="hfa-pill" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); click('merch_orders_tab', { tab: t.key }); }}>
            {t.label}{counts[t.key] ? ` (${counts[t.key]})` : ''}
          </button>
        ))}
        <button type="button" className="hfa-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}>Refresh</button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {flash && <Banner tone="info">{flash}</Banner>}
      {data === null && <p className="mx-empty" role="status">Loading orders…</p>}
      {data && data.orders.length === 0 && !error && <DesiEmpty text="No orders in this list." />}
      <div className="mx-list">
        {data?.orders.map((o) => <OrderRow key={o.id} initial={o} onChanged={(m) => { if (m) setFlash(m); void load(); }} startOpen={o.id === focus} />)}
      </div>
    </div>
  );
}
