/* Phase B — SlotPicker (the "pick" step).
 *
 * Two shapes depending on the listing kind:
 *   • agent  → a tiny "schedule a session" form (minutes + time + language),
 *              which books via POST /api/avavoice/bookings.
 *   • else   → real bookable slots from GET /api/calendar/slots?host=<creator>,
 *              booked via POST /api/calendar/book { slot_id }.
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
  return coins > 0 ? `${coins.toLocaleString()} AvaCoins` : 'Free';
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
  const isAgent = (listing.kind ?? '') === 'agent';
  if (isAgent) return <AgentForm listing={listing} onSelect={onSelect} />;
  return <CalendarSlots listing={listing} token={token} onNeedAuth={onNeedAuth} onSelect={onSelect} />;
}

// ───────────────────────────── calendar slots ────────────────────────────────
function CalendarSlots({
  listing,
  token,
  onNeedAuth,
  onSelect,
}: Omit<SlotPickerProps, never>) {
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
        <Card key={s.id} onClick={() =>
          onSelect({
            type: 'calendar',
            slotId: s.id,
            title: s.title,
            startAt: s.start_at,
            endAt: s.end_at,
            requiredCoins: Math.trunc(Number(s.price_coins || 0)),
          })
        }>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="font-display font-semibold text-[17px] text-ink">{fmtWhen(s.start_at)}</span>
              <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-inkSoft">
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
          <span className="mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
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
          <span className="mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">
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
