// AgentBookingBox — the customer's side of an AI voice agent listing
// (`[AGENT-LIVE-1]`, BUILD SPEC §6, D9). Duration chips → price → "Talk now"
// when the agent is free right now, else "Next free HH:MM" + "Pick a time"
// (a 7-day strip → the visitor's own free start times) → the existing guest
// email → Clerk gate → quote → book → `/talk/<bookingId>`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClerkIsland, requireGuestAuth } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import { inr } from '../../lib/money';
import { talkPath } from '../../lib/urls';
import { capture, captureException } from '../../lib/analytics';
import { ApiError, getAgentAvailability, getAgentPublic, postAgentBook, postAgentQuote } from '../../lib/agentLive';
import type { AgentPublic, AgentQuote } from '../../lib/agentLive';

export interface AgentBookingBoxProps {
  listingId: string;
}

function visitorTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

function fmtClock(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

function fmtDayChip(dateKey: string, tz: string): { top: string; bottom: string } {
  const d = new Date(`${dateKey}T00:00:00`);
  try {
    const top = new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: tz }).format(d);
    const bottom = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: tz }).format(d);
    return { top, bottom };
  } catch {
    return { top: dateKey, bottom: '' };
  }
}

function dayKeyInTz(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function nextDays(n: number, tz: string): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) out.push(dayKeyInTz(now + i * 86_400_000, tz));
  return out;
}

type Step = 'idle' | 'authing' | 'quoting' | 'booking';

function AgentBookingBoxInner({ listingId }: AgentBookingBoxProps) {
  const tz = useMemo(() => visitorTz(), []);
  const [agent, setAgent] = useState<AgentPublic | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [starts, setStarts] = useState<number[] | null>(null);
  const [startsLoading, setStartsLoading] = useState(false);
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [addTokensHref, setAddTokensHref] = useState<string | null>(null);

  const idempotencyKeyRef = useRef<string>('');
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = globalThis.crypto?.randomUUID?.() ?? `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    let cancelled = false;
    void getAgentPublic(listingId)
      .then((a) => {
        if (cancelled) return;
        setAgent(a);
        setMinutes(a.slotMinutes[0] ?? 10);
        capture('agent_listing_view', { agent_id: listingId });
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr('Could not load this agent.');
        captureException(e, { code: 'agent_public_load_failed', agent_id: listingId });
      });
    return () => { cancelled = true; };
  }, [listingId]);

  const price = agent && minutes != null ? minutes * agent.pricePerMin : null;

  const loadStartsFor = (dateKey: string) => {
    if (!agent || minutes == null) return;
    setStartsLoading(true);
    setSelectedStart(null);
    void getAgentAvailability(listingId, { minutes, day: dateKey, tz })
      .then((r) => setStarts(r.starts))
      .catch(() => setStarts([]))
      .finally(() => setStartsLoading(false));
  };

  const openPicker = () => {
    setShowPicker(true);
    const first = nextDays(7, tz)[0];
    setDay(first);
    loadStartsFor(first);
  };

  const runCheckout = async (opts: { instant: boolean; startsAt?: number }) => {
    if (!agent || minutes == null) return;
    setErr(null);
    setAddTokensHref(null);
    setStep('authing');
    try {
      // postAgentQuote/postAgentBook fetch their own token via
      // getActiveTokenWaited — this call's only job is to open the guest
      // email→Clerk gate when no session exists yet.
      await requireGuestAuth();
    } catch {
      setStep('idle');
      return;
    }

    setStep('quoting');
    let quote: AgentQuote;
    try {
      quote = await postAgentQuote(listingId, { minutes, instant: opts.instant, startsAt: opts.startsAt, tz });
      capture('agent_quote', { agent_id: listingId, minutes, instant: opts.instant, outcome: 'ok' });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      capture('agent_quote', { agent_id: listingId, minutes, instant: opts.instant, outcome: 'error', status });
      setStep('idle');
      setErr(
        status === 503
          ? 'This agent is not available to talk right now.'
          : 'Could not price this call. Please try again.',
      );
      return;
    }

    setStep('booking');
    const startedAt = Date.now();
    try {
      const result = await postAgentBook(listingId, { quote, idempotencyKey: idempotencyKeyRef.current });
      capture('agent_booking_created', { agent_id: listingId, minutes, instant: opts.instant, wait_s: Math.round((Date.now() - startedAt) / 1000) });
      location.assign(result.talkPath || talkPath(result.bookingId));
    } catch (e) {
      setStep('idle');
      if (e instanceof ApiError && e.status === 402) {
        const ret = `${location.pathname}${location.search}`;
        setAddTokensHref(`/tokens?return=${encodeURIComponent(ret)}`);
        setErr("You don't have enough tokens for this call.");
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { next_free_at?: number; error?: string } | undefined;
        capture('agent_seat_unavailable', {
          agent_id: listingId,
          next_free_in_s: body?.next_free_at ? Math.max(0, Math.round((body.next_free_at - Date.now()) / 1000)) : null,
        });
        if (body?.error === 'idempotency_conflict') {
          idempotencyKeyRef.current = globalThis.crypto?.randomUUID?.() ?? `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          setErr('That booking attempt conflicted — please try again.');
          return;
        }
        setErr('This slot was just taken. Refreshing availability…');
        void getAgentPublic(listingId).then(setAgent).catch(() => {});
        if (day) loadStartsFor(day);
        return;
      }
      captureException(e, { code: 'agent_book_failed', agent_id: listingId });
      setErr('Could not complete the booking. Please try again.');
    }
  };

  if (loadErr) {
    return <p className="font-body font-bold text-[14px] text-coral">{loadErr}</p>;
  }
  if (!agent || minutes == null) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner size={22} />
      </div>
    );
  }

  const busy = step !== 'idle';
  const chipBase =
    'rounded-zineBadge border-zine border-ink px-3.5 py-2 font-body font-bold text-[13px] transition-transform ' +
    'duration-zine ease-out active:translate-x-[1px] active:translate-y-[1px]';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-inkSoft">How long?</div>
        <div className="flex flex-wrap gap-2">
          {agent.slotMinutes.map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => { setMinutes(m); setStarts(null); setSelectedStart(null); }}
              className={[chipBase, minutes === m ? 'bg-lime text-ink shadow-zine-xs' : 'bg-card text-ink'].join(' ')}
            >
              {m} min
            </button>
          ))}
        </div>
      </div>

      {price != null && (
        <div className="flex items-baseline justify-between">
          <span className="font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-inkSoft">Price</span>
          <span className="font-display font-semibold text-[22px] text-ink">{inr(price)}</span>
        </div>
      )}

      {err && (
        <div className="rounded-zine border-zine border-coral bg-card p-3 font-body font-bold text-[13px] text-ink shadow-zine-error">
          {err}
          {addTokensHref && (
            <a href={addTokensHref} className="mt-2 block font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline">
              Add tokens →
            </a>
          )}
        </div>
      )}

      {agent.availableNow && !showPicker && (
        <Button
          variant="lime"
          fullWidth
          loading={busy}
          disabled={busy}
          label={busy ? 'Connecting…' : `Talk now · ${price != null ? inr(price) : ''}`}
          onClick={() => void runCheckout({ instant: true })}
        />
      )}

      {!agent.availableNow && !showPicker && (
        <div className="flex flex-col gap-2.5">
          <p className="font-body font-bold text-[13px] text-inkSoft">
            {agent.nextFreeAt != null ? `Next free ${fmtClock(agent.nextFreeAt, tz)}` : 'Not free right now'}
          </p>
          <Button variant="blue" fullWidth disabled={busy} label="Pick a time" onClick={openPicker} />
        </div>
      )}

      {(showPicker || (!agent.availableNow && showPicker)) && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {nextDays(7, tz).map((dk) => {
              const chip = fmtDayChip(dk, tz);
              return (
                <button
                  key={dk}
                  type="button"
                  disabled={busy}
                  onClick={() => { setDay(dk); loadStartsFor(dk); }}
                  className={[
                    'flex min-w-[56px] flex-none flex-col items-center rounded-zineField border-zine border-ink px-2.5 py-2',
                    day === dk ? 'bg-lime text-ink' : 'bg-card text-ink',
                  ].join(' ')}
                >
                  <span className="font-mono font-bold uppercase text-[10px] tracking-[0.06em]">{chip.top}</span>
                  <span className="font-body font-bold text-[13px]">{chip.bottom}</span>
                </button>
              );
            })}
          </div>

          {startsLoading ? (
            <div className="flex justify-center py-3">
              <Spinner size={20} />
            </div>
          ) : starts && starts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {starts.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => setSelectedStart(s)}
                  className={[chipBase, selectedStart === s ? 'bg-lime text-ink shadow-zine-xs' : 'bg-card text-ink'].join(' ')}
                >
                  {fmtClock(s, tz)}
                </button>
              ))}
            </div>
          ) : (
            <p className="font-body font-bold text-[13px] text-inkMute">No free times that day — try another.</p>
          )}

          <Button
            variant="lime"
            fullWidth
            loading={busy}
            disabled={busy || selectedStart == null}
            label={busy ? 'Booking…' : `Book · ${price != null ? inr(price) : ''}`}
            onClick={() => selectedStart != null && void runCheckout({ instant: false, startsAt: selectedStart })}
          />
        </div>
      )}

      <p className="font-body text-[11px] text-inkMute">
        Billed per minute for the slot you book. You&rsquo;re still charged for the full slot even if you leave early.
      </p>
    </div>
  );
}

export function AgentBookingBox(props: AgentBookingBoxProps) {
  return (
    <IslandBoundary island="agent-booking-box">
      <ClerkIsland>
        <AgentBookingBoxInner {...props} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default AgentBookingBox;
