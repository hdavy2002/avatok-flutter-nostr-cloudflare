/* ConsultantBookings — [AUMFE-CONSULT-F4-1] Admin table of consultant bookings with a detail drawer and the three money actions.
 * Worker: GET /api/consultants/admin/bookings?status=&q=, POST /bookings/:id/{confirm-payment,refund,cancel}. Admin only.
 * Owner rule: NO automatic refunds — "Mark refunded" only records the UTR of a refund the admin already sent by hand. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../../components/ui/sheet';
import { DISCIPLINE_LABEL, type BookingStatus } from '../../../lib/consultTypes';
import { consultAdminApi, type AdminBooking } from '../../../lib/consultAdminApi';
import { Banner, BOOKING_LABEL, ConfirmDialog, ConsultShell, Spinner, bookingChip, dateIST, fail, minutesOf, rupees, track, useDebounced } from './kit';

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All statuses' },
  ...(['held', 'awaiting_review', 'confirmed', 'in_call', 'completed', 'no_show_consultant', 'no_show_customer', 'cancelled', 'expired'] as BookingStatus[]).map((s) => ({ key: s, label: BOOKING_LABEL[s] })),
];
const CAN_CONFIRM: BookingStatus[] = ['held', 'awaiting_review'];
const CAN_CANCEL: BookingStatus[] = ['held', 'awaiting_review', 'confirmed'];
const PAID: BookingStatus[] = ['confirmed', 'in_call', 'completed', 'no_show_consultant', 'no_show_customer', 'cancelled'];

type Action = 'confirm' | 'cancel' | 'refund';
const SOURCE: Record<string, string> = { sms: 'Bank SMS match', admin: 'Admin', wallet: 'Wallet', utr: 'Typed UTR' };

export default function ConsultantBookings() {
  const [status, setStatus] = useState(() => new URLSearchParams(location.search).get('status') ?? '');
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const dq = useDebounced(q);
  const [rows, setRows] = useState<AdminBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await consultAdminApi.bookings({ status, q: dq.trim() })); }
    catch (e) { setError(fail('bookings_list', e)); setRows([]); }
  }, [status, dq]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const u = new URL(location.href);
    status ? u.searchParams.set('status', status) : u.searchParams.delete('status');
    dq.trim() ? u.searchParams.set('q', dq.trim()) : u.searchParams.delete('q');
    history.replaceState(history.state, '', u.toString());
  }, [status, dq]);
  useEffect(() => { track('bookings_view'); }, []);

  const open = useMemo(() => rows?.find((r) => r.id === openId) ?? null, [rows, openId]);
  const patch = (b: AdminBooking) => setRows((r) => (r ? r.map((x) => (x.id === b.id ? b : x)) : r));

  return (
    <ConsultShell>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="cb-status">Status</label>
          <select id="cb-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label htmlFor="cb-q">Search</label>
          <input id="cb-q" type="search" value={q} placeholder="Customer, consultant, reference or UTR" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <Banner tone="error">{error} <button className="edit" onClick={load}>Try again</button></Banner>}
      {rows === null && <Spinner label="Loading bookings…" />}
      {rows && rows.length === 0 && !error && <div className="card muted" style={{ fontWeight: 700 }}>No bookings match.</div>}
      {rows && rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto', background: '#fff' }}>
          <table className="t">
            <thead><tr><th>Reference</th><th>Customer</th><th>Consultant</th><th>Session</th><th>Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td><strong>{b.ref}</strong></td>
                  <td>{b.customer?.name ?? b.customer?.email ?? '—'}</td>
                  <td>{b.consultant?.name ?? '—'}</td>
                  <td>{DISCIPLINE_LABEL[b.discipline]?.en ?? b.discipline}<br /><span className="muted">{dateIST(b.slot_start_ms)}</span></td>
                  <td>{rupees(b.price?.total)}</td>
                  <td><span className={bookingChip(b.status)}>{BOOKING_LABEL[b.status] ?? b.status}</span></td>
                  <td><button type="button" className="btn small ghost" onClick={() => { setOpenId(b.id); track('booking_open', { status: b.status }); }} aria-label={`Open booking ${b.ref}`}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Sheet open={!!open} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        <SheetContent side="right" className="consult-ui" style={{ width: 'min(520px, 100vw)', maxWidth: '100vw', overflowY: 'auto' }}>
          {open && <Detail b={open} onChanged={(b) => { patch(b); void load(); }} />}
        </SheetContent>
      </Sheet>
    </ConsultShell>
  );
}

function Detail({ b, onChanged }: { b: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const [ask, setAsk] = useState<Action | null>(null);
  const [text, setText] = useState('');
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const p = b.payment ?? null;
  const refunded = !!b.refund?.at || !!b.refund?.utr;
  const canConfirm = CAN_CONFIRM.includes(b.status);
  const canCancel = CAN_CANCEL.includes(b.status);
  const canRefund = PAID.includes(b.status) && !refunded;
  const close = () => { setAsk(null); setText(''); setUtr(''); setErr(null); };

  const run = async () => {
    if (!ask) return;
    setBusy(true); setErr(null);
    try {
      let r: { booking?: AdminBooking };
      if (ask === 'confirm') r = await consultAdminApi.confirmPayment(b.id, text.trim());
      else if (ask === 'cancel') r = await consultAdminApi.cancel(b.id, text.trim());
      else r = await consultAdminApi.refund(b.id, { utr: utr.trim(), note: text.trim() });
      track(`booking_${ask}`, { ok: true });
      setDone(ask === 'confirm' ? 'Payment confirmed.' : ask === 'cancel' ? 'Booking cancelled.' : 'Marked as refunded.');
      onChanged(r.booking ?? { ...b, status: ask === 'confirm' ? 'confirmed' : ask === 'cancel' ? 'cancelled' : b.status, refund: ask === 'refund' ? { utr: utr.trim(), note: text.trim(), at: Date.now() } : b.refund });
      close();
    } catch (e) { setErr(fail(`booking_${ask}`, e)); } finally { setBusy(false); }
  };

  const row = (k: string, v: ReactNode) => (<><span className="k">{k}</span><span className="v" style={{ gridColumn: 'span 2' }}>{v ?? '—'}</span></>);
  const price = b.price;
  const dlg = {
    confirm: { title: 'Confirm this payment?', cta: 'Confirm payment', body: `Marks ${b.ref} as paid and sends the confirmations to the customer and the consultant. Only do this once the money is in the bank.`, label: 'Note (optional)', need: false, danger: false },
    cancel: { title: 'Cancel this booking?', cta: 'Cancel booking', body: `Cancels ${b.ref} and frees the slot. No money moves automatically.`, label: 'Reason (shown in the log)', need: true, danger: true },
    refund: { title: 'Mark as refunded?', cta: 'Mark refunded', body: `Nothing is sent from here. Record the UTR of the refund you already made by hand for ${b.ref}.`, label: 'Note (optional)', need: false, danger: false },
  } as const;
  const cfg = ask ? dlg[ask] : null;
  const invalid = !!cfg && ((cfg.need && text.trim().length < 3) || (ask === 'refund' && utr.trim().length < 6));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SheetHeader>
        <SheetTitle style={{ fontFamily: 'Comfortaa, sans-serif', color: 'var(--teal)', fontSize: 22 }}>Booking {b.ref}</SheetTitle>
        <SheetDescription asChild><div><span className={bookingChip(b.status)}>{BOOKING_LABEL[b.status] ?? b.status}</span>{refunded && <span className="chip gold" style={{ marginLeft: 8 }}>Refunded</span>}</div></SheetDescription>
      </SheetHeader>
      {done && <Banner tone="info">{done}</Banner>}
      <section className="card"><h3>Customer</h3>
        <div className="kv" style={{ marginTop: 10 }}>{row('Name', b.customer?.name)}{row('Email', b.customer?.email)}{row('Phone', b.customer?.phone_masked)}</div></section>
      <section className="card"><h3>Session</h3>
        <div className="kv" style={{ marginTop: 10 }}>
          {row('Consultant', b.consultant?.name)}{row('Discipline', DISCIPLINE_LABEL[b.discipline]?.en ?? b.discipline)}
          {row('Slot', `${dateIST(b.slot_start_ms)} · ${minutesOf(b.slot_start_ms, b.slot_end_ms)} min`)}{row('Booked', dateIST(b.created_at))}
          {b.cancel_reason && row('Cancelled because', b.cancel_reason)}
        </div></section>
      <section className="card"><h3>Price</h3>
        <div className="kv" style={{ marginTop: 10 }}>
          {row('Rate', rupees(price?.rate))}{row(`GST${price ? ` (${price.gst_rate_pct}%)` : ''}`, rupees(price?.gst))}{row('Customer pays', rupees(price?.total))}
          {row(`Platform fee${price ? ` (${price.fee_rate_pct}%)` : ''}`, rupees(price?.fee))}{row('Consultant receives', rupees(price?.payout))}
        </div></section>
      <section className="card"><h3>Payment evidence</h3>
        <div className="kv" style={{ marginTop: 10 }}>
          {row('UTR', p?.utr)}{row('Payer VPA', p?.payer_vpa)}{row('Confirmed by', p?.confirm_source ? SOURCE[p.confirm_source] ?? p.confirm_source : null)}
          {row('Confirmed at', p?.confirmed_at ? dateIST(p.confirmed_at) : null)}
          {p?.unique_amount_paise != null && row('Exact amount asked', `₹${(p.unique_amount_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`)}
          {p?.note && row('Admin note', p.note)}
          {refunded && row('Refund UTR', b.refund?.utr)}{refunded && b.refund?.note && row('Refund note', b.refund.note)}
        </div></section>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {canConfirm && <button type="button" className="btn" onClick={() => setAsk('confirm')}>Confirm payment</button>}
        {canCancel && <button type="button" className="btn ghost" onClick={() => setAsk('cancel')}>Cancel booking</button>}
        {canRefund && <button type="button" className="btn ghost" onClick={() => setAsk('refund')}>Mark refunded</button>}
        {!canConfirm && !canCancel && !canRefund && <span className="hint">No actions are available for this booking.</span>}
      </div>
      <ConfirmDialog open={!!ask} title={cfg?.title ?? ''} body={cfg?.body} confirmLabel={cfg?.cta ?? ''} danger={cfg?.danger} busy={busy} error={err} disabled={invalid} onConfirm={() => void run()} onCancel={close}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ask === 'refund' && <div className="field"><label htmlFor="rf-utr">Refund UTR</label><input id="rf-utr" value={utr} maxLength={40} onChange={(e) => setUtr(e.target.value)} autoComplete="off" /></div>}
          {cfg && <div className="field"><label htmlFor="cf-note">{cfg.label}</label><textarea id="cf-note" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} /></div>}
        </div>
      </ConfirmDialog>
    </div>
  );
}
