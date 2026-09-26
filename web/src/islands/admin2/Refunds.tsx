/* Refunds — [ADMIN2-MOVE 2026-09-26] The refunds queue in the Admin 2 shell. Same logic and
 * the same worker API as islands/admin/AdminRefunds.tsx (DASH2-ADMIN-REFUNDS), restyled:
 *   GET  /api/admin/refunds/?status=requested|refunded|rejected|all&q&cursor
 *        (trailing slash: index.ts forwards "/api/admin/refunds/…" to the Dashboard 2 dispatcher)
 *   POST /api/admin/refunds/:payment_id          {refund_utr, amount_paise, refund_vpa}
 *   POST /api/admin/refunds/:refund_id/reject    {note?}
 * Owner rule: refunds are sent BY HAND from the bank app; the admin then records the UTR here
 * and the customer sees it in Dashboard 2 → Billing. */
import { useCallback, useEffect, useState } from 'react';
import { Check, Info, Loader2, Undo2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
import { CopyValue, CustomerCell, Empty, ErrorBox, ListSkeleton, LoadMore, SearchBox, StatusPill, adminCall, formatPaise } from './peopleKit';

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

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-xl border border-grand-gold/60 bg-grand-gold/15 p-3 text-[13.5px] font-semibold text-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-grand-gold" />
        Refunds are sent by hand from the bank app. Send the money first, then record the refund UTR here. The customer sees it in Billing.
      </p>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div role="tablist" aria-label="Refund status" className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const n = t.key === 'all' ? total : counts[t.key];
            const on = tab === t.key;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on}
                onClick={() => { setTab(t.key); setOpen(null); }}
                className={cn('inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted')}>
                {t.label}
                {t.key === 'requested'
                  ? <span className={cn('rounded-full px-2 text-[12px] font-extrabold', requested > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{requested}</span>
                  : n != null ? <span className="text-[12px] tabular-nums opacity-80">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <SearchBox className="md:ml-auto md:w-80" value={q} onChange={(v) => { setQ(v); setOpen(null); }} label="Search refunds" placeholder="Name, email, event, UTR, payment id" />
      </div>

      {error && <ErrorBox message={error} onRetry={load} />}

      {loading ? <ListSkeleton rows={3} /> : !error && rows.length === 0 ? (
        <Empty title={query ? 'Nothing matches that search' : tab === 'requested' ? 'No refund requests waiting' : 'Nothing here'} />
      ) : (
        <ul className="space-y-4">
          {rows.map((r) => {
            const isOpen = open?.id === r.refund_id;
            const b = busy === r.refund_id;
            return (
              <li key={r.refund_id} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-dash text-[18px] font-bold text-foreground">{formatPaise(r.amount_paise)} · {r.event_title ?? 'Unknown event'}</div>
                    <div className="mt-1"><CustomerCell c={{ uid: r.customer.uid, name: r.customer.name, email: r.customer.email, phone_masked: null, phone_hash_only: false }} compact /></div>
                    <div className="mt-1 text-[12.5px] font-semibold text-muted-foreground">Event {istDateTime(r.event_starts_at)} · requested {istDateTime(r.requested_at)}</div>
                  </div>
                  <StatusPill status={r.status} />
                </div>

                <dl className="mt-3 grid gap-2 text-[13.5px] sm:grid-cols-2">
                  <div className="flex flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Payer UTR</dt><dd>{r.payer_utr ? <CopyValue value={r.payer_utr} label="payer UTR" /> : '—'}</dd></div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Payment</dt><dd className="min-w-0"><CopyValue value={r.payment_id} label="payment id" className="text-[12.5px]" /></dd></div>
                  {r.refund_vpa && r.status !== 'refunded' && (
                    <div className="flex flex-wrap items-center gap-2"><dt className="font-bold text-muted-foreground">Customer's UPI id</dt><dd><CopyValue value={r.refund_vpa} label="UPI id" /></dd></div>
                  )}
                </dl>

                <p className="mt-3 whitespace-pre-wrap rounded-lg bg-muted/60 p-3 text-[14px] font-semibold leading-relaxed text-foreground">
                  {r.reason && r.reason !== 'admin_initiated' ? r.reason : r.reason === 'admin_initiated' ? 'Refunded by an admin without a customer request.' : 'No reason given.'}
                </p>

                {r.status === 'refunded' && (
                  <p className="mt-2 text-[13px] font-semibold text-muted-foreground">
                    Refunded {formatPaise(r.refund_amount_paise)} to {r.refund_vpa ?? '—'} on {istDateTime(r.refunded_at)} · refund UTR {r.refund_utr ?? '—'}
                  </p>
                )}

                {r.status === 'requested' && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="accent" disabled={b} onClick={() => openForm(r, 'refund')}><Check /> Mark refunded</Button>
                    <Button variant="outline" disabled={b} onClick={() => openForm(r, 'reject')}><X /> Reject</Button>
                  </div>
                )}

                {isOpen && open?.kind === 'refund' && (
                  <form className="mt-4 grid gap-3 rounded-xl border border-accent/40 bg-accent/5 p-4" onSubmit={(e) => { e.preventDefault(); void markRefunded(r); }}>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="grid gap-1.5"><Label htmlFor={`utr-${r.refund_id}`} className="text-[13px] font-bold">Refund UTR</Label>
                        <Input id={`utr-${r.refund_id}`} value={utr} onChange={(e) => setUtr(e.target.value)} required maxLength={35} autoComplete="off" placeholder="From the bank app" /></div>
                      <div className="grid gap-1.5"><Label htmlFor={`amt-${r.refund_id}`} className="text-[13px] font-bold">Amount (₹)</Label>
                        <Input id={`amt-${r.refund_id}`} value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" /></div>
                      <div className="grid gap-1.5"><Label htmlFor={`vpa-${r.refund_id}`} className="text-[13px] font-bold">Refund UPI id</Label>
                        <Input id={`vpa-${r.refund_id}`} value={vpa} onChange={(e) => setVpa(e.target.value)} required autoComplete="off" placeholder="name@bank" /></div>
                    </div>
                    {formError && <p role="alert" className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-[13px] font-bold text-foreground">{formError}</p>}
                    <div className="flex gap-2">
                      <Button type="submit" variant="accent" disabled={b}>{b ? <Loader2 className="animate-spin" /> : <Undo2 />} {b ? 'Saving…' : 'Record refund'}</Button>
                      <Button type="button" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                    </div>
                  </form>
                )}

                {isOpen && open?.kind === 'reject' && (
                  <form className="mt-4 grid gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4" onSubmit={(e) => { e.preventDefault(); void reject(r); }}>
                    <Label htmlFor={`note-${r.refund_id}`} className="text-[13px] font-bold">Note <span className="font-semibold text-muted-foreground">(optional, kept in the admin audit log)</span></Label>
                    <textarea id={`note-${r.refund_id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
                      className="flex w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
                    {formError && <p role="alert" className="rounded-lg border border-primary/30 bg-card p-2.5 text-[13px] font-bold text-foreground">{formError}</p>}
                    <div className="flex gap-2">
                      <Button type="submit" variant="default" disabled={b}>{b ? <Loader2 className="animate-spin" /> : <X />} {b ? 'Rejecting…' : 'Confirm reject'}</Button>
                      <Button type="button" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!loading && rows.length > 0 && <LoadMore show={!!cursor} busy={moreLoading} onClick={() => void loadMore()} shown={rows.length} />}
    </div>
  );
}
