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
import { useCallback, useEffect, useState } from 'react';
import { request, ApiError } from '../../lib/apiClient';
import type { Listing } from '../../lib/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { inrOrFree } from '../../lib/money';
import type { BookSelection, CalendarSlot } from './types';

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
  const kind = listing.kind ?? '';
  if (kind === 'agent') return <AgentForm listing={listing} onSelect={onSelect} />;
  if (kind === 'live_event') return <LiveTicket listing={listing} onSelect={onSelect} />;
  if (kind === 'consult') return <ConsultSlots listing={listing} token={token} onNeedAuth={onNeedAuth} onSelect={onSelect} />;
  return <CalendarSlots listing={listing} token={token} onNeedAuth={onNeedAuth} onSelect={onSelect} />;
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
/** Same bookable-slot list as the legacy CalendarSlots, but the pick becomes a
 *  `commercial` selection carrying the slot for the paid-session checkout
 *  lane, per SPEC §3.1/§3.2. */
function ConsultSlots({ listing, token, onNeedAuth, onSelect }: SlotPickerProps) {
  return (
    <CreatorSlotList
      listing={listing}
      token={token}
      onNeedAuth={onNeedAuth}
      onPick={(s) =>
        onSelect({
          type: 'commercial',
          kind: 'consult_1to1',
          listingId: listing.id,
          title: s.title || listing.title,
          slot: { start_at: s.start_at, end_at: s.end_at },
          requiredCoins: Math.trunc(Number(listing.price ?? listing.effective_price ?? s.price_coins ?? 0)),
        })
      }
    />
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
