/* Refunds — [ADMIN2-MOVE 2026-09-26] The refunds queue in the Admin 2 shell. Same logic and
 * the same worker API as islands/admin/AdminRefunds.tsx (DASH2-ADMIN-REFUNDS), restyled:
 *   GET  /api/admin/refunds/?status=requested|refunded|rejected|all&q&cursor
 *        (trailing slash: index.ts forwards "/api/admin/refunds/…" to the Dashboard 2 dispatcher)
 *   POST /api/admin/refunds/:payment_id          {refund_utr, amount_paise, refund_vpa}
 *   POST /api/admin/refunds/:refund_id/reject    {note?}
 * Owner rule: refunds are sent BY HAND from the bank app; the admin then records the UTR here
 * and the customer sees it in Dashboard 2 → Billing. */
import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Undo2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
import { CopyValue, CustomerCell, ErrorBox, ListSkeleton, LoadMore, SearchBox, StatusPill, adminCall, formatPaise } from './peopleKit';
import { DesiCard, DesiEmpty, DesiJourney, DesiKpi, DesiKpis, DesiSays, DesiSlip } from './desi';

type RefundStatus = 'requested' | 'refunded' | 'rejected';
type RefundRow = {
  refund_id: string; payment_id: string; order_id: string | null;
  customer: { uid: string; email: string | null; name: string | null };
  listing_id: string | null; event_title: string | null; event_starts_at: number | null;
  amount_paise: number; payer_utr: string | null; requested_at: number; reason: string | null; status: RefundStatus;
  refund_amount_paise: number; refund_utr: string | null; refund_vpa: string | null; refunded_at: number | null;
};
type ListResponse = { items: RefundRow[]; counts: Record<string, number>; next_cursor?: string };

const TABS: Array<{ key: RefundStatus | 'all'; label: string }> = [
  { key: 'requested', label: 'Requested' }, { key: 'refunded', label: 'Refunded' },
  { key: 'rejected', label: 'Rejected' }, { key: 'all', label: 'All' },
];

// Mirrors the worker: adminRecordRefund's UTR rule and me_dashboard_logic.ts VPA_RE.
const UTR_RE = /^[A-Za-z0-9]{6,35}$/;
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

/** "1,254.50" / "1254.5" → 125450 paise; null when not a positive amount with ≤2 decimals. */
function rupeesToPaise(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}
const paiseToInput = (p: number) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));

function readTab(): RefundStatus | 'all' {
  if (typeof window === 'undefined') return 'requested';
  const t = new URLSearchParams(location.search).get('status');
  return TABS.some((x) => x.key === t) ? (t as RefundStatus | 'all') : 'requested';
}
function readQ(): string {
  return typeof window === 'undefined' ? '' : (new URLSearchParams(location.search).get('q') ?? '').slice(0, 80);
}

export default function Refunds() {
  const [tab, setTab] = useState<RefundStatus | 'all'>(readTab);
  const [q, setQ] = useState(readQ);
  const [query, setQuery] = useState(readQ);
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; kind: 'refund' | 'reject' } | null>(null);
  const [utr, setUtr] = useState('');
  const [amount, setAmount] = useState('');
  const [vpa, setVpa] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Debounced search; tab + search mirrored to the URL.
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const u = new URL(location.href);
    if (tab === 'requested') u.searchParams.delete('status'); else u.searchParams.set('status', tab);
    if (query) u.searchParams.set('q', query); else u.searchParams.delete('q');
    history.replaceState(history.state, '', u.toString());
  }, [tab, query]);

  const fetchPage = useCallback((after: string | null) => adminCall<ListResponse>('/api/admin/refunds/', {
    query: { status: tab, q: query || undefined, cursor: after ?? undefined },
  }), [tab, query]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchPage(null);
      setRows(r.items ?? []); setCounts(r.counts ?? {}); setCursor(r.next_cursor ?? null);
    } catch (e) {
      setError(errMessage(e, 'Could not load refunds.')); setRows([]); setCursor(null);
    } finally { setLoading(false); }
  }, [fetchPage]);
  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setMoreLoading(true);
    try {
      const r = await fetchPage(cursor);
      setRows((prev) => [...prev, ...(r.items ?? [])]); setCounts(r.counts ?? {}); setCursor(r.next_cursor ?? null);
    } catch (e) {
      toast.error(errMessage(e, 'Could not load more refunds.'));
    } finally { setMoreLoading(false); }
  }

  function openForm(r: RefundRow, kind: 'refund' | 'reject') {
    if (open && open.id === r.refund_id && open.kind === kind) { setOpen(null); return; }
    setOpen({ id: r.refund_id, kind });
    setFormError(null); setUtr(''); setNote('');
    setAmount(paiseToInput(r.amount_paise)); setVpa(r.refund_vpa ?? '');
  }

  async function markRefunded(r: RefundRow) {
    const u = utr.trim(); const v = vpa.trim(); const paise = rupeesToPaise(amount);
    if (!UTR_RE.test(u)) { setFormError('Enter the refund UTR from the bank app: 6–35 letters or digits, no spaces.'); return; }
    if (paise == null) { setFormError('Enter the refunded amount in rupees, e.g. 627 or 627.50.'); return; }
    if (paise > r.amount_paise) { setFormError(`The refund can't be more than the ${formatPaise(r.amount_paise)} paid.`); return; }
    if (!VPA_RE.test(v)) { setFormError('Enter the UPI id the refund was sent to, like name@bank.'); return; }
    setBusy(r.refund_id); setFormError(null);
    try {
      await adminCall(`/api/admin/refunds/${encodeURIComponent(r.payment_id)}`, { method: 'POST', body: { refund_utr: u, amount_paise: paise, refund_vpa: v } });
      setOpen(null);
      toast.success(`Recorded ${formatPaise(paise)} refunded`, { description: `${r.customer.name ?? r.customer.email ?? 'The customer'} will see it in Billing.` });
      await load();
    } catch (e) {
      setFormError(errMessage(e, 'Could not record that refund.'));
    } finally { setBusy(null); }
  }

  async function reject(r: RefundRow) {
    setBusy(r.refund_id); setFormError(null);
    try {
      await adminCall(`/api/admin/refunds/${encodeURIComponent(r.refund_id)}/reject`, { method: 'POST', body: { note: note.trim() || undefined } });
      setOpen(null);
      toast.success('Request rejected', { description: `${r.customer.name ?? r.customer.email ?? 'The customer'}'s refund request was turned down.` });
      await load();
    } catch (e) {
      setFormError(errMessage(e, 'Could not reject that request.'));
    } finally { setBusy(null); }
  }

  const requested = counts.requested ?? 0;
  const total = (counts.requested ?? 0) + (counts.refunded ?? 0) + (counts.rejected ?? 0);
  const openPaise = rows.filter((r) => r.status === 'requested').reduce((s, r) => s + r.amount_paise, 0);
  const sentPaise = rows.filter((r) => r.status === 'refunded').reduce((s, r) => s + r.refund_amount_paise, 0);

  const journeyFor = (r: RefundRow) => {
    if (r.status === 'rejected') {
      return [
        { title: 'Requested', note: istDateTime(r.requested_at), tone: 'rani' as const, done: true },
        { title: 'Rejected', note: 'Request turned down', tone: 'lav' as const, done: true },
      ];
    }
    const sent = r.status === 'refunded';
    return [
      { title: 'Requested', note: istDateTime(r.requested_at), tone: 'rani' as const, done: true },
      { title: 'Approved', note: 'You checked it', tone: 'gold' as const, done: sent },
      { title: 'Sent from bank', note: 'By hand, bank app', tone: 'lav' as const, done: sent },
      { title: 'UTR recorded', note: sent ? (r.refund_utr ?? '—') : 'Customer sees it in Billing', tone: 'tea' as const, done: sent },
    ];
  };

  return (
    <div className="hfa-stack">
      <DesiCard tone="gold" pattern="stripes" corner="marigold" title="How a refund travels" note="Refunds are sent by hand from the bank app. Send the money first, then record the refund UTR here. The customer sees it in Billing.">
        <DesiJourney label="How a refund travels" steps={[
          { title: 'Requested', note: 'Customer asks', tone: 'rani' },
          { title: 'Approved', note: 'You check it', tone: 'gold' },
          { title: 'Sent from bank', note: 'Pay from bank app', tone: 'lav' },
          { title: 'UTR recorded', note: 'Type it in here', tone: 'tea' },
        ]} />
      </DesiCard>

      <DesiKpis>
        <DesiKpi tone="plum" label="Requests waiting" value={requested} sub="need your decision" />
        <DesiKpi tone="rani" label="Open amount" value={formatPaise(openPaise)} sub="in the requests listed below" />
        <DesiKpi tone="tea" label="Refunded" value={counts.refunded ?? 0} sub={`${formatPaise(sentPaise)} sent, in the list below`} />
        <DesiKpi tone="lav" label="Rejected" value={counts.rejected ?? 0} sub="turned down" />
      </DesiKpis>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div role="tablist" aria-label="Refund status" className="hfa-pills">
          {TABS.map((t) => {
            const n = t.key === 'all' ? total : counts[t.key];
            const on = tab === t.key;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on}
                onClick={() => { setTab(t.key); setOpen(null); }}
                className={cn('hfa-pill inline-flex items-center gap-2', on && 'on')}>
                {t.label}
                {t.key === 'requested'
                  ? <span className={cn('rounded-full px-2 font-extrabold', requested > 0 ? 'bg-[#d81b72] text-white' : 'bg-[#f1e3d6] text-[#6f5b6f]')}>{requested}</span>
                  : n != null ? <span className="tabular-nums opacity-80">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <SearchBox className="md:ml-auto md:w-80" value={q} onChange={(v) => { setQ(v); setOpen(null); }} label="Search refunds" placeholder="Name, email, event, UTR, payment id" />
      </div>

      {error && <ErrorBox message={error} onRetry={load} />}

      {loading ? <ListSkeleton rows={3} /> : !error && rows.length === 0 ? (
        <DesiCard tone="cream" corner="jasmine" pattern="dots">
          <DesiEmpty text={query ? 'Nothing matches that search' : tab === 'requested' ? 'No refund requests waiting' : 'Nothing here'} />
        </DesiCard>
      ) : (
        <ul className="hfa-stack">
          {rows.map((r) => {
            const isOpen = open?.id === r.refund_id;
            const b = busy === r.refund_id;
            const tone = r.status === 'requested' ? 'rani' : r.status === 'refunded' ? 'tea' : 'lav';
            const stripText = r.status === 'requested' ? 'New refund request' : r.status === 'refunded' ? 'Refund sent' : 'Request rejected';
            return (
              <li key={r.refund_id}>
                <DesiSlip tone={tone} strip={stripText} stripRight={<StatusPill status={r.status} />}
                  actions={r.status === 'requested' ? (
                    <>
                      <button type="button" className="hfa-btn danger" disabled={b} onClick={() => openForm(r, 'reject')}><X className="h-4 w-4" /> Reject</button>
                      <button type="button" className="hfa-btn tea" disabled={b} onClick={() => openForm(r, 'refund')}><Check className="h-4 w-4" /> Mark refunded</button>
                    </>
                  ) : undefined}>
                  <div className="hfa-amount">{formatPaise(r.amount_paise)}<small>paid by customer</small></div>
                  <div className="grid min-w-0 gap-3">
                    <div className="min-w-0">
                      <div className="font-dash font-bold text-foreground" style={{ fontSize: 'var(--fs-body)' }}>{r.event_title ?? 'Unknown event'}</div>
                      <div className="mt-1"><CustomerCell c={{ uid: r.customer.uid, name: r.customer.name, email: r.customer.email, phone_masked: null, phone_hash_only: false }} compact /></div>
                      <div className="mt-1 text-[14px] font-semibold text-muted-foreground">Event {istDateTime(r.event_starts_at)} · requested {istDateTime(r.requested_at)}</div>
                    </div>

                    <dl className="grid gap-2 text-[14px] sm:grid-cols-2">
                      <div className="flex flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Payer UTR</dt><dd>{r.payer_utr ? <CopyValue value={r.payer_utr} label="payer UTR" /> : '—'}</dd></div>
                      <div className="flex min-w-0 flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Payment</dt><dd className="min-w-0"><CopyValue value={r.payment_id} label="payment id" className="text-[14px]" /></dd></div>
                      {r.refund_vpa && r.status !== 'refunded' && (
                        <div className="flex flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Customer's UPI id</dt><dd><CopyValue value={r.refund_vpa} label="UPI id" /></dd></div>
                      )}
                    </dl>

                    <div className="hfa-says-grid">
                      <DesiSays k="Customer's reason" tone="lav" v={
                        <span className="whitespace-pre-wrap text-[15px] font-semibold leading-relaxed">
                          {r.reason && r.reason !== 'admin_initiated' ? r.reason : r.reason === 'admin_initiated' ? 'Refunded by an admin without a customer request.' : 'No reason given.'}
                        </span>} />
                      {r.status === 'refunded' && (
                        <DesiSays k="Refund sent" tone="tea" v={
                          <span className="text-[15px] font-semibold leading-relaxed">
                            Refunded {formatPaise(r.refund_amount_paise)} to {r.refund_vpa ?? '—'} on {istDateTime(r.refunded_at)} · refund UTR {r.refund_utr ?? '—'}
                          </span>} />
                      )}
                    </div>

                    <DesiJourney label="Refund progress" steps={journeyFor(r)} />

                    {isOpen && open?.kind === 'refund' && (
                      <form className="hfa-card hfa-t-cream hfa-p-bahi grid gap-3" onSubmit={(e) => { e.preventDefault(); void markRefunded(r); }}>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div className="grid gap-1.5"><Label htmlFor={`utr-${r.refund_id}`} className="text-[14px] font-bold">Refund UTR</Label>
                            <Input id={`utr-${r.refund_id}`} value={utr} onChange={(e) => setUtr(e.target.value)} required maxLength={35} autoComplete="off" placeholder="From the bank app" className="min-h-[44px]" /></div>
                          <div className="grid gap-1.5"><Label htmlFor={`amt-${r.refund_id}`} className="text-[14px] font-bold">Amount (₹)</Label>
                            <Input id={`amt-${r.refund_id}`} value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" className="min-h-[44px]" /></div>
                          <div className="grid gap-1.5"><Label htmlFor={`vpa-${r.refund_id}`} className="text-[14px] font-bold">Refund UPI id</Label>
                            <Input id={`vpa-${r.refund_id}`} value={vpa} onChange={(e) => setVpa(e.target.value)} required autoComplete="off" placeholder="name@bank" className="min-h-[44px]" /></div>
                        </div>
                        {formError && <p role="alert" className="rounded-xl border-2 border-dashed border-[#f2a9c8] bg-[#ffe6ef] p-2.5 text-[14px] font-bold text-foreground">{formError}</p>}
                        <div className="flex flex-wrap gap-2">
                          <button type="submit" className="hfa-btn tea" disabled={b}>{b ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} {b ? 'Saving…' : 'Record refund'}</button>
                          <button type="button" className="hfa-btn ghost" onClick={() => setOpen(null)}>Cancel</button>
                        </div>
                      </form>
                    )}

                    {isOpen && open?.kind === 'reject' && (
                      <form className="hfa-card hfa-t-rani grid gap-2" onSubmit={(e) => { e.preventDefault(); void reject(r); }}>
                        <Label htmlFor={`note-${r.refund_id}`} className="text-[14px] font-bold">Note <span className="font-semibold text-muted-foreground">(optional, kept in the admin audit log)</span></Label>
                        <textarea id={`note-${r.refund_id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                          className="flex w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
                        {formError && <p role="alert" className="rounded-xl border border-[#f2a9c8] bg-card p-2.5 text-[14px] font-bold text-foreground">{formError}</p>}
                        <div className="flex flex-wrap gap-2">
                          <button type="submit" className="hfa-btn rani" disabled={b}>{b ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} {b ? 'Rejecting…' : 'Confirm reject'}</button>
                          <button type="button" className="hfa-btn ghost" onClick={() => setOpen(null)}>Cancel</button>
                        </div>
                      </form>
                    )}
                  </div>
                </DesiSlip>
              </li>
            );
          })}
        </ul>
      )}
      {!loading && rows.length > 0 && <LoadMore show={!!cursor} busy={moreLoading} onClick={() => void loadMore()} shown={rows.length} />}
    </div>
  );
}
