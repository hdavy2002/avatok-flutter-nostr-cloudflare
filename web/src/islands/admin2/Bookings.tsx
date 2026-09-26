/* Bookings — [ADMIN2-PEOPLE 2026-09-26] Every seat: paid, free, pending, refunded.
 * GET /api/admin/v2/bookings?event&status&q&from&to&cursor (&format=csv). Money in paise.
 * ?event=<listing id> shows that event's header with seats and revenue.
 * Filters sync to the URL; phones get cards and a filter drawer. */
import { useMemo } from 'react';
import { CalendarDays, Users, IndianRupee, Clock, X } from 'lucide-react';
import { istDateTime } from './adminApi';
import {
  CopyValue, CustomerCell, DateField, Empty, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox,
  StatusPill, StatusToggles, TD, TH, Tile, dayMs, formatPaise, usePaged, useUrlFilters, type Customer,
} from './peopleKit';

interface Booking {
  id: string; order_id: string | null; intent_id: string | null; listing_id: string;
  event_title: string | null; event_starts_at: number | null; category_label: string | null;
  status: string; amount_paise: number; utr: string | null; intent_status: string | null;
  booked_at: number; customer: Customer;
}
interface Totals { bookings: number; seats: number; paid_seats: number; free_seats: number; pending: number; refunded: number; revenue_paise: number; pending_paise: number }
interface EventHead { id: string; title: string; status: string; starts_at: number | null; capacity: number | null; price_paise: number }

const KEYS = ['q', 'status', 'from', 'to', 'event'] as const;
const STATUSES = ['paid', 'free', 'pending', 'refund_requested', 'refunded'] as const;

function amount(b: Booking) {
  return b.status === 'free' ? 'Free' : formatPaise(b.amount_paise);
}

export default function Bookings() {
  const { f, applied, set, clear, key } = useUrlFilters(KEYS);
  const query = useMemo(() => ({
    q: applied.q.trim() || undefined, status: applied.status || undefined, event: applied.event || undefined,
    from: applied.from ? dayMs(applied.from) : undefined, to: applied.to ? dayMs(applied.to, true) : undefined,
  }), [applied]);
  const list = usePaged<Booking>('/api/admin/v2/bookings', query, key);
  const totals = list.first?.totals as Totals | undefined;
  const event = list.first?.event as EventHead | undefined;
  const count = (f.status ? 1 : 0) + (f.from || f.to ? 1 : 0);

  const filters = (
    <>
      <StatusToggles options={STATUSES} value={f.status} onChange={(v) => set({ status: v })} />
      <div className="grid grid-cols-2 gap-2 md:flex">
        <DateField id="bk-from" label="Booked from" value={f.from} onChange={(v) => set({ from: v })} />
        <DateField id="bk-to" label="Booked until" value={f.to} onChange={(v) => set({ to: v })} />
      </div>
    </>
  );

  return (
    <div className="space-y-5">
      {applied.event && (
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">Bookings for one event</div>
              <h2 className="mt-1 font-dash text-[20px] font-bold text-grand-teal sm:text-[22px]">{event?.title ?? (list.phase === 'loading' ? '…' : 'Event')}</h2>
              {event && (
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><CalendarDays className="h-4 w-4" />{event.starts_at ? istDateTime(event.starts_at) : 'No date'}</span>
                  <span>{event.price_paise ? formatPaise(event.price_paise) : 'Free'} a seat</span>
                  <a className="font-bold text-accent underline-offset-2 hover:underline" href={`/admin/events/${encodeURIComponent(event.id)}`}>Edit event</a>
                </p>
              )}
            </div>
            <a href="/admin/bookings" className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-card px-3 text-[13px] font-bold text-foreground no-underline hover:bg-muted">
              <X className="h-4 w-4" /> All bookings
            </a>
          </div>
        </section>
      )}

      {totals && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile tone="accent" label="Seats" value={<span className="inline-flex items-center gap-2"><Users className="h-5 w-5 text-accent" />{totals.seats}{event?.capacity ? <span className="text-[15px] text-muted-foreground"> / {event.capacity}</span> : null}</span>}
            hint={`${totals.paid_seats} paid · ${totals.free_seats} free`} />
          <Tile label="Revenue" value={<span className="inline-flex items-center gap-1"><IndianRupee className="h-5 w-5 text-accent" />{formatPaise(totals.revenue_paise).replace('₹', '')}</span>} hint="Paid seats, refunds excluded" />
          <Tile tone="gold" label="Pending" value={<span className="inline-flex items-center gap-2"><Clock className="h-5 w-5 text-grand-gold" />{totals.pending}</span>} hint={totals.pending ? `${formatPaise(totals.pending_paise)} awaiting the bank` : 'Nothing waiting'} />
          <Tile tone="muted" label="Refunded" value={totals.refunded} hint={`${totals.bookings} bookings in this view`} />
        </div>
      )}

      <FilterBar
        title="Filter bookings"
        count={count}
        onClear={clear}
        resultLabel="Show results"
        search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search bookings" placeholder="Name, email, phone last 4, UTR, event" />}
      >
        {filters}
      </FilterBar>

      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-muted-foreground" aria-live="polite">
          {list.phase === 'ready' ? `${totals?.bookings ?? list.items.length} booking${(totals?.bookings ?? list.items.length) === 1 ? '' : 's'}` : list.phase === 'loading' ? 'Loading…' : ''}
        </p>
        <ExportButton kind={applied.event ? 'bookings_event' : 'bookings'} path="/api/admin/v2/bookings" query={query} />
      </div>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load bookings.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <Empty title={applied.q || count ? 'No bookings match' : 'No bookings yet'} body={applied.q || count ? 'Try a different search or clear the filters.' : 'Seats appear here as soon as customers book.'} />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm md:block">
              <table className="w-full border-collapse">
                <thead className="bg-muted/60">
                  <tr><th className={TH}>Customer</th><th className={TH}>Event</th><th className={TH}>Status</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>UTR</th><th className={TH}>Booked</th></tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {list.items.map((b) => (
                    <tr key={b.id} className="hover:bg-muted/30">
                      <td className={`${TD} max-w-[240px]`}><CustomerCell c={b.customer} /></td>
                      <td className={`${TD} max-w-[260px]`}>
                        <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="font-bold text-foreground underline-offset-2 hover:text-accent hover:underline">{b.event_title ?? b.listing_id}</a>
                        <div className="text-[12.5px] font-semibold text-muted-foreground">{b.event_starts_at ? istDateTime(b.event_starts_at) : 'No date'}</div>
                      </td>
                      <td className={TD}><StatusPill status={b.status} /></td>
                      <td className={`${TD} text-right font-extrabold tabular-nums`}>{amount(b)}</td>
                      <td className={`${TD} text-[13px]`}>{b.utr ? <CopyValue value={b.utr} label="UTR" /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className={`${TD} whitespace-nowrap text-[13px] text-muted-foreground`}>{istDateTime(b.booked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Phone cards */}
            <ul className="space-y-3 md:hidden">
              {list.items.map((b) => (
                <li key={b.id} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <CustomerCell c={b.customer} compact />
                    <div className="shrink-0 text-right">
                      <div className="font-dash text-[16px] font-bold tabular-nums">{amount(b)}</div>
                      <StatusPill status={b.status} className="mt-1" />
                    </div>
                  </div>
                  <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="mt-3 block font-bold text-foreground underline-offset-2 hover:underline">{b.event_title ?? b.listing_id}</a>
                  <div className="text-[12.5px] font-semibold text-muted-foreground">{b.event_starts_at ? istDateTime(b.event_starts_at) : 'No date'}</div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-[12.5px] font-semibold text-muted-foreground">
                    <span>Booked {istDateTime(b.booked_at)}</span>
                    {b.utr && <CopyValue value={b.utr} label="UTR" className="text-[12.5px] text-foreground" />}
                  </div>
                </li>
              ))}
            </ul>
            <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />
          </>
        )}
    </div>
  );
}
