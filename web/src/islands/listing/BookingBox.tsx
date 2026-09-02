// [LIST-PAGE-2] The sticky booking box — SPEC-2026-09-01-LISTING-CONTENT-AND-
// BOOKING.md §D "the four join flows" + SPEC-2026-09-02 §3 per-type anatomy. A
// client island because seat quantity, slot selection and the live price
// breakdown are all interactive state that has to update before the buyer ever
// hits the server — the CTA itself is a plain link to /book/<id>, which is
// where guest checkout and payment actually happen (out of scope here, see the
// task brief: "Do NOT touch checkout/**").
import { useEffect, useMemo, useState } from 'react';
import { inrOrFree, priceBreakdown } from '../../lib/money';
import { bookingBox, calendarCopy, cta, freeBox } from '../../lib/copy';
import { capture } from '../../lib/analytics';
import type { ListingSlot } from '../../lib/types';

export interface BookingBoxProps {
  listingId: string;
  kind: string;
  isLive: boolean;
  isFreeEntry: boolean;
  price: number | null;
  maxPerBooking: number;
  watching: number | null;
  seatsLeft: number | null;
  freeSpotsLeft: number | null;
  startsAtLabel: string | null;
  startsAtMs: number | null;
  timezone: string | null;
  /** null = slots API is 503-gated off right now; [] = fetched, none exist. */
  slots: ListingSlot[] | null;
  joinLeadMinutes: number | null;
  /** [LIST-CONTENT-2] 0=Sun..6=Sat, only meaningful when scheduleMode is 'recurring'. */
  recurrenceDays?: number[] | null;
  scheduleMode?: string | null;
}

function fmtSlotTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// ─────────────────────────── month calendar ────────────────────────────────
// [LIST-PAGE-2 gap 1] Comp: design/live-streaming/avaTOK Listing Details.dc.html
// :241-261 — "SEPTEMBER 2026" with ‹ › nav, S M T W T F S header, today/selected
// filled red, dots under show days, "● = SHOW DAY · EVERY FRIDAY" legend.

const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function dateLabel(d: Date): string {
  return `${DAY_ABBR[d.getDay()]} ${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

interface CalendarCell {
  date: Date;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasDot: boolean;
}

/** Builds a 6x7 grid for `viewMonth` (any Date within the target month). */
function buildMonthCells(viewMonth: Date, isShowDay: (d: Date) => boolean, selected: Date | null, today: Date): CalendarCell[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay()); // back up to Sunday
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({
      date: d,
      inMonth: d.getMonth() === viewMonth.getMonth(),
      isToday: sameDay(d, today),
      isSelected: !!selected && sameDay(d, selected),
      hasDot: isShowDay(d),
    });
  }
  return cells;
}

function MonthCalendar({
  showDates, recurrenceDays, scheduleMode, selected, onSelect,
}: {
  showDates: Date[];
  recurrenceDays?: number[] | null;
  scheduleMode?: string | null;
  selected: Date | null;
  onSelect: (d: Date) => void;
}) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [viewMonth, setViewMonth] = useState(() => startOfDay(selected ?? showDates[0] ?? today));

  const showDateKeys = useMemo(
    () => new Set(showDates.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)),
    [showDates],
  );
  const isRecurring = scheduleMode === 'recurring' && !!recurrenceDays && recurrenceDays.length > 0;

  function isShowDay(d: Date): boolean {
    if (showDateKeys.size > 0) return showDateKeys.has(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    if (isRecurring) return recurrenceDays!.includes(d.getDay());
    return false;
  }

  const cells = useMemo(() => buildMonthCells(viewMonth, isShowDay, selected, today), [viewMonth, showDateKeys, recurrenceDays, selected, today]);

  const legendSuffix = isRecurring ? calendarCopy.every(recurrenceDays!.map((n) => DAY_NAMES[n]).join(' & ')) : null;

  const navBtn: React.CSSProperties = {
    width: 26, height: 26, borderRadius: '50%', border: '2px solid #161614', background: '#fdf1d3',
    cursor: 'pointer', fontWeight: 700, fontSize: '0.8125rem', display: 'grid', placeItems: 'center', padding: 0,
  };

  return (
    <div style={{ border: '2px solid #161614', borderRadius: 16, background: '#f6e4cd', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <button
          type="button"
          aria-label="Previous month"
          style={navBtn}
          onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontWeight: 400, fontSize: '0.9375rem', textTransform: 'uppercase', letterSpacing: '.03em', wordSpacing: '.1em' }}>
          {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
        </span>
        <button
          type="button"
          aria-label="Next month"
          style={navBtn}
          onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 4 }}>
        {DOW_LABELS.map((w, i) => (
          <span key={i} style={{ fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.625rem', color: '#8c6a52', textAlign: 'center' }}>
            {w}
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
        {cells.map((c, i) => {
          const filled = c.isSelected || c.isToday;
          return (
            <button
              key={i}
              type="button"
              disabled={!c.inMonth}
              onClick={() => onSelect(c.date)}
              style={{
                height: 28, display: 'grid', placeItems: 'center', borderRadius: 8, position: 'relative',
                border: 'none', background: filled ? '#d93825' : 'transparent',
                cursor: c.inMonth ? 'pointer' : 'default', padding: 0,
                opacity: c.inMonth ? 1 : 0.3,
              }}
            >
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: filled ? '#fdf1d3' : '#161614' }}>{c.date.getDate()}</span>
              {c.hasDot && !filled && (
                <span style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', width: 4, height: 4, borderRadius: '50%', background: '#d93825' }} />
              )}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 8, fontFamily: 'Nunito, system-ui, sans-serif', fontWeight: 800, fontSize: '0.625rem', letterSpacing: '.08em', color: '#8c6a52' }}>
        {calendarCopy.showDayLegend(legendSuffix)}
      </div>
    </div>
  );
}

export default function BookingBox({
  listingId, kind, isLive, isFreeEntry, price, maxPerBooking, watching, seatsLeft,
  freeSpotsLeft, startsAtLabel, startsAtMs, timezone, slots, joinLeadMinutes,
  recurrenceDays, scheduleMode,
}: BookingBoxProps) {
  const [qty, setQty] = useState(1);
  const cap = Math.max(1, maxPerBooking || 4);

  // [LIST-PAGE-2 gap 1] Show days = slots' dates (if slots exist) else the
  // listing's own starts_at, else a recurring weekday expanded over whichever
  // month the calendar is showing (handled inside MonthCalendar itself).
  const allSlots = slots ?? [];
  const showDates = useMemo(
    () => (allSlots.length > 0 ? allSlots.map((s) => new Date(s.starts_at)) : startsAtMs != null ? [new Date(startsAtMs)] : []),
    [allSlots, startsAtMs],
  );
  const showCalendar = !isFreeEntry && kind !== 'agent' && (showDates.length > 0 || (scheduleMode === 'recurring' && !!recurrenceDays?.length));

  const [selectedDate, setSelectedDate] = useState<Date | null>(() => {
    const today = startOfDay(new Date());
    const upcoming = showDates.map(startOfDay).filter((d) => d.getTime() >= today.getTime()).sort((a, b) => a.getTime() - b.getTime());
    return upcoming[0] ?? null;
  });

  const openSlots = useMemo(() => allSlots.filter((s) => s.status === 'open'), [allSlots]);
  const dateFilteredSlots = useMemo(() => {
    if (!selectedDate || openSlots.length === 0) return openSlots;
    return openSlots.filter((s) => sameDay(new Date(s.starts_at), selectedDate));
  }, [openSlots, selectedDate]);

  const [slotId, setSlotId] = useState<string | null>(dateFilteredSlots[0]?.id ?? openSlots[0]?.id ?? null);
  const visibleSlots = showCalendar ? dateFilteredSlots : openSlots;

  // Keep the selected slot in sync with whichever list is visible — picking a
  // new calendar day must re-point the CTA at a slot that's actually shown.
  useEffect(() => {
    if (!visibleSlots.some((s) => s.id === slotId)) {
      setSlotId(visibleSlots[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSlots]);

  const breakdown = !isFreeEntry ? priceBreakdown((price ?? 0) * qty) : null;
  const bookHref = `/book/${encodeURIComponent(listingId)}${slotId ? `?slot=${encodeURIComponent(slotId)}&qty=${qty}` : `?qty=${qty}`}`;

  const fireCta = (name: string) => capture('listing_cta_click', { cta: name, listing_id: listingId });

  const wrap: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'Nunito, system-ui, sans-serif',
  };
  const stepperBtn: React.CSSProperties = {
    width: 40, height: 40, borderRadius: '50%', border: '2px solid #161614', background: '#fdf1d3',
    fontWeight: 900, fontSize: '1.1rem', color: '#161614', cursor: 'pointer', flex: 'none',
  };

  const slotHeadLabel = showCalendar
    ? (selectedDate ? calendarCopy.pickASlotOn(dateLabel(selectedDate)) : calendarCopy.pickDateFirst)
    : bookingBox.pickASlot;

  return (
    <div style={wrap}>
      {(isLive || startsAtLabel) && (
        <div style={{
          borderRadius: 16, padding: '12px 16px', background: isLive ? '#d93825' : '#161614',
          color: '#fdf1d3', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <span style={{ fontWeight: 900, fontSize: '0.8125rem', letterSpacing: '.06em' }}>
            {isLive ? bookingBox.liveNow : startsAtLabel}
          </span>
          {isLive && watching != null && (
            <span style={{ fontWeight: 800, fontSize: '0.75rem', letterSpacing: '.05em' }}>{bookingBox.watchingNow(watching)}</span>
          )}
        </div>
      )}

      {timezone && (
        <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, color: '#5a5a54' }}>
          Your time zone shown · host is on {timezone}
        </p>
      )}

      {showCalendar && (
        <MonthCalendar
          showDates={showDates}
          recurrenceDays={recurrenceDays}
          scheduleMode={scheduleMode}
          selected={selectedDate}
          onSelect={(d) => {
            setSelectedDate(d);
            capture('listing_calendar_date_select', { listing_id: listingId, kind });
          }}
        />
      )}

      {!isFreeEntry && (visibleSlots.length > 0 || showCalendar) && (
        <div>
          <div style={{ fontWeight: 900, fontSize: '0.6875rem', letterSpacing: '.08em', marginBottom: 8, color: '#161614' }}>
            {slotHeadLabel}
          </div>
          {visibleSlots.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {visibleSlots.map((s) => {
                const full = s.booked_count >= s.capacity;
                const active = slotId === s.id;
                const fillPct = s.capacity > 0 ? Math.min(100, Math.round((s.booked_count / s.capacity) * 100)) : 0;
                const seatsLeftForSlot = Math.max(0, s.capacity - s.booked_count);
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={full}
                    onClick={() => setSlotId(s.id)}
                    className="ld-slot-card"
                    style={{
                      textAlign: 'left', flexDirection: 'column', alignItems: 'stretch', gap: 6,
                      borderColor: active ? '#d93825' : '#161614',
                      background: active ? '#fbe4df' : '#fff', color: '#161614',
                      fontWeight: 700, fontSize: '0.8125rem', cursor: full ? 'not-allowed' : 'pointer',
                      opacity: full ? 0.5 : 1,
                    }}
                  >
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{s.label ?? fmtSlotTime(s.starts_at)}</span>
                      <span style={{ fontWeight: 800, fontSize: '0.6875rem', color: full ? '#d93825' : '#8c6a52' }}>
                        {full ? 'FULL' : `${seatsLeftForSlot} LEFT`}
                      </span>
                    </span>
                    <span className="ld-slot-progress-track">
                      <span className="ld-slot-progress-fill" style={{ width: `${fillPct}%`, background: full ? '#d93825' : '#2d7180' }} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            showCalendar && selectedDate && (
              <p style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 700, color: '#8a8a80' }}>No slots on this day — pick another date.</p>
            )
          )}
        </div>
      )}

      {!isFreeEntry && kind !== 'consult' && (
        <div>
          <div style={{ fontWeight: 900, fontSize: '0.6875rem', letterSpacing: '.08em', marginBottom: 8, color: '#161614' }}>
            {bookingBox.howManySeats}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button type="button" style={stepperBtn} onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer seats">−</button>
            <span style={{ fontWeight: 900, fontSize: '1.25rem', minWidth: 24, textAlign: 'center' }}>{qty}</span>
            <button type="button" style={stepperBtn} onClick={() => setQty((q) => Math.min(cap, q + 1))} aria-label="More seats">+</button>
            {seatsLeft != null && (
              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', fontWeight: 700, color: '#5a5a54' }}>{seatsLeft} left</span>
            )}
          </div>
        </div>
      )}

      {isFreeEntry ? (
        <div style={{ borderTop: '1.5px solid rgba(22,22,20,.15)', paddingTop: 12 }}>
          <p style={{ margin: '0 0 10px', fontSize: '0.8125rem', fontWeight: 700, color: '#5a5a54' }}>
            {freeSpotsLeft === 0 ? freeBox.full : freeBox.hostPays}
          </p>
          {freeSpotsLeft != null && freeSpotsLeft > 0 && (
            <p style={{ margin: '0 0 10px', fontWeight: 900, fontSize: '0.75rem', letterSpacing: '.05em' }}>
              {freeBox.spotsLeft(freeSpotsLeft)}
            </p>
          )}
          <a
            href={freeSpotsLeft === 0 ? '#' : bookHref}
            aria-disabled={freeSpotsLeft === 0}
            onClick={() => freeSpotsLeft !== 0 && fireCta('reserve_free')}
            style={{
              display: 'block', textAlign: 'center', textDecoration: 'none', borderRadius: 100,
              border: '2px solid #161614', padding: '16px', fontWeight: 900, fontSize: '0.9375rem',
              letterSpacing: '.04em', background: freeSpotsLeft === 0 ? '#e8e2d0' : '#a7e05a',
              color: '#161614', pointerEvents: freeSpotsLeft === 0 ? 'none' : 'auto',
            }}
          >
            {freeSpotsLeft === 0 ? freeBox.full : bookingBox.reserveFree}
          </a>
        </div>
      ) : breakdown ? (
        <div style={{ borderTop: '1.5px solid rgba(22,22,20,.15)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Row label={kind === 'consult' ? 'Session' : `Ticket × ${qty}`} value={inrOrFree(breakdown.base)} />
          {breakdown.fee > 0 && <Row label="Platform fee (flat)" value={inrOrFree(breakdown.fee)} />}
          <Row label={`GST (${breakdown.gstRatePct}%)`} value={inrOrFree(breakdown.gst)} />
          <div style={{ height: 1, background: '#161614', margin: '4px 0' }} />
          <Row label="TOTAL" value={inrOrFree(breakdown.total)} bold />
          <a
            href={bookHref}
            onClick={() => fireCta(kind === 'consult' ? 'book_slot' : 'book_now')}
            style={{
              display: 'block', textAlign: 'center', textDecoration: 'none', borderRadius: 100,
              border: '2px solid #161614', padding: '16px', marginTop: 8, fontWeight: 900,
              fontSize: '0.9375rem', letterSpacing: '.04em', background: '#d93825', color: '#fdf1d3',
            }}
          >
            {kind === 'consult' ? cta.BOOK_SLOT : bookingBox.bookAndJoin(inrOrFree(breakdown.total))}
          </a>
        </div>
      ) : (
        <a
          href={bookHref}
          onClick={() => fireCta(kind === 'agent' ? 'talk_now' : 'book_now')}
          style={{
            display: 'block', textAlign: 'center', textDecoration: 'none', borderRadius: 100,
            border: '2px solid #161614', padding: '16px', fontWeight: 900, fontSize: '0.9375rem',
            letterSpacing: '.04em', background: '#d93825', color: '#fdf1d3',
          }}
        >
          {kind === 'agent' ? cta.TALK_NOW : cta.BOOK_NOW}
        </a>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {!isFreeEntry && <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, color: '#5a5a54' }}>{bookingBox.fees}</p>}
        {joinLeadMinutes != null && (
          <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 700, color: '#5a5a54' }}>
            link {joinLeadMinutes} min pehle aayega
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontWeight: bold ? 900 : 700, fontSize: bold ? '0.9375rem' : '0.8125rem', color: '#161614' }}>{label}</span>
      <span style={{ fontWeight: bold ? 900 : 700, fontSize: bold ? '0.9375rem' : '0.8125rem', color: '#161614' }}>{value}</span>
    </div>
  );
}
