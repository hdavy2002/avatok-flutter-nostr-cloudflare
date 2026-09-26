/* Payments — [ADMIN2-PEOPLE 2026-09-26] Every payment line across customers (orders +
 * commercial_policy_snapshots + hdfc_sms_payment_intents), with a totals strip for the
 * filtered set. GET /api/admin/v2/payments?q&status&cat&paid_from&paid_to&min&max&cursor
 * (&format=csv). Money in paise; min/max are rupees. Filters sync to the URL. */
import { useMemo } from 'react';
import { istDateTime } from './adminApi';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { cn } from '../../lib/utils';
import {
  CopyValue, CustomerCell, DateField, Empty, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox,
  StatusPill, StatusToggles, TD, TH, Tile, dayMs, formatPaise, usePaged, useUrlFilters, type Customer,
} from './peopleKit';

interface Payment {
  id: string; order_id: string | null; listing_id: string; event_title: string | null; category: string | null;
  category_label: string | null; event_starts_at: number | null; amount_paise: number; status: string;
  paid_at: number | null; created_at: number; utr: string | null;
  refund?: { status: string; amount_paise: number | null; refunded_at: number | null };
  customer: Customer;
}
interface Totals {
  count: number; gross_paise: number; collected_paise: number; pending_paise: number; refund_requested_paise: number;
  refunded_paise: number; paid_count: number; pending_count: number; refunded_count: number;
}

const KEYS = ['q', 'status', 'cat', 'paid_from', 'paid_to', 'min', 'max'] as const;
const STATUSES = ['paid', 'pending', 'refund_requested', 'refunded'] as const;
const digits = (v: string) => v.replace(/\D/g, '').slice(0, 9);

export default function Payments() {
  const { f, applied, set, clear, key } = useUrlFilters(KEYS);
  const query = useMemo(() => ({
    q: applied.q.trim() || undefined, status: applied.status || undefined, cat: applied.cat || undefined,
    paid_from: applied.paid_from ? dayMs(applied.paid_from) : undefined, paid_to: applied.paid_to ? dayMs(applied.paid_to, true) : undefined,
    min: applied.min || undefined, max: applied.max || undefined,
  }), [applied]);
  const list = usePaged<Payment>('/api/admin/v2/payments', query, key);
  const totals = list.first?.totals as Totals | undefined;
  const cats = (list.first?.categories as { id: string; label: string }[] | undefined) ?? [];
  const count = (f.status ? 1 : 0) + (f.cat ? 1 : 0) + (f.paid_from || f.paid_to ? 1 : 0) + (f.min || f.max ? 1 : 0);

  const filters = (
    <>
      <StatusToggles options={STATUSES} value={f.status} onChange={(v) => set({ status: v })} />
      <label className="grid gap-1 text-[12px] font-bold text-muted-foreground md:w-44">
        Category
        <Select value={f.cat || 'all'} onValueChange={(v) => set({ cat: v === 'all' ? '' : v })}>
          <SelectTrigger aria-label="Category" className={cn('font-semibold', f.cat && 'border-accent text-accent')}><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            {f.cat && !cats.some((c) => c.id === f.cat) && <SelectItem value={f.cat}>{f.cat}</SelectItem>}
          </SelectContent>
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-2 md:flex">
        <DateField id="pay-from" label="Paid from" value={f.paid_from} onChange={(v) => set({ paid_from: v })} />
        <DateField id="pay-to" label="Paid until" value={f.paid_to} onChange={(v) => set({ paid_to: v })} />
      </div>
      <div className="grid grid-cols-2 gap-2 md:w-52">
        <label htmlFor="pay-min" className="grid gap-1 text-[12px] font-bold text-muted-foreground">Min ₹
          <Input id="pay-min" inputMode="numeric" placeholder="0" value={f.min} onChange={(e) => set({ min: digits(e.target.value) })} /></label>
        <label htmlFor="pay-max" className="grid gap-1 text-[12px] font-bold text-muted-foreground">Max ₹
          <Input id="pay-max" inputMode="numeric" placeholder="Any" value={f.max} onChange={(e) => set({ max: digits(e.target.value) })} /></label>
      </div>
    </>
  );

  return (
    <div className="space-y-5">
      {totals && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals for these filters">
          <Tile tone="accent" label="Collected" value={formatPaise(totals.collected_paise)} hint={`${totals.paid_count} payment${totals.paid_count === 1 ? '' : 's'}`} />
          <Tile tone="gold" label="Pending" value={formatPaise(totals.pending_paise)} hint={`${totals.pending_count} awaiting the bank`} />
          <Tile tone="amber" label="Refund requested" value={formatPaise(totals.refund_requested_paise)} hint="Still counted in collected" />
          <Tile tone="muted" label="Refunded" value={formatPaise(totals.refunded_paise)} hint={`${totals.refunded_count} sent back`} />
        </div>
      )}

      <FilterBar
        title="Filter payments"
        count={count}
        onClear={clear}
        resultLabel="Show results"
        search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search payments" placeholder="Name, email, phone last 4, UTR, event, id" />}
      >
        {filters}
      </FilterBar>

      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-muted-foreground" aria-live="polite">
          {list.phase === 'ready' ? `${totals?.count ?? list.items.length} payment${(totals?.count ?? list.items.length) === 1 ? '' : 's'}` : list.phase === 'loading' ? 'Loading…' : ''}
        </p>
        <ExportButton kind="payments" path="/api/admin/v2/payments" query={query} />
      </div>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load payments.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <Empty title={applied.q || count ? 'No payments match' : 'No payments yet'} body={applied.q || count ? 'Try a different search or clear the filters.' : undefined} />
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm md:block">
              <table className="w-full border-collapse">
                <thead className="bg-muted/60">
                  <tr><th className={TH}>Paid</th><th className={TH}>Customer</th><th className={TH}>Event</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>UTR</th></tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {list.items.map((p) => (
                    <tr key={p.id} className="hover:bg-muted/30">
                      <td className={`${TD} whitespace-nowrap text-[13px]`}>
                        {p.paid_at ? istDateTime(p.paid_at) : <span className="text-muted-foreground">Started {istDateTime(p.created_at)}</span>}
                      </td>
                      <td className={`${TD} max-w-[240px]`}><CustomerCell c={p.customer} /></td>
                      <td className={`${TD} max-w-[240px]`}>
                        <a href={`/admin/bookings?event=${encodeURIComponent(p.listing_id)}`} className="font-bold text-foreground underline-offset-2 hover:text-accent hover:underline">{p.event_title ?? p.listing_id}</a>
                        <div className="text-[12.5px] font-semibold text-muted-foreground">{p.category_label ?? p.category ?? ''}</div>
                      </td>
                      <td className={TD}>
                        <StatusPill status={p.status} />
                        {p.status === 'refunded' && p.refund?.amount_paise != null && p.refund.amount_paise !== p.amount_paise && (
                          <div className="mt-1 text-[12px] font-semibold text-muted-foreground">{formatPaise(p.refund.amount_paise)} back</div>
                        )}
                      </td>
                      <td className={`${TD} text-right font-extrabold tabular-nums`}>{formatPaise(p.amount_paise)}</td>
                      <td className={`${TD} text-[13px]`}>{p.utr ? <CopyValue value={p.utr} label="UTR" /> : <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 md:hidden">
              {list.items.map((p) => (
                <li key={p.id} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-dash text-[18px] font-bold tabular-nums">{formatPaise(p.amount_paise)}</div>
                      <div className="text-[12.5px] font-semibold text-muted-foreground">{p.paid_at ? istDateTime(p.paid_at) : `Started ${istDateTime(p.created_at)}`}</div>
                    </div>
                    <StatusPill status={p.status} />
                  </div>
                  <a href={`/admin/bookings?event=${encodeURIComponent(p.listing_id)}`} className="mt-2 block font-bold text-foreground underline-offset-2 hover:underline">{p.event_title ?? p.listing_id}</a>
                  <div className="mt-2 border-t border-border/40 pt-2"><CustomerCell c={p.customer} compact /></div>
                  {p.utr && <div className="mt-2 text-[12.5px] font-semibold text-muted-foreground">UTR <CopyValue value={p.utr} label="UTR" className="text-foreground" /></div>}
                </li>
              ))}
            </ul>
            <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />
          </>
        )}
    </div>
  );
}
