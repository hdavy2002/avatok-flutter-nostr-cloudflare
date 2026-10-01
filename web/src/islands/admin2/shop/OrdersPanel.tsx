/* [AUMFE-POD-FULFIL-1 2026-10-01] Orders now follow Specs/studio-mockup/Orders.dc.html: Money + Production columns, the new tabs,
 * a red "Send to production" button (confirm dialog, disabled-with-reason states) and, in the detail drawer, the money panel and the
 * send panel ("What Printrove gets"). Every earlier action (match payment, sent by hand, shipped, delivered, cancel, refund) is kept.
 * ── original header ──
 * OrdersPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop — the mockup's "Orders" panel:
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
  resolveProduction, retryProduction, sendToProduction,
  type AdminOrder, type Money, type OrderDetail, type Production, type Shipment, type UiStatus,
} from './shopApi';
import './ordersPod.css';

type ModalState =
  | { kind: 'match' | 'print' | 'ship' | 'deliver' | 'cancel' | 'refund' | 'send'; order: AdminOrder }
  | null;

const PROVIDER_LABEL: Record<string, string> = { printrove: 'Printrove', manual: 'By hand' };
const providerName = (p: string | null | undefined): string => (p ? (PROVIDER_LABEL[p] ?? p) : 'the print partner');
const hhmm = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const minsAgo = (ms: number | null | undefined): string => (ms ? `${Math.max(1, Math.round((Date.now() - ms) / 60000))} min` : '');
const isPaid = (m: Money | undefined): boolean => m?.state === 'bank_confirmed' || m?.state === 'owner_confirmed';

/** Money chip + its small line (mockup "Money" column). */
function MoneyCell({ m }: { m: Money | undefined }) {
  if (!m) return <>—</>;
  const tone = m.state === 'bank_confirmed' || m.state === 'owner_confirmed' ? 'ok' : m.state === 'customer_claimed' ? 'warn' : m.state === 'expired' || m.state === 'rejected' ? 'bad' : '';
  let sub = '';
  if (m.state === 'bank_confirmed') sub = ['HDFC', inr(m.amount_received_rupees ?? m.amount_expected_rupees), hhmm(m.received_at), m.utr_last4 && `UTR ••${m.utr_last4}`].filter(Boolean).join(' · ');
  else if (m.state === 'owner_confirmed') sub = ['Matched by hand', m.utr_last4 && `UTR ••${m.utr_last4}`].filter(Boolean).join(' · ');
  else if (m.state === 'customer_claimed') sub = ['Bank has not confirmed yet', m.claimed_at && minsAgo(m.claimed_at)].filter(Boolean).join(' · ');
  return <><span className={`sh-chip${tone ? ` sh-chip--${tone}` : ''}`}>{m.label}</span>{sub && <><br /><small className={`sh-msub${tone ? ` sh-msub--${tone}` : ''}`}>{sub}</small></>}</>;
}

/** Production chip (mockup "Production" column). */
function ProductionCell({ p, m }: { p: Production | undefined; m: Money | undefined }) {
  if (!p) return <>—</>;
  const who = providerName(p.provider);
  const ref = p.provider_order_id ? ` · ${p.provider === 'printrove' ? 'PR-' : ''}${p.provider_order_id}` : '';
  switch (p.state) {
    case 'not_sent':
      if (isPaid(m)) return <span className="sh-chip sh-chip--warn">Not sent</span>;
      return m?.state === 'customer_claimed' ? <span className="sh-chip">Waiting for payment</span> : <span className="sh-chip">—</span>;
    case 'queued': case 'sending': return <span className="sh-chip sh-chip--info">Sending to {who}…</span>;
    case 'sent': return <span className="sh-chip sh-chip--info">At {who}{ref}</span>;
    case 'printing': return <span className="sh-chip sh-chip--info">Printing{ref}</span>;
    case 'shipped': return <span className="sh-chip sh-chip--ok">Shipped{p.courier || p.awb ? ` · ${[p.courier, p.awb].filter(Boolean).join(' ')}` : ''}</span>;
    case 'delivered': return <span className="sh-chip sh-chip--ok">Delivered</span>;
    case 'problem': return <span className="sh-chip sh-chip--bad" title={p.problem ?? undefined}>Problem at {who}</span>;
    case 'cancelled': return <span className="sh-chip">Cancelled</span>;
  }
}

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
  const [counts, setCounts] = useState<Record<string, number>>({});
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
      setItems(r.items); setNext(r.next_cursor ?? null); setCounts(r.counts ?? {});
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
    const pr = o.production;
    const apiRow = !!pr && pr.provider != null && pr.provider !== 'manual' && ['sent', 'printing', 'shipped', 'delivered'].includes(pr.state);
    const sendButton = pr?.can_send
      ? <button type="button" className="sh-btn sh-btn--red sh-mini" onClick={() => setModal({ kind: 'send', order: o })}>{pr.state === 'problem' ? 'Send again' : 'Send to production'}</button>
      : (
        <div className="sh-dis">
          <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled aria-disabled="true" title={pr?.send_blocked_reason ?? undefined} style={{ opacity: 0.55 }}>Send to production</button>
          {pr?.send_blocked_reason && <small>{pr.send_blocked_reason}</small>}
        </div>
      );
    if (st === 'pending') return <div className="sh-acol"><button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setModal({ kind: 'match', order: o })}>Match payment</button>{sendButton}</div>;
    if (st === 'paid') {
      return (
        <div className="sh-acol">
          {sendButton}
          {!pr?.can_send && <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => setModal({ kind: 'print', order: o })}>Sent to Printrove</button>}
        </div>
      );
    }
    if (st === 'packed') return apiRow
      ? <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setDrawerId(o.order_id)}>View</button>
      : <button type="button" className="sh-btn sh-btn--red sh-mini" onClick={() => setModal({ kind: 'ship', order: o })}>Mark shipped</button>;
    if (st === 'shipped') return apiRow
      ? (o.tracking_url
        ? <a className="sh-btn sh-btn--ghost sh-mini" href={o.tracking_url} target="_blank" rel="noopener noreferrer">Track</a>
        : <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setDrawerId(o.order_id)}>Track</button>)
      : <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setModal({ kind: 'deliver', order: o })}>Mark delivered</button>;
    if (st === 'cancelled' && o.fulfil_status === 'refunded') return <span style={{ font: '700 14px Nunito' }}>Refund UTR sent</span>;
    return <>—</>;
  }

  return (
    <div className="sh-apanel is-on" data-apanel="orders">
      <div className="sh-toprow">
        <div className="sh-tabs">
          {ORDER_TABS.map((t) => (
            <button key={t.f} type="button" className={tab === t.f ? 'is-on' : ''} onClick={() => setTab(t.f)}>
              {t.label}{(t.f === 'to_print' || t.f === 'problems') && counts[t.f] > 0 ? ` (${counts[t.f]})` : ''}
            </button>
          ))}
        </div>
        <input className="sh-search" type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search order no., name, UTR" aria-label="Search orders" />
      </div>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : (
        <div className="sh-tbl-wrap">
          <table className="sh-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Money</th><th>Production</th><th>Action</th></tr></thead>
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
                    <td><MoneyCell m={o.money} /></td>
                    <td>{o.production ? <ProductionCell p={o.production} m={o.money} /> : <span className={`sh-st st-${st}`}>{ST_LABEL[st]}</span>}</td>
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
      <SendModal state={modal} onClose={() => setModal(null)} onDone={() => { void load(); onChanged(); }} />

      <OrderDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={() => { void load(); onChanged(); }} onOpenModal={(kind, o) => { setDrawerId(null); setModal({ kind, order: o }); }} />
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
function OrderDrawer({ id, onClose, onChanged, onOpenModal }: { id: string | null; onClose: () => void; onChanged: () => void; onOpenModal: (kind: 'match' | 'print' | 'ship' | 'deliver' | 'cancel' | 'refund' | 'send', o: AdminOrder) => void }) {
  const [d, setD] = useState<OrderDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    setD(null); setErr(null);
    if (!id) return;
    let off = false;
    getOrder(id).then((r) => { if (!off) setD(r.order); }).catch((e) => {
      captureException(e, { where: 'admin2_shop_order_detail' });
      if (!off) setErr(errMessage(e, 'Could not load this order.'));
    });
    return () => { off = true; };
  }, [id, rev]);

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
          {d.money && <MoneyPanel order={d} m={d.money} />}
          {d.production && d.shipment && <SendPanel order={d} p={d.production} shipment={d.shipment} onSend={() => onOpenModal('send', d)} onChanged={() => { setRev((n) => n + 1); onChanged(); }} />}

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
            {st === 'paid' && <button type="button" className="sh-btn sh-btn--teal" onClick={() => onOpenModal('print', d)}>Sent to Printrove{d.production?.provider && d.production.provider !== 'manual' ? ' (by hand)' : ''}</button>}
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

/* ── [AUMFE-POD-FULFIL-1] Money panel (mockup "Order … · money") ── */
function MoneyPanel({ order, m }: { order: OrderDetail; m: Money }) {
  const paid = m.state === 'bank_confirmed' || m.state === 'owner_confirmed';
  type Row = { tone: 'ok' | 'bad' | 'warn' | 'wait'; mark: string; title: string; text: string };
  const rows: Row[] = [];
  if (paid) {
    const recv = m.amount_received_rupees;
    rows.push({
      tone: recv != null && recv !== m.amount_expected_rupees ? 'warn' : 'ok', mark: recv != null && recv !== m.amount_expected_rupees ? '!' : '✓',
      title: recv != null ? `Expected ${inr(m.amount_expected_rupees)} · received ${inr(recv)}` : `Expected ${inr(m.amount_expected_rupees)}`,
      text: recv != null ? (recv === m.amount_expected_rupees ? 'Exact match, including the UPI rounding amount.' : 'The amount differs from what was expected. Check before sending.') : 'Confirmed by hand; no bank amount is linked.',
    });
    rows.push(m.state === 'bank_confirmed'
      ? { tone: 'ok', mark: '✓', title: 'Your bank confirmed it', text: ['HDFC credit alert', m.received_at ? `at ${hhmm(m.received_at)}` : '', m.utr_last4 ? `UTR ••${m.utr_last4}` : '', m.payer_vpa_masked ? `from ${m.payer_vpa_masked}` : ''].filter(Boolean).join(' · ') }
      : { tone: 'warn', mark: '!', title: 'You confirmed it by hand', text: `No bank credit alert was matched${m.utr_last4 ? ` · UTR ••${m.utr_last4}` : ''}.` });
    rows.push({ tone: 'ok', mark: '✓', title: m.matched === 'auto' ? 'Matched automatically' : 'Matched by hand', text: m.matched === 'auto' ? 'No other order was waiting for this amount.' : 'Picked from the bank SMS list or entered with the UTR.' });
    rows.push(m.buyer_notified_at
      ? { tone: 'ok', mark: '✓', title: 'Buyer told', text: `Payment-confirmed message sent ${dmyTime(m.buyer_notified_at)}` }
      : { tone: 'wait', mark: '…', title: 'Buyer message queued', text: 'The payment-confirmed WhatsApp and email go out within a few minutes.' });
  } else {
    rows.push({ tone: m.state === 'customer_claimed' ? 'warn' : 'wait', mark: m.state === 'customer_claimed' ? '!' : '…', title: m.label, text: m.state === 'customer_claimed' ? 'The customer says they paid, but your bank has not confirmed it yet. Do not send until it does.' : `Expected ${inr(m.amount_expected_rupees)}.` });
  }
  return (
    <div className="sh-pod">
      <h3>Money · {order.order_no}</h3>
      <ul className="sh-plist">
        {rows.map((r, k) => <li key={k}><span className={`sh-dot sh-dot--${r.tone}`}>{r.mark}</span><div><b>{r.title}</b><br />{r.text}</div></li>)}
      </ul>
    </div>
  );
}

/* ── Send panel (mockup "Send to production" + "What Printrove gets") + problem handling ── */
function SendPanel({ order, p, shipment, onSend, onChanged }: { order: OrderDetail; p: Production; shipment: Shipment; onSend: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  const who = shipment.provider.label;
  const first = shipment.lines[0];
  const sent = p.state !== 'not_sent' && p.provider !== 'manual' && p.state !== 'problem';

  async function run(kind: 'retry' | 'resend' | 'manual' | 'cancel') {
    setBusy(kind);
    try {
      if (kind === 'retry') await retryProduction(order.order_id); else await resolveProduction(order.order_id, kind);
      capture('admin2_shop_production_resolve', { order_id: order.order_id, action: kind });
      toast.success(kind === 'manual' ? 'Handed back to you. Place it in the partner dashboard, then use "Sent to Printrove".' : kind === 'cancel' ? 'Stopped tracking this order.' : 'Sent again.');
      onChanged();
    } catch (e) {
      captureException(e, { where: 'admin2_shop_production_resolve', action: kind });
      toast.error(errMessage(e, 'That did not go through.'));
    } finally { setBusy(''); }
  }

  return (
    <div className="sh-pod">
      <h3>Send to production</h3>
      {first && (
        <div className="sh-pfile">
          {first.print?.preview_url ? <img src={first.print.preview_url} alt="Print file" loading="lazy" /> : <div className="sh-pfile-ph">Print file</div>}
          <div>
            <b>{first.name} · {first.colour} · {first.size} × {first.qty}</b><br />
            <span>{first.placement ? `${first.placement.side === 'back' ? 'Back' : 'Front'}${first.print?.shape && first.print.shape !== 'none' ? ` · ${first.print.shape}` : ''} ${first.placement.width_in} in${first.print?.version ? ` · design version ${first.print.version}` : ''}` : 'No design on this product'}</span>
          </div>
        </div>
      )}
      <ul className="sh-plist">
        {shipment.lines.map((l, k) => (
          <li key={k}>
            <span className={`sh-dot sh-dot--${l.problem ? 'bad' : 'ok'}`}>{l.problem ? '✗' : '✓'}</span>
            <div>
              <b>What {who} gets{shipment.lines.length > 1 ? ` · line ${k + 1}` : ''}</b><br />
              {l.problem ? l.problem : [
                l.print ? `Print file${l.print.version ? ` v${l.print.version}` : ''}${l.print.width_px ? ` (${l.print.width_px} × ${l.print.height_px} px PNG${l.print.shape && l.print.shape !== 'none' ? `, ${l.print.shape}` : ''})` : ''}` : 'No print file (plain item)',
                l.placement ? `${l.placement.side}, ${l.placement.width_in} in wide, ${l.placement.top_in} in from top` : null,
                `${who} item: ${l.name}, ${l.colour}, ${l.size}${l.qty > 1 ? ` × ${l.qty}` : ''} [${l.partner_item?.sku ?? l.partner_item?.provider_variant_id ?? ''}]`,
              ].filter(Boolean).join(' · ')}
            </div>
          </li>
        ))}
        <li>
          <span className={`sh-dot sh-dot--${shipment.address.ok ? 'ok' : 'bad'}`}>{shipment.address.ok ? '✓' : '✗'}</span>
          <div><b>Address fits {who}</b><br />{shipment.address.ok
            ? `Split into ${shipment.address.lines.length} line${shipment.address.lines.length === 1 ? '' : 's'} of under 50 letters${shipment.address.pincode ? ` · PIN ${shipment.address.pincode} ${shipment.address.serviceable === true ? 'deliverable' : shipment.address.serviceable === false ? 'NOT deliverable' : 'not checked yet'}` : ''}`
            : shipment.address.reason}</div>
        </li>
        <li>
          <span className={`sh-dot sh-dot--${shipment.phone.ok ? 'ok' : 'bad'}`}>{shipment.phone.ok ? '✓' : '✗'}</span>
          <div><b>Phone</b><br />{shipment.phone.ok ? `${shipment.phone.source === 'whatsapp' ? 'Verified WhatsApp' : 'Phone on the address'} ${shipment.phone.masked} used for delivery` : `${who} needs a 10-digit delivery phone and none is on file.`}</div>
        </li>
      </ul>

      {p.state === 'problem' && (
        <div className="sh-pbox" role="alert">
          <b>Problem at {who}</b>
          <p>{p.problem}</p>
          <div className="sh-prow">
            <button type="button" className="sh-btn sh-btn--red sh-mini" disabled={!!busy} onClick={() => void run('retry')}>{busy === 'retry' ? 'Working…' : 'Try again'}</button>
            <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={!!busy} onClick={() => void run('manual')}>I'll place it by hand</button>
            <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={!!busy} onClick={() => void run('cancel')}>Stop tracking</button>
          </div>
        </div>
      )}

      {sent ? (
        <p className="sh-pnote">With {who}{p.provider_order_id ? ` · order ${p.provider_order_id}` : ''}. We ask {who} for updates every few minutes; the buyer is messaged when it ships and when it arrives.</p>
      ) : (
        <div className="sh-prow" style={{ marginTop: 14 }}>
          <button type="button" className="sh-btn sh-btn--red" disabled={!p.can_send} aria-disabled={!p.can_send} style={p.can_send ? undefined : { opacity: 0.55 }} onClick={onSend}>{p.state === 'problem' ? 'Send again' : 'Send to production'}</button>
          <span className="sh-pnote">{p.can_send ? `${who} prints and ships it. The buyer gets "being printed", then tracking, on WhatsApp and email.` : p.send_blocked_reason}</span>
        </div>
      )}

      {(order.production_events ?? []).length > 0 && (
        <ul className="sh-tl" style={{ marginTop: 12 }}>
          {(order.production_events ?? []).map((ev, k) => <li key={k}><b>{ev.kind.replace(/_/g, ' ')}</b><small>{dmyTime(ev.at)}{ev.note ? ` · ${ev.note}` : ''}</small></li>)}
        </ul>
      )}
    </div>
  );
}

/* ── Send-to-production confirm dialog: names item, colour, size and address ── */
function SendModal({ state, onClose, onDone }: { state: ModalState; onClose: () => void; onDone: () => void }) {
  const o = state?.kind === 'send' ? state.order : null;
  const [d, setD] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setD(null); setErr(''); setBusy(false);
    if (!o) return;
    let off = false;
    getOrder(o.order_id).then((r) => { if (!off) setD(r.order); }).catch((e) => {
      captureException(e, { where: 'admin2_shop_send_detail' });
      if (!off) setErr(errMessage(e, 'Could not load the order.'));
    });
    return () => { off = true; };
  }, [o?.order_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o) return null;
  const who = d?.shipment?.provider.label ?? 'the print partner';
  const a = d?.address;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const t0 = Date.now();
    try {
      await sendToProduction(o!.order_id);
      capture('admin2_shop_send_to_production', { order_id: o!.order_id, ok: true, ms: Date.now() - t0 });
      toast.success(`${o!.order_no} sent to ${who} · buyer told it is being printed`);
      onDone(); onClose();
    } catch (ex) {
      capture('admin2_shop_send_to_production', { order_id: o!.order_id, ok: false, ms: Date.now() - t0 });
      captureException(ex, { where: 'admin2_shop_send_to_production' });
      setErr(errMessage(ex, 'That did not go through. Nothing was sent twice; you can try again.'));
      onDone();
    } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Send {o.order_no} to {who}?</h2>
        <p>This places a real print order. Check what is going out.</p>
        {!d && !err && <Spinner />}
        {d?.shipment && (
          <ul className="sh-plist">
            {d.shipment.lines.map((l, k) => (
              <li key={k}><span className={`sh-dot sh-dot--${l.problem ? 'bad' : 'ok'}`}>{l.problem ? '✗' : '✓'}</span><div><b>{l.name} · {l.colour} · {l.size} × {l.qty}</b>{l.problem && <><br />{l.problem}</>}</div></li>
            ))}
            <li><span className="sh-dot sh-dot--ok">→</span><div><b>Delivering to</b><br />{a ? <>{a.name}<br />{[a.line1, a.line2].filter(Boolean).join(', ')}<br />{[a.city, a.state].filter(Boolean).join(', ')} {a.pincode}</> : '—'}</div></li>
          </ul>
        )}
        {err && <p className="sh-err" role="alert">{err}</p>}
        <Buttons onClose={onClose} busy={busy} label="Send to production" tone="red" disabled={!d?.production?.can_send} />
        {d && !d.production?.can_send && <p className="sh-err">{d.production?.send_blocked_reason}</p>}
      </form>
    </Modal>
  );
}
