/* Phase B — SlotPicker (the "pick" step).
 *
 * [WEB-COMM-PAY-1] Branches on listing.kind per
 * Specs/SPEC-2026-09-01-PAID-SESSION-PIPELINE-BUILD.md §3.1 — this is the fix
 * for the pipeline audit's break #1: every non-agent listing used to fall
 * through to the legacy creator-scoped /api/calendar/book lane, which knows
 * nothing about the listing's price or capacity and never creates the
 * commercial_entitlements row the session join gate later requires. A buyer
 * paid and then could not get in.
 *
 *   • kind === 'agent'      → AgentForm (unchanged) — POST /api/avavoice/bookings.
 *   • kind === 'live_event' → LiveTicket — no slot picking, the event has one
 *                             time; hands a `commercial` selection straight to
 *                             CommercialPayStep (POST /api/commercial/live/…).
 *   • kind === 'consult'    → ConsultSlots — real bookable slots, but the pick
 *                             becomes a `commercial` selection carrying
 *                             { start_at, end_at } as `slot` for
 *                             POST /api/commercial/consult/….
 *   • everything else       → CalendarSlots (unchanged legacy behaviour).
 *
 * The slots endpoint requires a session (requireUser). To keep PAGE LOAD
 * ungated (MASTER-PROMPT §4b) we do NOT auto-open the gate: when there is no
 * token yet we show a "See available times" button that calls `onNeedAuth()`
 * (the parent runs requireGuestAuth, then passes a token back down).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import type { Listing } from '../../lib/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { inrOrFree } from '../../lib/money';
import { capture } from '../../lib/analytics';
import type { BookSelection, CalendarSlot } from './types';
import { getListingAvailability } from '../../lib/availability';
import type { AvailabilitySlot, ListingAvailabilityResponse } from '../../lib/availability';

function fmtWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

function fmtWhenInZone(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return fmtWhen(ms);
  }
}

/** Date keys stay as calendar dates throughout this picker. Parsing a
 * YYYY-MM-DD string with `new Date()` would silently interpret it as UTC and
 * move the selected day for viewers west of UTC. */
function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function dateKeyFromMs(ms: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return dateKeyFromParts(value('year'), value('month'), value('day'));
  } catch {
    const date = new Date(ms);
    return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
}
function shiftDateKey(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
function monthKey(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(5, 7)}`;
}
function monthLabel(value: string): string {
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}
function monthDelta(value: string, amount: number): string {
  const [year, month] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthGrid(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const firstKey = dateKeyFromParts(year, monthNumber, 1);
  const from = shiftDateKey(firstKey, -first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => shiftDateKey(from, index));
}
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
function fmtDuration(start: number, end: number): string {
  const mins = Math.max(1, Math.round((end - start) / 60000));
  return mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h` : `${mins} min`;
}
function coinLabel(coins: number): string {
  return coins > 0 ? `${coins.toLocaleString()} Tokens` : 'Free';
}

export interface SlotPickerProps {
  listing: Listing;
  /** Session JWT if one already exists; null when anonymous. */
  token: string | null;
  /** Ask the parent to run the guest gate, resolving to a JWT. */
  onNeedAuth: () => Promise<string>;
  onSelect: (sel: BookSelection) => void;
}

export function SlotPicker({ listing, token, onNeedAuth, onSelect }: SlotPickerProps) {
  // [WEB-POSTHOG-1] §2.5 checkout_slot_pick — `ms_to_pick` measured from when
  // this step mounted (i.e. the buyer started looking at options).
  const mountedAtRef = useRef(Date.now());
  const wrappedOnSelect = useCallback(
    (sel: BookSelection) => {
      try {
        const slotId =
          sel.type === 'calendar' ? sel.slotId : sel.type === 'commercial' ? (sel.slot ? `${sel.slot.start_at}` : 'no-slot') : 'agent';
        capture('checkout_slot_pick', {
          slot_id: slotId,
          ms_to_pick: Date.now() - mountedAtRef.current,
        });
      } catch {
        /* best-effort */
      }
      onSelect(sel);
    },
    [onSelect],
  );

  const kind = listing.kind ?? '';
  if (kind === 'agent') return <AgentForm listing={listing} onSelect={wrappedOnSelect} />;
  if (kind === 'live_event') return <LiveTicket listing={listing} onSelect={wrappedOnSelect} />;
  if (kind === 'consult') return <ConsultSlots listing={listing} token={token} onNeedAuth={onNeedAuth} onSelect={wrappedOnSelect} />;
  return <CalendarSlots listing={listing} token={token} onNeedAuth={onNeedAuth} onSelect={wrappedOnSelect} />;
}

// ──────────────────────── [WEB-COMM-PAY-1] live ticket ───────────────────────
/** No slot picking — the event has one time. The buyer is choosing to attend,
 *  not to schedule (SPEC §3.1). Hands off a `commercial` selection so PayStep
 *  routes to CommercialPayStep → POST /api/commercial/live/:id/checkout. */
function LiveTicket({ listing, onSelect }: { listing: Listing; onSelect: (s: BookSelection) => void }) {
  const price = Math.trunc(Number(listing.price ?? listing.effective_price ?? 0));
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <p className="font-body font-bold text-[15px] text-inkSoft">
          Get your ticket for <span className="text-ink">{listing.title}</span>
          {listing.starts_at ? <> · {fmtWhen(listing.starts_at)}</> : null}.
        </p>
        <div className="flex items-center justify-between border-t-zine border-inkMute pt-3">
          <span className="font-display font-semibold text-[16px] text-ink">Ticket price</span>
          <Pill kind={price > 0 ? 'plain' : 'ok'}>{inrOrFree(price)}</Pill>
        </div>
        <Button
          variant="lime"
          fullWidth
          label="Continue"
          icon="→"
          onClick={() =>
            onSelect({
              type: 'commercial',
              kind: 'live_event',
              listingId: listing.id,
              title: listing.title,
              slot: null,
              requiredCoins: price,
            })
          }
        />
      </div>
    </Card>
  );
}

// ──────────────────── [WEB-COMM-PAY-1] consult (commercial) slots ───────────
/** Listing-aware public availability for the commercial consult lane. The
 *  pick becomes a `commercial` selection carrying the server's UTC interval
 *  for the paid-session checkout lane, per SPEC §3.1/§3.2. */
function ConsultSlots({ listing, token, onNeedAuth, onSelect }: SlotPickerProps) {
  // Availability is a public read. The auth gate remains in BookingFlow and
  // fires only after a buyer has chosen a genuinely available time.
  void token;
  void onNeedAuth;
  return <ConsultAvailability listing={listing} onSelect={onSelect} />;
}

function ConsultAvailability({ listing, onSelect }: { listing: Listing; onSelect: (s: BookSelection) => void }) {
  const loadGeneration = useRef(0);
  const [availability, setAvailability] = useState<ListingAvailabilityResponse | null>(null);
  const [viewMonth, setViewMonth] = useState(() => monthKey(dateKeyFromMs(Date.now(), browserTimezone())));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatingSlotId, setValidatingSlotId] = useState<string | null>(null);
  const timezone = browserTimezone();

  const grid = monthGrid(viewMonth);
  const from = grid[0];
  const to = grid[grid.length - 1];
  const load = useCallback(async (showSpinner = true) => {
    const generation=++loadGeneration.current;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const next = await getListingAvailability(listing.id, from, to, timezone);
      if(generation!==loadGeneration.current)return;
      setAvailability(next);
      setSelectedSlot((current) => {
        if (!current) return null;
        return next.slots.find((slot) => slot.id === current.id && slot.available) ?? null;
      });
    } catch (e) {
      if(generation!==loadGeneration.current)return;
      if (e instanceof ApiError) {
        setError(e.error || 'Could not load available times.');
      } else {
        setError('Could not load available times. Check your connection and try again.');
      }
      setAvailability(null);
      setSelectedDate(null);
      setSelectedSlot(null);
    } finally {
      if(generation===loadGeneration.current){setLoading(false);setRefreshing(false);}
    }
  }, [from, listing.id, to, timezone]);

  useEffect(() => {
    void load();
    return ()=>{loadGeneration.current++;};
  }, [load]);

  const availableSlots = useMemo(
    () => (availability?.slots ?? []).filter((slot) => slot.available && Number.isSafeInteger(Number(slot.start_at)) && Number(slot.end_at) > Number(slot.start_at)),
    [availability],
  );
  const availableByDate = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    const responseTimezone = availability?.timezone || timezone;
    for (const slot of availableSlots) {
      const key = dateKeyFromMs(Number(slot.start_at), responseTimezone);
      const slots = map.get(key) ?? [];
      slots.push(slot);
      map.set(key, slots);
    }
    return map;
  }, [availability, availableSlots, timezone]);
  const availableDates = useMemo(() => new Set(availableByDate.keys()), [availableByDate]);
  const activeDate = selectedDate && availableDates.has(selectedDate) ? selectedDate : null;
  const visibleSlots = activeDate ? availableByDate.get(activeDate) ?? [] : [];
  const responseTimezone = availability?.timezone || timezone;

  useEffect(() => {
    if (loading) return;
    if (activeDate) return;
    const first = [...availableDates].filter(date=>monthKey(date)===viewMonth).sort()[0] ?? null;
    setSelectedDate(first);
    setSelectedSlot(null);
  }, [activeDate, availableDates, loading, viewMonth]);

  function moveMonth(amount: number) {
    setAvailability(null);
    setViewMonth((month) => monthDelta(month, amount));
    setSelectedDate(null);
    setSelectedSlot(null);
  }

  async function chooseSlot(slot: AvailabilitySlot) {
    if (validatingSlotId || refreshing || loading || !slot.available) return;
    setValidatingSlotId(slot.id);
    setError(null);
    try {
      // Re-read the same range immediately before checkout selection. The
      // checkout endpoint still owns the final atomic conflict check, but this
      // avoids handing an obviously stale slot into the payment step.
      const fresh = await getListingAvailability(listing.id, from, to, timezone);
      setAvailability(fresh);
      const current = fresh.slots.find(
        (candidate) => candidate.id === slot.id && candidate.available
          && Number(candidate.start_at) === Number(slot.start_at)
          && Number(candidate.end_at) === Number(slot.end_at),
      );
      if (!current) {
        setSelectedSlot(null);
        setError('That time is no longer available. The calendar has been refreshed.');
        return;
      }
      setSelectedSlot(current);
      onSelect({
        type: 'commercial',
        kind: 'consult_1to1',
        listingId: listing.id,
        title: listing.title,
        slot: { id: current.id, start_at: Number(current.start_at), end_at: Number(current.end_at) },
        requiredCoins: Math.trunc(Number(listing.price ?? listing.effective_price ?? 0)),
      });
    } catch (e) {
      setSelectedSlot(null);
      setError(e instanceof ApiError ? e.error || 'Could not verify that time.' : 'Could not verify that time. Try again.');
    } finally {
      setValidatingSlotId(null);
    }
  }

  const cardClass = 'rounded-zine border-zine border-ink bg-card px-4 py-3 shadow-zine-sm';

  if (loading && !availability) {
    return (
      <Card>
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <Spinner size={22} />
          <span className="font-body font-bold text-[15px] text-inkSoft">Loading available times…</span>
        </div>
      </Card>
    );
  }

  if (error && !availability) {
    return (
      <Card fillClassName="bg-paper2">
        <p className="font-body font-bold text-[15px] text-coral" role="alert">⚠ {error}</p>
        <div className="mt-3"><Button variant="blue" label="Try again" onClick={() => void load()} /></div>
      </Card>
    );
  }

  if (!availability) return null;

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-inkSoft">Choose a time</p>
            <p className="mt-1 font-body text-[13px] font-bold text-inkSoft">Times shown in {responseTimezone}.</p>
          </div>
          <button type="button" className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-blueInk underline" onClick={() => { setRefreshing(true); void load(false); }} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="rounded-zine border-zine border-ink bg-paper2 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" aria-label="Previous month" disabled={!!validatingSlotId} className="h-8 w-8 rounded-full border-zine border-ink bg-card font-display text-[20px] leading-none" onClick={() => moveMonth(-1)}>‹</button>
            <span className="font-display text-[16px] font-semibold uppercase">{monthLabel(viewMonth)}</span>
            <button type="button" aria-label="Next month" disabled={!!validatingSlotId} className="h-8 w-8 rounded-full border-zine border-ink bg-card font-display text-[20px] leading-none" onClick={() => moveMonth(1)}>›</button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-1 text-center font-mono text-[10px] font-bold uppercase text-inkSoft" aria-hidden="true">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((dateKey) => {
              const inMonth = monthKey(dateKey) === viewMonth;
              const count = availableByDate.get(dateKey)?.length ?? 0;
              const selected = dateKey === activeDate;
              return (
                <button
                  key={dateKey}
                  type="button"
                  disabled={loading || refreshing || !inMonth || count === 0}
                  aria-label={`${dateKey}${count ? `, ${count} available` : ', unavailable'}`}
                  aria-pressed={selected}
                  onClick={() => { setSelectedDate(dateKey); setSelectedSlot(null); }}
                  className={[
                    'min-h-9 rounded-md border-zine px-1 py-1 font-body text-[13px] font-extrabold transition-colors',
                    selected ? 'border-ink bg-coral text-paper' : count ? 'border-ink bg-card text-ink hover:bg-lime' : 'border-transparent bg-transparent text-inkMute',
                    !inMonth || count === 0 ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                  ].join(' ')}
                >
                  {Number(dateKey.slice(-2))}
                  {count > 0 && <span className="mx-auto mt-0.5 block h-1 w-1 rounded-full bg-coral" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>

        {availableSlots.length === 0 && (
          <p className="font-body text-[14px] font-bold text-inkSoft">No available times in this window. Try another month or refresh later.</p>
        )}

        {error && <p className="font-body text-[14px] font-bold text-coral" role="alert">⚠ {error}</p>}

        {activeDate && visibleSlots.length > 0 ? (
          <div className="flex flex-col gap-2" aria-label={`Available times on ${activeDate}`}>
            {visibleSlots.map((slot) => {
              const selected = selectedSlot?.id === slot.id;
              const checking = validatingSlotId === slot.id;
              return (
                <button key={slot.id} type="button" className={`${cardClass} text-left transition-colors ${selected ? 'bg-lime' : 'hover:bg-paper2'} ${checking ? 'opacity-70' : ''}`} disabled={Boolean(validatingSlotId) || loading || refreshing} onClick={() => void chooseSlot(slot)}>
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-display text-[16px] font-semibold text-ink">{fmtWhenInZone(Number(slot.start_at), responseTimezone)}</span>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-inkSoft">{checking ? 'Checking…' : selected ? 'Selected' : 'Available'}</span>
                  </span>
                  <span className="mt-1 block font-body text-[13px] font-bold text-inkSoft">{fmtDuration(Number(slot.start_at), Number(slot.end_at))}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="font-body text-[14px] font-bold text-inkSoft">Choose a date with available times.</p>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────────── calendar slots (legacy) ───────────────────────
function CalendarSlots({ listing, token, onNeedAuth, onSelect }: SlotPickerProps) {
  return (
    <CreatorSlotList
      listing={listing}
      token={token}
      onNeedAuth={onNeedAuth}
      onPick={(s) =>
        onSelect({
          type: 'calendar',
          slotId: s.id,
          title: s.title,
          startAt: s.start_at,
          endAt: s.end_at,
          requiredCoins: Math.trunc(Number(s.price_coins || 0)),
        })
      }
    />
  );
}

// ───────────────────── shared: GET /api/calendar/slots?host=… ────────────────
/** The slot-loading + gate + list rendering shared by the legacy calendar lane
 *  and the new commercial consult lane. Only what happens on pick differs. */
function CreatorSlotList({
  listing,
  token,
  onNeedAuth,
  onPick,
}: {
  listing: Listing;
  token: string | null;
  onNeedAuth: () => Promise<string>;
  onPick: (slot: CalendarSlot) => void;
}) {
  const creatorId = listing.creator?.id ?? '';
  const [slots, setSlots] = useState<CalendarSlot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(token);

  const load = useCallback(
    async (jwt: string) => {
      setLoading(true);
      setError(null);
      try {
        const r = await request<{ slots: CalendarSlot[] }>('/api/calendar/slots', {
          auth: jwt,
          query: { host: creatorId },
        });
        setSlots(r.slots ?? []);
      } catch (e) {
        setError(e instanceof ApiError ? e.error : 'Could not load available times.');
        setSlots([]);
      } finally {
        setLoading(false);
      }
    },
    [creatorId],
  );

  useEffect(() => {
    if (authToken) void load(authToken);
  }, [authToken, load]);

  async function reveal() {
    try {
      const jwt = authToken ?? (await onNeedAuth());
      setAuthToken(jwt);
    } catch {
      /* gate cancelled — stay put */
    }
  }

  if (!authToken) {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <p className="font-body font-bold text-[15px] text-inkSoft">
            Pick a time with <span className="text-ink">{listing.creator?.name ?? 'the creator'}</span>. We’ll
            ask for your email next so we can send your confirmation.
          </p>
          <Button variant="lime" label="See available times" icon="→" onClick={reveal} />
        </div>
      </Card>
    );
  }

  if (loading && !slots) {
    return (
      <div className="flex items-center gap-3 p-4">
        <Spinner size={22} />
        <span className="font-body font-bold text-[15px] text-inkSoft">Loading times…</span>
      </div>
    );
  }

  if (error) {
    return (
      <Card fillClassName="bg-paper2">
        <p className="font-body font-bold text-[15px] text-coral">⚠ {error}</p>
        <div className="mt-3">
          <Button variant="blue" label="Try again" onClick={() => void load(authToken)} />
        </div>
      </Card>
    );
  }

  const bookable = (slots ?? []).filter((s) => s.status === 'open' && s.booked_count < s.capacity);
  if (!bookable.length) {
    return (
      <Card fillClassName="bg-paper2">
        <p className="font-body font-bold text-[15px] text-inkSoft">
          No open times right now. Check back soon or follow the creator for new slots.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {bookable.map((s) => (
        <Card key={s.id} onClick={() => onPick(s)}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="font-display font-semibold text-[17px] text-ink">{fmtWhen(s.start_at)}</span>
              <span className="font-mono text-[14px] uppercase tracking-[0.06em] text-inkSoft font-bold">
                {fmtDuration(s.start_at, s.end_at)} · {s.title}
              </span>
            </div>
            <Pill kind={s.price_coins > 0 ? 'plain' : 'ok'}>{coinLabel(Math.trunc(Number(s.price_coins || 0)))}</Pill>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ─────────────────────────────── agent form ──────────────────────────────────
const LANGS = [
  ['en-US', 'English'],
  ['es-ES', 'Español'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['pt-BR', 'Português'],
  ['hi-IN', 'हिन्दी'],
] as const;

function AgentForm({ listing, onSelect }: { listing: Listing; onSelect: (s: BookSelection) => void }) {
  const [minutes, setMinutes] = useState('15');
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000); // default: +1h
    d.setSeconds(0, 0);
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16); // datetime-local value
  });
  const [language, setLanguage] = useState('en-US');

  const mins = Math.max(1, Math.trunc(Number(minutes) || 0));
  const scheduledAt = (() => {
    const t = new Date(when).getTime();
    return Number.isFinite(t) ? t : NaN;
  })();
  const valid = mins > 0 && Number.isFinite(scheduledAt) && scheduledAt > Date.now() - 60_000;

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <p className="font-body font-bold text-[15px] text-inkSoft">
          Schedule a voice session with <span className="text-ink">{listing.title}</span>. We’ll confirm by email.
        </p>
        <Field
          label="Minutes"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.replace(/\D/g, '').slice(0, 3))}
        />
        <label className="block">
          <span className="mb-2 block font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">
            When
          </span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="w-full rounded-zineField border-zine border-ink bg-card px-3.5 py-4 font-body font-extrabold text-[16px] text-ink shadow-zine-sm outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-2 block font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">
            Language
          </span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-zineField border-zine border-ink bg-card px-3.5 py-4 font-body font-extrabold text-[16px] text-ink shadow-zine-sm outline-none"
          >
            {LANGS.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="lime"
          fullWidth
          disabled={!valid}
          label="Continue"
          icon="→"
          onClick={() =>
            onSelect({
              type: 'agent',
              agentId: listing.id,
              minutes: mins,
              scheduledAt,
              language,
              title: listing.title,
              requiredCoins: null,
            })
          }
        />
      </div>
    </Card>
  );
}

export default SlotPicker;
