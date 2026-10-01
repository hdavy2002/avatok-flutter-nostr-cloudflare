/* OrdersPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop — the mockup's "Orders" panel:
 * tabs → table (Order / Customer / Items / Total / Payment / Status / Action) with the per-status
 * action button, and the four mockup modals (Match payment, Sent to Printrove, Mark shipped,
 * Mark delivered). Extra, from spec §5.5: search + load more, and a row-detail drawer (items,
 * address, timeline, problem report) with Cancel and Refund (12-digit refund UTR).
 * API (spec §4.5): GET orders, GET orders/:id, POST orders/:id/{confirm-payment,reject-payment,
 * at-printer,shipped,delivered,cancel,refund}. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { Drawer, LoadError, Modal, Spinner, Thumb } from './ShopUI';
import {
  COURIERS, ORDER_TABS, ST_LABEL, dmy, dmyTime, digitsOnly, errMessage, getOrder, inr, listOrders, orderAction, uiStatus,
  type AdminOrder, type OrderDetail, type UiStatus,
} from './shopApi';

type ModalState =
  | { kind: 'match' | 'print' | 'ship' | 'deliver' | 'cancel' | 'refund'; order: AdminOrder }
  | null;

const TIMELINE: Record<string, string> = {
  created: 'Order placed', paid_claimed: 'Customer said they paid', confirmed: 'Payment confirmed', rejected: 'Payment rejected',
  at_printer: 'Sent to Printrove', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
  problem_reported: 'Problem reported',
};

export default function OrdersPanel({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminOrder[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true); setError(null);
    try {
      const r = await listOrders(tab, q, null);
      if (mine !== seq.current) return;
      setItems(r.items); setNext(r.next_cursor ?? null);
    } catch (e) {
      if (mine !== seq.current) return;
      captureException(e, { where: 'admin2_shop_orders_load' });
      setError(errMessage(e, 'Could not load the orders.'));
    } finally { if (mine === seq.current) setLoading(false); }
  }, [tab, q]);

  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try {
      const r = await listOrders(tab, q, next);
      setItems((cur) => [...cur, ...r.items]); setNext(r.next_cursor ?? null);
    } catch (e) {
      captureException(e, { where: 'admin2_shop_orders_more' });
      toast.error(errMessage(e, 'Could not load more orders.'));
    } finally { setMore(false); }
  }

  /** Run one order action; resolves true on success. Modals show their own error text. */
  async function act(o: AdminOrder, action: Parameters<typeof orderAction>[1], body: unknown, to: string, message: string): Promise<boolean> {
    try {
      await orderAction(o.order_id, action, body);
      if (action === 'confirm-payment') capture('admin2_shop_payment_confirmed', { order_id: o.order_id });
      capture('admin2_shop_order_status_changed', { to, order_id: o.order_id });
      toast.success(message);
      await load();
      onChanged();
      return true;
    } catch (e) {
      captureException(e, { where: 'admin2_shop_order_action', action });
      toast.error(errMessage(e, 'That did not go through. Please try again.'));
      return false;
    }
  }

  function actionCell(o: AdminOrder) {
    const st = uiStatus(o);
    if (st === 'pending') return <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setModal({ kind: 'match', order: o })}>Match payment</button>;
    if (st === 'paid') return <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => setModal({ kind: 'print', order: o })}>Sent to Printrove</button>;
    if (st === 'packed') return <button type="button" className="sh-btn sh-btn--red sh-mini" onClick={() => setModal({ kind: 'ship', order: o })}>Mark shipped</button>;
    if (st === 'shipped') return <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setModal({ kind: 'deliver', order: o })}>Mark delivered</button>;
    if (st === 'cancelled' && o.fulfil_status === 'refunded') return <span style={{ font: '700 14px Nunito' }}>Refund UTR sent</span>;
    return <>—</>;
  }

  return (
    <div className="sh-apanel is-on" data-apanel="orders">
      <div className="sh-toprow">
        <div className="sh-tabs">
          {ORDER_TABS.map((t) => (
            <button key={t.f} type="button" className={tab === t.f ? 'is-on' : ''} onClick={() => setTab(t.f)}>{t.label}</button>
          ))}
        </div>
        <input className="sh-search" type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search order no., name, UTR" aria-label="Search orders" />
      </div>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : (
        <div className="sh-tbl-wrap">
          <table className="sh-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30 }}>Loading…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30 }}>No orders in this state.</td></tr>
              ) : items.map((o) => {
                const st: UiStatus = uiStatus(o);
                return (
                  <tr key={o.order_id} className="sh-row-click" onClick={() => setDrawerId(o.order_id)}>
                    <td><b>{o.order_no}</b><br /><small>{dmy(o.created_at)}</small></td>
                    <td>{o.customer?.name || '—'}<br /><small>{o.customer?.city ?? ''}</small></td>
                    <td>{o.items.map((i, k) => <span key={k}>{k > 0 && <br />}{i.name}{i.size ? ` · ${i.size}` : ''} ×{i.qty}</span>)}</td>
                    <td><b>{inr(o.total_rupees)}</b></td>
                    <td>{o.utr_last4 ? `UPI ${o.utr_last4}` : <span style={{ color: '#7a5a00' }}>Not matched</span>}</td>
                    <td><span className={`sh-st st-${st}`}>{ST_LABEL[st]}</span>{o.awb && st !== 'delivered' && <><br /><small>{o.awb}</small></>}</td>
                    <td onClick={(e) => e.stopPropagation()}>{actionCell(o)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {next && !error && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button type="button" className="sh-btn sh-btn--ghost" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Load more'}</button>
        </div>
      )}

      <MatchModal state={modal} onClose={() => setModal(null)} act={act} />
      <PrintModal state={modal} onClose={() => setModal(null)} act={act} />
      <ShipModal state={modal} onClose={() => setModal(null)} act={act} />
      <DeliverModal state={modal} onClose={() => setModal(null)} act={act} />
      <CancelModal state={modal} onClose={() => setModal(null)} act={act} />
      <RefundModal state={modal} onClose={() => setModal(null)} act={act} />

      <OrderDrawer id={drawerId} onClose={() => setDrawerId(null)} onOpenModal={(kind, o) => { setDrawerId(null); setModal({ kind, order: o }); }} />
    </div>
  );
}

type ActFn = (o: AdminOrder, action: Parameters<typeof orderAction>[1], body: unknown, to: string, message: string) => Promise<boolean>;
interface MProps { state: ModalState; onClose: () => void; act: ActFn }

function Buttons({ onClose, busy, label, tone = 'teal', disabled }: { onClose: () => void; busy: boolean; label: string; tone?: 'teal' | 'red'; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className={`sh-btn sh-btn--${tone}`} style={{ flex: 1 }} disabled={busy || disabled}>{busy ? 'Working…' : label}</button>
    </div>
  );
}

/* ── Match payment (mockup: "Match payment · SHP-…") ── */
function MatchModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'match' ? state.order : null;
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [pick, setPick] = useState('');
  const [utr, setUtr] = useState('');
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setDetail(null); setPick(''); setUtr(''); setReject(false); setReason(''); setErr('');
    if (!o) return;
    let off = false;
    getOrder(o.order_id).then((r) => { if (!off) setDetail(r.order); }).catch((e) => captureException(e, { where: 'admin2_shop_match_detail' }));
    return () => { off = true; };
  }, [o?.order_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!o) return null;
  const cands = detail?.sms_candidates ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (reject) {
      if (reason.trim().length < 3) { setErr('Write a short reason.'); return; }
      setBusy(true);
      const ok = await act(o!, 'reject-payment', { reason: reason.trim() }, 'rejected', `${o!.order_no} payment rejected · customer messaged`);
      setBusy(false); if (ok) onClose();
      return;
    }
    if (!pick && utr.length !== 12) { setErr('Pick a bank SMS or enter the 12-digit UTR.'); return; }
    setBusy(true);
    const ok = await act(o!, 'confirm-payment', pick ? { message_hash: pick } : { utr }, 'confirmed', 'Payment confirmed · order moved to “to pack”');
    setBusy(false); if (ok) onClose();
  }

  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Match payment · {o.order_no}</h2>
        {cands.length > 0 ? (
          <p>{cands.length} bank SMS could match {inr(o.total_rupees)}. Pick the right one, or enter the customer's 12-digit UTR after checking your bank app.</p>
        ) : (
          <p>No bank SMS matched {inr(o.total_rupees)} yet. Enter the customer's 12-digit UTR after checking your bank app.</p>
        )}
        {cands.length > 0 && (
          <div className="sh-promo-opts">
            {cands.map((c) => (
              <label key={c.message_hash} className="sh-opt">
                <input type="radio" name="sms" checked={pick === c.message_hash} onChange={() => setPick(c.message_hash)} />
                {inr(c.amount_paise / 100)} · UTR {c.bank_reference ?? '—'} · {dmyTime(c.received_at)}
              </label>
            ))}
          </div>
        )}
        {!reject ? (
          <div className="sh-form">
            <label className="full">UTR<input placeholder="12-digit UPI reference" inputMode="numeric" maxLength={12} value={utr} onChange={(e) => { setUtr(digitsOnly(e.target.value, 12)); if (e.target.value) setPick(''); }} /></label>
          </div>
        ) : (
          <div className="sh-form">
            <label className="full">Reason (kept in the audit log)<input placeholder="e.g. Amount does not match any credit" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          </div>
        )}
        {err && <p className="sh-err" role="alert">{err}</p>}
        <Buttons onClose={onClose} busy={busy} label={reject ? 'Reject payment' : 'Confirm payment'} tone={reject ? 'red' : 'teal'} />
        <p style={{ marginTop: 12, fontSize: 14 }}>
          Rejecting sends the soft WhatsApp + email message with the support contact.{' '}
          <button type="button" className="sh-link" onClick={() => { setReject(!reject); setErr(''); }}>{reject ? 'Back to confirming' : 'Reject this payment'}</button>
        </p>
      </form>
    </Modal>
  );
}

/* ── Sent to Printrove ── */
function PrintModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'print' ? state.order : null;
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRef(''); }, [o?.order_id]);
  if (!o) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const ok = await act(o!, 'at-printer', ref.trim() ? { printrove_order_ref: ref.trim() } : {}, 'at_printer', `${o!.order_no} → Printing at Printrove · customer notified on WhatsApp + email`);
    setBusy(false); if (ok) onClose();
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Sent to Printrove · {o.order_no}</h2>
        <p>Confirm you placed this order on Printrove. The customer sees “Printing” on their tracker.</p>
        <div className="sh-form">
          <label className="full">Printrove order ref (optional)<input placeholder="from your Printrove dashboard" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        </div>
        <Buttons onClose={onClose} busy={busy} label="Sent to Printrove" />
      </form>
    </Modal>
  );
}

/* ── Mark shipped (mockup copy) ── */
function ShipModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'ship' ? state.order : null;
  const [courier, setCourier] = useState(COURIERS[0]);
  const [awb, setAwb] = useState('');
  const [link, setLink] = useState('');
  const [eta, setEta] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setCourier(COURIERS[0]); setAwb(''); setLink(''); setEta(''); setNotify(true); setErr(''); }, [o?.order_id]);
  if (!o) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (awb.trim().length < 4) { setErr('Enter the AWB / tracking number.'); return; }
    setBusy(true);
    const ok = await act(o!, 'shipped', { courier, awb: awb.trim(), tracking_url: link.trim() || undefined, eta_text: eta.trim() || undefined, notify }, 'shipped', `${o!.order_no} shipped · tracking sent to ${o!.customer?.name || 'the customer'}`);
    setBusy(false); if (ok) onClose();
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Mark {o.order_no} as shipped</h2>
        <p>{o.customer?.name || 'Customer'}, {o.customer?.city || '—'} · {o.items.length} item(s). Copy the courier and tracking number from Printrove.</p>
        <div className="sh-form">
          <label>Courier (from Printrove)<select value={courier} onChange={(e) => setCourier(e.target.value)}>{COURIERS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>AWB / tracking number<input value={awb} onChange={(e) => setAwb(e.target.value)} placeholder="DL 77920 1183" /></label>
          <label className="full">Tracking link<input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.delhivery.com/track/package/…" inputMode="url" /></label>
          <label className="full">Expected delivery<input value={eta} onChange={(e) => setEta(e.target.value)} placeholder="5 Oct 2026" /></label>
        </div>
        <label className="sh-opt" style={{ marginTop: 14 }}><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Send tracking on WhatsApp + email</label>
        {err && <p className="sh-err" role="alert">{err}</p>}
        <Buttons onClose={onClose} busy={busy} label="Mark shipped" tone="red" />
      </form>
    </Modal>
  );
}

/* ── Mark delivered ── */
function DeliverModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'deliver' ? state.order : null;
  const [busy, setBusy] = useState(false);
  if (!o) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const ok = await act(o!, 'delivered', {}, 'delivered', `${o!.order_no} → Delivered · customer notified on WhatsApp + email`);
    setBusy(false); if (ok) onClose();
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Mark {o.order_no} as delivered?</h2>
        <p>The customer gets a delivery message and the 48-hour “report a problem” window starts now.</p>
        <Buttons onClose={onClose} busy={busy} label="Mark delivered" />
      </form>
    </Modal>
  );
}

/* ── Cancel (detail drawer) ── */
function CancelModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'cancel' ? state.order : null;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setReason(''); setErr(''); }, [o?.order_id]);
  if (!o) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) { setErr('Write a short reason.'); return; }
    setBusy(true);
    const ok = await act(o!, 'cancel', { reason: reason.trim() }, 'cancelled', `${o!.order_no} cancelled`);
    setBusy(false); if (ok) onClose();
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Cancel {o.order_no}?</h2>
        <p>Use this before it ships. If the customer already paid, send the refund next and enter its UTR.</p>
        <div className="sh-form"><label className="full">Reason<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer asked to cancel" /></label></div>
        {err && <p className="sh-err" role="alert">{err}</p>}
        <Buttons onClose={onClose} busy={busy} label="Cancel order" tone="red" />
      </form>
    </Modal>
  );
}

/* ── Refund (12-digit refund UTR) ── */
function RefundModal({ state, onClose, act }: MProps) {
  const o = state?.kind === 'refund' ? state.order : null;
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setUtr(''); setNote(''); setErr(''); }, [o?.order_id]);
  if (!o) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (utr.length !== 12) { setErr('The refund UTR is 12 digits.'); return; }
    setBusy(true);
    const ok = await act(o!, 'refund', { refund_utr: utr, note: note.trim() }, 'refunded', `${o!.order_no} refunded · customer notified`);
    setBusy(false); if (ok) onClose();
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Refund {o.order_no} · {inr(o.total_rupees)}</h2>
        <p>Send the money back to the paying UPI account first, then enter the 12-digit UTR of that refund here.</p>
        <div className="sh-form">
          <label className="full">Refund UTR<input placeholder="12-digit UPI reference" inputMode="numeric" maxLength={12} value={utr} onChange={(e) => setUtr(digitsOnly(e.target.value, 12))} /></label>
          <label className="full">Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Wrong item sent — replaced by refund" /></label>
        </div>
        {err && <p className="sh-err" role="alert">{err}</p>}
        <Buttons onClose={onClose} busy={busy} label="Record refund" tone="red" />
      </form>
    </Modal>
  );
}

/* ── Row detail drawer ── */
function OrderDrawer({ id, onClose, onOpenModal }: { id: string | null; onClose: () => void; onOpenModal: (kind: 'match' | 'print' | 'ship' | 'deliver' | 'cancel' | 'refund', o: AdminOrder) => void }) {
  const [d, setD] = useState<OrderDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null); setErr(null);
    if (!id) return;
    let off = false;
    getOrder(id).then((r) => { if (!off) setD(r.order); }).catch((e) => {
      captureException(e, { where: 'admin2_shop_order_detail' });
      if (!off) setErr(errMessage(e, 'Could not load this order.'));
    });
    return () => { off = true; };
  }, [id]);

  const st: UiStatus | null = d ? uiStatus(d) : null;
  const a = d?.address;
  const canCancel = !!d && st !== 'cancelled' && st !== 'delivered' && st !== 'shipped';
  const canRefund = !!d && d.pay_status === 'confirmed' && d.fulfil_status !== 'refunded';

  return (
    <Drawer open={!!id} title={d ? d.order_no : 'Order'} onClose={onClose}>
      {err && <p className="sh-err" role="alert">{err}</p>}
      {!d && !err && <Spinner />}
      {d && st && (
        <div className="sh-dbody">
          <div className="sh-dline"><span className={`sh-st st-${st}`}>{ST_LABEL[st]}</span><small>Placed {dmyTime(d.created_at)}</small></div>

          <h3>Customer</h3>
          <p className="sh-dtext">
            <b>{d.customer?.name || '—'}</b>{d.customer?.email && <><br />{d.customer.email}</>}{d.customer?.phone_masked && <><br />{d.customer.phone_masked}</>}
          </p>

          <h3>Items</h3>
          {d.items.map((i, k) => (
            <div className="sh-sum-item" key={k}>
              <Thumb url={i.image_url} />
              <div><b>{i.name}</b><small>{[i.colour, i.size && `Size ${i.size}`, `Qty ${i.qty}`].filter(Boolean).join(' · ')}</small></div>
              <strong>{inr(i.amount_rupees ?? (i.unit_rupees ?? 0) * i.qty)}</strong>
            </div>
          ))}
          <div className="sh-dline" style={{ marginTop: 10 }}><b>Total (incl. GST)</b><b>{inr(d.total_rupees)}</b></div>

          <h3>Delivery address</h3>
          <p className="sh-dtext">
            {a ? <>{a.name}{a.phone && ` · ${a.phone}`}<br />{[a.line1, a.line2].filter(Boolean).join(', ')}<br />{[a.city, a.state].filter(Boolean).join(', ')} {a.pincode}</> : <>{d.customer?.city || '—'}</>}
          </p>

          <h3>Payment</h3>
          <p className="sh-dtext">{d.utr_last4 ? `UPI reference ending ${d.utr_last4}` : <span style={{ color: '#7a5a00' }}>Not matched yet</span>}{d.payer_reference && <><br />Reference {d.payer_reference}</>}</p>

          {(d.courier || d.awb) && (<>
            <h3>Shipment</h3>
            <p className="sh-dtext">{d.courier}{d.awb && <><br />AWB {d.awb}</>}{d.eta_text && <><br />Expected {d.eta_text}</>}{d.tracking_url && <><br /><a className="sh-link" href={d.tracking_url} target="_blank" rel="noopener noreferrer">Open tracking</a></>}</p>
          </>)}

          {d.problem && (<>
            <h3>Problem reported</h3>
            <p className="sh-dtext" style={{ color: '#9b1c14' }}>
              {d.problem.message}
              {d.problem.photo_url && <><br /><a className="sh-link" href={d.problem.photo_url} target="_blank" rel="noopener noreferrer">View photo</a></>}
            </p>
          </>)}

          <h3>Timeline</h3>
          <ul className="sh-tl">
            {(d.timeline ?? []).map((t, k) => (
              <li key={k}><b>{TIMELINE[t.kind] ?? t.kind}</b><small>{dmyTime(t.at)}{t.note ? ` · ${t.note}` : ''}</small></li>
            ))}
            {(d.timeline ?? []).length === 0 && <li><small>No events yet.</small></li>}
          </ul>

          <div className="sh-oact" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            {st === 'pending' && <button type="button" className="sh-btn sh-btn--ghost" onClick={() => onOpenModal('match', d)}>Match payment</button>}
            {st === 'paid' && <button type="button" className="sh-btn sh-btn--teal" onClick={() => onOpenModal('print', d)}>Sent to Printrove</button>}
            {st === 'packed' && <button type="button" className="sh-btn sh-btn--red" onClick={() => onOpenModal('ship', d)}>Mark shipped</button>}
            {st === 'shipped' && <button type="button" className="sh-btn sh-btn--ghost" onClick={() => onOpenModal('deliver', d)}>Mark delivered</button>}
            {canCancel && <button type="button" className="sh-btn sh-btn--ghost" style={{ color: '#b3261e', borderColor: '#b3261e' }} onClick={() => onOpenModal('cancel', d)}>Cancel order</button>}
            {canRefund && <button type="button" className="sh-btn sh-btn--ghost" style={{ color: '#b3261e', borderColor: '#b3261e' }} onClick={() => onOpenModal('refund', d)}>Refund (UTR)</button>}
          </div>
        </div>
      )}
    </Drawer>
  );
}
