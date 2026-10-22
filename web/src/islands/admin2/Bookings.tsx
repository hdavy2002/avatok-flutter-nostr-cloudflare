/* Bookings — [ADMIN2-PEOPLE 2026-09-26] Every seat: paid, free, pending, refunded.
 * GET /api/admin/v2/bookings?event&status&q&from&to&cursor (&format=csv). Money in paise.
 * ?event=<listing id> shows that event's header with seats and revenue.
 * Filters sync to the URL; phones get cards and a filter drawer. */
import { useMemo } from 'react';
import { CalendarDays, Users, IndianRupee, Clock, Undo2, X } from 'lucide-react';
import { istDateTime } from './adminApi';
import { DesiAvatar, DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, DesiMogra } from './desi';
import {
  CopyValue, CustomerCell, DateField, ErrorBox, ExportButton, FilterBar, ListSkeleton, LoadMore, SearchBox,
  StatusToggles, dayMs, formatPaise, usePaged, useUrlFilters, type Customer,
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

/* Guest-list colours: confirmed paid = peacock, free = lavender, waiting = gold, money back = rani. */
const SEAT: Record<string, { chip: 'tea' | 'gold' | 'lav' | 'rani' | 'grey'; label: string; ink: string; stub: string }> = {
  paid: { chip: 'tea', label: 'Paid', ink: '#0e7c86', stub: 'linear-gradient(160deg,#0e7c86,#4fb5bd)' },
  free: { chip: 'lav', label: 'Free', ink: '#6d4fd0', stub: 'linear-gradient(160deg,#6d4fd0,#a48cf0)' },
  pending: { chip: 'gold', label: 'Pending', ink: '#b45309', stub: 'linear-gradient(160deg,#f59e0b,#fbbf24)' },
  refund_requested: { chip: 'lav', label: 'Refund requested', ink: '#6d4fd0', stub: 'linear-gradient(160deg,#8a2b7d,#a48cf0)' },
  refunded: { chip: 'rani', label: 'Refunded', ink: '#d81b72', stub: 'linear-gradient(160deg,#d81b72,#f06ba5)' },
};
const seat = (status: string) => SEAT[status] ?? { chip: 'grey' as const, label: status, ink: '#6f5b6f', stub: 'linear-gradient(160deg,#6f5b6f,#a99aa9)' };

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
    <div className="hf-admin-operations hfa-stack">
      {applied.event && (
        <DesiCard tone="saffron" corner="marigold">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="hfa-eyebrow !text-[#5a1d00]">Bookings for one event</div>
              <h2 className="mt-1 font-['Nunito'] font-black leading-[1.05] text-[#3b1600] [overflow-wrap:anywhere]" style={{ fontSize: 'clamp(24px, 14px + 1.6vw, 40px)' }}>{event?.title ?? (list.phase === 'loading' ? '…' : 'Event')}</h2>
              {event && (
                <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-bold text-[#3b1600]">
                  <span className="inline-flex items-center gap-1"><CalendarDays className="h-4 w-4" />{event.starts_at ? istDateTime(event.starts_at) : 'No date'}</span>
                  <span>{event.price_paise ? formatPaise(event.price_paise) : 'Free'} a seat</span>
                  <a className="inline-flex min-h-[44px] items-center font-extrabold text-[#3b1600] underline underline-offset-2" href={`/admin/events/${encodeURIComponent(event.id)}`}>Edit event</a>
                </p>
              )}
            </div>
            <a href="/admin/bookings" className="hfa-btn ghost no-underline">
              <X className="h-4 w-4" /> All bookings
            </a>
          </div>
        </DesiCard>
      )}

      {totals && (
        <DesiKpis>
          <DesiKpi tone="plum" icon={<Users strokeWidth={2.2} />} label="Seats"
            value={<span>{totals.seats}{event?.capacity ? <span className="text-[0.5em] opacity-80"> / {event.capacity}</span> : null}</span>}
            sub={`${totals.paid_seats} paid · ${totals.free_seats} free`} />
          <DesiKpi tone="tea" icon={<IndianRupee strokeWidth={2.2} />} label="Revenue" value={formatPaise(totals.revenue_paise)} sub="Paid seats, refunds excluded" />
          <DesiKpi tone="gold" icon={<Clock strokeWidth={2.2} />} label="Pending" value={totals.pending} sub={totals.pending ? `${formatPaise(totals.pending_paise)} awaiting the bank` : 'Nothing waiting'} />
          <DesiKpi tone="rani" icon={<Undo2 strokeWidth={2.2} />} label="Refunded" value={totals.refunded} sub={`${totals.bookings} bookings in this view`} />
        </DesiKpis>
      )}

      <DesiCard tone="lav" corner="jasmine" pattern="dots">
        <FilterBar
          title="Filter bookings"
          count={count}
          onClear={clear}
          resultLabel="Show results"
          search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search bookings" placeholder="Name, email, phone last 4, UTR, event" />}
        >
          {filters}
        </FilterBar>
      </DesiCard>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="hfa-eyebrow" aria-live="polite">
          {list.phase === 'ready' ? `${totals?.bookings ?? list.items.length} booking${(totals?.bookings ?? list.items.length) === 1 ? '' : 's'}` : list.phase === 'loading' ? 'Loading…' : ''}
        </p>
        <ExportButton kind={applied.event ? 'bookings_event' : 'bookings'} path="/api/admin/v2/bookings" query={query} />
      </div>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load bookings.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <DesiCard tone="lav" corner="hibiscus">
            <DesiEmpty text={<><b>{applied.q || count ? 'No bookings match' : 'No bookings yet'}</b><br />{applied.q || count ? 'Try a different search or clear the filters.' : 'Seats appear here as soon as customers book.'}</>} />
          </DesiCard>
        ) : (
          <>
            {/* Desktop: the guest register */}
            <DesiCard title="Guest register" tone="cream" pattern="bahi" corner="marigold" className="hidden md:block">
              <div className="hfa-scroll">
                <table className="hfa-table min-w-[760px]">
                  <thead>
                    <tr><th>Customer</th><th>Event</th><th>Status</th><th className="text-right">Amount</th><th>UTR</th><th>Booked</th></tr>
                  </thead>
                  <tbody>
                    {list.items.map((b) => {
                      const S = seat(b.status);
                      return (
                        <tr key={b.id} style={{ boxShadow: `inset 5px 0 0 ${S.ink}` }}>
                          <td className="max-w-[260px] pl-4">
                            <div className="flex items-center gap-3">
                              <DesiAvatar name={b.customer.name} seed={b.customer.uid} size={40} />
                              <CustomerCell c={b.customer} />
                            </div>
                          </td>
                          <td className="max-w-[260px]">
                            <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="font-bold text-[var(--a-ink)] underline-offset-2 hover:underline">{b.event_title ?? b.listing_id}</a>
                            <div className="hfa-note">{b.event_starts_at ? istDateTime(b.event_starts_at) : 'No date'}</div>
                          </td>
                          <td><DesiChip tone={S.chip}>{S.label}</DesiChip></td>
                          <td className="text-right font-['Nunito'] text-[1.2em] font-black tabular-nums" style={{ color: S.ink }}>{amount(b)}</td>
                          <td>{b.utr ? <CopyValue value={b.utr} label="UTR" /> : <span className="text-[var(--a-muted)]">—</span>}</td>
                          <td className="whitespace-nowrap text-[var(--a-muted)]">{istDateTime(b.booked_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </DesiCard>

            {/* Phones: one ticket stub per seat */}
            <ul className="grid gap-3 md:hidden">
              {list.items.map((b) => {
                const S = seat(b.status);
                return (
                  <li key={b.id} className="relative flex overflow-hidden rounded-[22px] border border-[var(--a-line)] bg-white shadow-[var(--a-shadow)]">
                    <div className="flex w-[84px] shrink-0 flex-col items-center justify-center gap-2 px-2 py-3 text-center text-white" style={{ background: S.stub }}>
                      <DesiAvatar name={b.customer.name} seed={b.customer.uid} size={44} />
                      <span className="text-[14px] font-extrabold uppercase leading-tight">{S.label}</span>
                    </div>
                    <div className="min-w-0 flex-1 border-l-2 border-dashed border-[var(--a-line)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <CustomerCell c={b.customer} compact />
                        <div className="shrink-0 font-['Nunito'] text-[1.15rem] font-black tabular-nums" style={{ color: S.ink }}>{amount(b)}</div>
                      </div>
                      <a href={`/admin/bookings?event=${encodeURIComponent(b.listing_id)}`} className="mt-2 flex min-h-[44px] items-center font-bold text-[var(--a-ink)] underline-offset-2 hover:underline">{b.event_title ?? b.listing_id}</a>
                      <div className="hfa-note">{b.event_starts_at ? istDateTime(b.event_starts_at) : 'No date'}</div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-[var(--a-line)] pt-2 text-[14px] font-semibold text-[var(--a-muted)]">
                        <span>Booked {istDateTime(b.booked_at)}</span>
                        {b.utr && <CopyValue value={b.utr} label="UTR" className="text-[14px] text-foreground" />}
                      </div>
                    </div>
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
