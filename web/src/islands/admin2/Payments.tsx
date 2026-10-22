/* Payments — [ADMIN2-PEOPLE 2026-09-26] Every payment line across customers (orders +
 * commercial_policy_snapshots + hdfc_sms_payment_intents), with a totals strip for the
 * filtered set. GET /api/admin/v2/payments?q&status&cat&paid_from&paid_to&min&max&cursor
 * (&format=csv). Money in paise; min/max are rupees. Filters sync to the URL. */
import { useMemo } from 'react';
import { istDateTime } from './adminApi';
import { Input } from '../../components/ui/input';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, DesiMogra } from './desi';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { cn } from '../../lib/utils';
import {
  CopyValue, CustomerCell, DateField, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox,
  StatusToggles, dayMs, formatPaise, usePaged, useUrlFilters, type Customer,
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
/* Ledger colours: money in = peacock, waiting = gold, needs a decision = lavender, money out = rani. */
const LEDGER: Record<string, { chip: 'tea' | 'gold' | 'lav' | 'rani' | 'grey'; label: string; ink: string }> = {
  paid: { chip: 'tea', label: 'Paid', ink: '#0e7c86' },
  pending: { chip: 'gold', label: 'Pending', ink: '#b45309' },
  refund_requested: { chip: 'lav', label: 'Refund requested', ink: '#6d4fd0' },
  refunded: { chip: 'rani', label: 'Refunded', ink: '#d81b72' },
  free: { chip: 'lav', label: 'Free', ink: '#6d4fd0' },
};
const ledger = (status: string) => LEDGER[status] ?? { chip: 'grey' as const, label: status, ink: '#6f5b6f' };
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
      <label className="grid gap-1 text-[14px] font-bold text-muted-foreground md:w-44">
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
        <label htmlFor="pay-min" className="grid gap-1 text-[14px] font-bold text-muted-foreground">Min ₹
          <Input id="pay-min" inputMode="numeric" placeholder="0" value={f.min} onChange={(e) => set({ min: digits(e.target.value) })} /></label>
        <label htmlFor="pay-max" className="grid gap-1 text-[14px] font-bold text-muted-foreground">Max ₹
          <Input id="pay-max" inputMode="numeric" placeholder="Any" value={f.max} onChange={(e) => set({ max: digits(e.target.value) })} /></label>
      </div>
    </>
  );

  return (
    <div className="hf-admin-operations hfa-stack">
      {totals && (
        <DesiKpis>
          <DesiKpi tone="tea" corner label="Collected" value={formatPaise(totals.collected_paise)} sub={`${totals.paid_count} payment${totals.paid_count === 1 ? '' : 's'}`} />
          <DesiKpi tone="gold" label="Pending" value={formatPaise(totals.pending_paise)} sub={`${totals.pending_count} awaiting the bank`} />
          <DesiKpi tone="lav" label="Refund requested" value={formatPaise(totals.refund_requested_paise)} sub="Still counted in collected" />
          <DesiKpi tone="rani" label="Refunded" value={formatPaise(totals.refunded_paise)} sub={`${totals.refunded_count} sent back`} />
        </DesiKpis>
      )}

      <DesiCard tone="cream" corner="jasmine" pattern="dots">
        <FilterBar
          title="Filter payments"
          count={count}
          onClear={clear}
          resultLabel="Show results"
          search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search payments" placeholder="Name, email, phone last 4, UTR, event, id" />}
        >
          {filters}
        </FilterBar>
      </DesiCard>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="hfa-eyebrow" aria-live="polite">
          {list.phase === 'ready' ? `${totals?.count ?? list.items.length} payment${(totals?.count ?? list.items.length) === 1 ? '' : 's'}` : list.phase === 'loading' ? 'Loading…' : ''}
        </p>
        <ExportButton kind="payments" path="/api/admin/v2/payments" query={query} />
      </div>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load payments.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <DesiCard tone="gold" corner="hibiscus">
            <DesiEmpty text={<><b>{applied.q || count ? 'No payments match' : 'No payments yet'}</b>{applied.q || count ? <><br />Try a different search or clear the filters.</> : null}</>} />
          </DesiCard>
        ) : (
          <>
            {/* Desktop: the bahi-khata ledger */}
            <DesiCard title="Khata" tone="cream" pattern="bahi" corner="marigold" className="hidden md:block">
              <div className="hfa-scroll">
                <table className="hfa-table min-w-[760px]">
                  <thead>
                    <tr><th>Paid</th><th>Customer</th><th>Event</th><th>Status</th><th className="text-right">Amount</th><th>UTR</th></tr>
                  </thead>
                  <tbody>
                    {list.items.map((p) => {
                      const L = ledger(p.status);
                      return (
                        <tr key={p.id} style={{ boxShadow: `inset 5px 0 0 ${L.ink}` }}>
                          <td className="whitespace-nowrap pl-4">
                            {p.paid_at ? istDateTime(p.paid_at) : <span className="text-[var(--a-muted,#6f5b6f)]">Started {istDateTime(p.created_at)}</span>}
                          </td>
                          <td className="max-w-[240px]"><CustomerCell c={p.customer} /></td>
                          <td className="max-w-[240px]">
                            <a href={`/admin/bookings?event=${encodeURIComponent(p.listing_id)}`} className="font-bold text-[var(--a-ink,#2b1530)] underline-offset-2 hover:underline">{p.event_title ?? p.listing_id}</a>
                            <div className="hfa-note">{p.category_label ?? p.category ?? ''}</div>
                          </td>
                          <td>
                            <DesiChip tone={L.chip}>{L.label}</DesiChip>
                            {p.status === 'refunded' && p.refund?.amount_paise != null && p.refund.amount_paise !== p.amount_paise && (
                              <div className="hfa-note mt-1">{formatPaise(p.refund.amount_paise)} back</div>
                            )}
                          </td>
                          <td className="text-right font-['Nunito'] text-[1.2em] font-black tabular-nums" style={{ color: L.ink }}>{formatPaise(p.amount_paise)}</td>
                          <td>{p.utr ? <CopyValue value={p.utr} label="UTR" /> : <span className="text-[var(--a-muted,#6f5b6f)]">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </DesiCard>

            {/* Phones: one ledger slip per payment */}
            <ul className="grid gap-3 md:hidden">
              {list.items.map((p) => {
                const L = ledger(p.status);
                return (
                  <li key={p.id} className="hfa-card hfa-t-cream" style={{ borderLeft: `8px solid ${L.ink}`, paddingLeft: 18 }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-['Nunito'] text-[1.5rem] font-black leading-none tabular-nums" style={{ color: L.ink }}>{formatPaise(p.amount_paise)}</div>
                        <div className="hfa-note mt-1">{p.paid_at ? istDateTime(p.paid_at) : `Started ${istDateTime(p.created_at)}`}</div>
                      </div>
                      <DesiChip tone={L.chip}>{L.label}</DesiChip>
                    </div>
                    <a href={`/admin/bookings?event=${encodeURIComponent(p.listing_id)}`} className="mt-2 flex min-h-[44px] items-center font-bold text-[var(--a-ink,#2b1530)] underline-offset-2 hover:underline">{p.event_title ?? p.listing_id}</a>
                    {p.status === 'refunded' && p.refund?.amount_paise != null && p.refund.amount_paise !== p.amount_paise && (
                      <div className="hfa-note">{formatPaise(p.refund.amount_paise)} back</div>
                    )}
                    <div className="mt-2 border-t border-dashed border-[var(--a-line,#f1e3d6)] pt-2"><CustomerCell c={p.customer} compact /></div>
                    {p.utr && <div className="hfa-note mt-2">UTR <CopyValue value={p.utr} label="UTR" className="text-foreground" /></div>}
                  </li>
                );
              })}
            </ul>
            <DesiMogra />
            <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />
          </>
        )}
    </div>
  );
}
