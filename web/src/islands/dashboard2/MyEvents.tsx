// My events — [DASH2-EVENTS 2026-09-25]. /dashboard/my-events.
// Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md, GET /api/me/events?scope=upcoming.
//
//  - The SERVER's `state` decides LIVE. The client clock is only used for the
//    countdown, corrected by the server's `now` (offset measured at fetch).
//  - A live event is the spotlight: the guarded YouTube player inline when the
//    event has a video, otherwise a join button to `join_url`.
//  - Re-polls every 30s while the tab is visible (Page Visibility API), and once
//    more as soon as a countdown reaches zero.
//  - dash2_join_click {event_id, seconds_from_start}.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, BellRing, CalendarDays, CalendarPlus, Clock, Flame, Loader2, Play, Radio, Ticket } from 'lucide-react';
import { capture } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  authedRequest, EmptyState, ErrorState, errorMessage, fmtDuration, fmtIstDateTime, listingImage, Shimmer,
  type EventItem, type EventsResponse,
} from '../../components/dash2/shared';
import { YouTubeGuardedPlayer, type GuardedPlayerHandle } from '../../components/dash2/YouTubeGuardedPlayer';

const POLL_MS = 30_000;
const GET_READY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

function secondsFromStart(item: EventItem, now: number): number | null {
  return item.starts_at != null ? Math.round((now - item.starts_at) / 1000) : null;
}
function trackJoin(item: EventItem, now: number, via: 'player' | 'link') {
  capture('dash2_join_click', {
    event_id: item.listing.id, order_id: item.order_id, state: item.state, via,
    seconds_from_start: secondsFromStart(item, now),
  });
}

// ─────────────────────────── .ics ───────────────────────────
function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
function downloadIcs(item: EventItem) {
  if (item.starts_at == null) return;
  const start = item.starts_at;
  const end = item.ends_at ?? start + (item.listing.duration_min ?? 60) * 60_000;
  const url = item.join_url ? new URL(item.join_url, location.origin).toString() : `${location.origin}/dashboard/my-events`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Saathum//My events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${item.order_id ?? item.listing.id}@saathum.com`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(item.listing.title)}`,
    `DESCRIPTION:${icsEscape(`Join your Saathum puja: ${url}`)}`,
    `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(item.listing.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${item.listing.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'saathum-event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  capture('dash2_add_to_calendar', { event_id: item.listing.id });
}

// ─────────────────────────── countdown ───────────────────────────
function FlipDigit({ ch }: { ch: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="d2-flip text-grand-cream">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={ch}
          initial={reduce ? false : { y: '-100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? undefined : { y: '100%', opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.2, 0.7, 0.3, 1] }}
          className="relative z-[1] block"
        >
          {ch}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
function FlipGroup({ value, label }: { value: number; label: string }) {
  const s = String(Math.max(0, value)).padStart(2, '0');
  return (
    <span className="flex flex-col items-center gap-1">
      <span className="flex gap-0.5 text-[22px] font-extrabold leading-none sm:text-[26px]">
        {s.split('').map((c, i) => <FlipDigit key={i} ch={c} />)}
      </span>
      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] [color:hsl(var(--accent-foreground,0_0%_100%)/0.75)]">{label}</span>
    </span>
  );
}
function Countdown({ startsAt, now }: { startsAt: number; now: number }) {
  const diff = startsAt - now;
  if (diff <= 0) {
    return <span className="inline-flex items-center gap-2 text-[15px] font-extrabold text-grand-cream"><Loader2 className="h-4 w-4 animate-spin" /> Starting now…</span>;
  }
  const totalS = Math.floor(diff / 1000);
  const d = Math.floor(totalS / 86400), h = Math.floor((totalS % 86400) / 3600), m = Math.floor((totalS % 3600) / 60), s = totalS % 60;
  if (diff > DAY_MS) {
    return (
      <span className="inline-flex items-baseline gap-1.5 text-grand-cream" aria-label={`Starts in ${d} days ${h} hours`}>
        <span className="text-[13px] font-bold uppercase tracking-[0.1em] [color:hsl(var(--accent-foreground,0_0%_100%)/0.8)]">Starts in</span>
        <span className="text-[24px] font-extrabold leading-none">{d}</span><span className="text-[13px] font-bold">{d === 1 ? 'day' : 'days'}</span>
        <span className="text-[24px] font-extrabold leading-none">{h}</span><span className="text-[13px] font-bold">{h === 1 ? 'hr' : 'hrs'}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5" role="timer" aria-label={`Starts in ${h} hours ${m} minutes`}>
      <FlipGroup value={h} label="hrs" />
      <span className="pt-1 text-[20px] font-extrabold text-grand-cream">:</span>
      <FlipGroup value={m} label="min" />
      <span className="pt-1 text-[20px] font-extrabold text-grand-cream">:</span>
      <FlipGroup value={s} label="sec" />
    </span>
  );
}

// ─────────────────────────── cards ───────────────────────────
function SankalpLine({ item }: { item: EventItem }) {
  const s = item.sankalp;
  if (!s?.name) return null;
  return (
    <p className="text-[13px] font-semibold text-muted-foreground">
      Sankalp in the name of <span className="font-extrabold text-foreground">{s.name}</span>
      {s.gotra ? <> · gotra <span className="font-extrabold text-foreground">{s.gotra}</span></> : null}
    </p>
  );
}

function LiveSpotlight({ item, now }: { item: EventItem; now: number }) {
  const playerRef = useRef<GuardedPlayerHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const vid = item.youtube_video_id;
  const img = listingImage(item.listing.image_url, 1280);
  const joinViaPlayer = () => {
    trackJoin(item, now, 'player');
    wrapRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    playerRef.current?.play();
  };
  return (
    <motion.article
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="relative overflow-hidden rounded-3xl border-2 border-primary/50 bg-card shadow-[var(--dash-shadow-lg,none)]"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-primary/10 to-transparent" />
      <div className="relative flex flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-3.5 rounded-full border border-primary/40 bg-primary/10 py-2 pl-4 pr-5 text-primary shadow-[var(--dash-shadow,none)]">
            <span className="d2-live-blip !h-[18px] !w-[18px]" aria-hidden="true" />
            <span className="text-[18px] font-extrabold tracking-[0.18em]">LIVE</span>
          </span>
          <Badge variant="secondary">{item.listing.category_label || item.listing.category}</Badge>
          <span className="text-[13px] font-bold text-muted-foreground">Started {fmtIstDateTime(item.starts_at)}</span>
        </div>
        <div>
          <h2 className="font-dash text-[22px] font-bold leading-[1.2] text-grand-teal sm:text-[28px]">{item.listing.title}</h2>
          {item.listing.deity && <p className="mt-1 text-[14px] font-bold text-primary">{item.listing.deity}</p>}
          <div className="mt-1"><SankalpLine item={item} /></div>
        </div>
        {vid ? (
          <div ref={wrapRef}>
            <YouTubeGuardedPlayer
              ref={playerRef}
              videoId={vid}
              title={item.listing.title}
              poster={img}
              className="shadow-[var(--dash-shadow-lg,none)]"
              onError={(code) => capture('dash2_replay_error', { event_id: item.listing.id, code, surface: 'live' })}
            />
          </div>
        ) : img ? (
          <div className="relative aspect-[21/9] overflow-hidden rounded-2xl">
            <img src={img} alt="" className="h-full w-full object-cover" />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-scrim/70 to-transparent" />
          </div>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {vid ? (
            <Button size="lg" onClick={joinViaPlayer} className="w-full rounded-full sm:w-auto"><Play className="fill-current" /> Event is live — join now</Button>
          ) : item.join_url ? (
            <Button asChild size="lg" className="w-full rounded-full sm:w-auto">
              <a href={item.join_url} onClick={() => trackJoin(item, now, 'link')}><Radio /> Event is live — join now <ArrowRight /></a>
            </Button>
          ) : (
            <p className="inline-flex items-center gap-2 text-[14px] font-bold text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Your join link will appear here in a moment…</p>
          )}
          {item.listing.duration_min ? <span className="text-[13px] font-bold text-muted-foreground">{fmtDuration(item.listing.duration_min)} session</span> : null}
        </div>
      </div>
    </motion.article>
  );
}

function PendingCard({ item }: { item: EventItem }) {
  const img = listingImage(item.listing.image_url, 640);
  return (
    <article className="flex gap-4 overflow-hidden rounded-2xl border border-dashed border-border bg-card p-4 shadow-[var(--dash-shadow,none)]">
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-muted sm:h-24 sm:w-24">
        {img ? <img src={img} alt="" className="h-full w-full object-cover opacity-80" /> : <Flame className="m-auto h-full w-8 text-grand-teal opacity-50" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="line-clamp-2 font-dash text-[16px] font-bold leading-[1.25]">{item.listing.title}</h3>
        <p className="text-[13px] font-semibold text-muted-foreground">{fmtIstDateTime(item.starts_at)}</p>
        <p className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-[13px] font-extrabold text-secondary-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Confirming your UPI payment…
        </p>
      </div>
    </article>
  );
}

function UpcomingCard({ item, now }: { item: EventItem; now: number }) {
  const [showPlayer, setShowPlayer] = useState(false);
  const img = listingImage(item.listing.image_url, 900);
  const diff = item.starts_at != null ? item.starts_at - now : null;
  const getReady = diff != null && diff <= GET_READY_MS;
  const vid = item.youtube_video_id;
  return (
    <article className={cn(
      'group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-[var(--dash-shadow,none)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[var(--dash-shadow-lg,none)] motion-reduce:transition-none motion-reduce:hover:translate-y-0',
      getReady ? 'border-primary/50 ring-2 ring-primary/15' : 'border-border/50 hover:border-border',
    )}>
      <div className="relative aspect-[16/9] overflow-hidden bg-muted">
        {img ? (
          <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-accent via-grand-teal to-grand-ink" />
        )}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-scrim/95 via-scrim/55 to-scrim/5" />
        <Badge variant="secondary" className="absolute left-3 top-3 border border-border/40">{item.listing.category_label || item.listing.category}</Badge>
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-grand-cream"><CalendarDays className="h-3.5 w-3.5" /> {fmtIstDateTime(item.starts_at)}</p>
          {item.starts_at != null && <Countdown startsAt={item.starts_at} now={now} />}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 font-dash text-[17px] font-bold leading-[1.25]">{item.listing.title}</h3>
        {item.listing.deity && <p className="text-[13px] font-bold text-primary">{item.listing.deity}</p>}
        <SankalpLine item={item} />
        {item.listing.duration_min ? <p className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground"><Clock className="h-3.5 w-3.5" /> {fmtDuration(item.listing.duration_min)}</p> : null}
        {getReady && (
          <div className="mt-2 space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
            <p className="flex items-start gap-2 text-[14px] font-bold text-foreground">
              <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              Get ready — your puja begins shortly. Sit somewhere quiet, light a diya if you can, and keep this page open.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadIcs(item)}><CalendarPlus /> Add to calendar</Button>
              {vid ? (
                <Button size="sm" variant="accent" onClick={() => { setShowPlayer((v) => !v); if (!showPlayer) trackJoin(item, now, 'player'); }}>
                  <Play className="fill-current" /> {showPlayer ? 'Hide player' : 'Open player'}
                </Button>
              ) : item.join_url ? (
                <Button asChild size="sm" variant="accent">
                  <a href={item.join_url} onClick={() => trackJoin(item, now, 'link')}>Open event page <ArrowRight /></a>
                </Button>
              ) : null}
            </div>
            {vid && showPlayer && (
              <YouTubeGuardedPlayer
                videoId={vid}
                title={item.listing.title}
                poster={img}
                onError={(code) => capture('dash2_replay_error', { event_id: item.listing.id, code, surface: 'upcoming' })}
              />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <Shimmer className="h-[280px] w-full rounded-3xl" />
      <div className="grid gap-5 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-border/40 bg-card">
            <Shimmer className="aspect-[16/9] rounded-none" />
            <div className="space-y-2.5 p-4"><Shimmer className="h-4 w-3/4" /><Shimmer className="h-3 w-1/3" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── screen ───────────────────────────
export default function MyEvents() {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async (silent: boolean) => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const sent = Date.now();
      const r = await authedRequest<EventsResponse>('/api/me/events', { query: { scope: 'upcoming' }, signal: ac.signal, timeoutMs: 20000 });
      if (ac.signal.aborted) return;
      // Server clock at the response's midpoint → skew for the countdown.
      const mid = sent + (Date.now() - sent) / 2;
      if (typeof r?.now === 'number') setOffset(r.now - mid);
      setData({ now: r?.now ?? Date.now(), items: r?.items ?? [] });
      setError(null);
    } catch (e) {
      if (ac.signal.aborted) return;
      // A failed background poll keeps what is on screen; only a first load shows the error.
      if (!silent) setError(errorMessage(e));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const tick = () => { if (document.visibilityState === 'visible') void load(true); };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tick); inflight.current?.abort(); };
  }, [load]);

  // 1s clock, skew-corrected.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + offset), 1000);
    setNow(Date.now() + offset);
    return () => window.clearInterval(id);
  }, [offset]);

  const items = data?.items ?? [];
  const live = useMemo(() => items.filter((i) => i.state === 'live'), [items]);
  const rest = useMemo(() => items.filter((i) => i.state !== 'live'), [items]);

  // A countdown that has reached zero while the server still says "upcoming" → ask again.
  const due = rest.some((i) => i.state === 'upcoming' && i.starts_at != null && i.starts_at <= now);
  const dueFetched = useRef(0);
  useEffect(() => {
    if (!due) return;
    if (Date.now() - dueFetched.current < 10_000) return;
    dueFetched.current = Date.now();
    void load(true);
  }, [due, now, load]);

  if (loading && !data) return <ListSkeleton />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void load(false)} />;
  if (!items.length) {
    return (
      <EmptyState
        icon={<Ticket className="h-6 w-6" />}
        title="No upcoming pujas yet"
        body="When you book a puja or havan it appears here, with a countdown and a join button when it goes live."
        action={<Button asChild><a href="/dashboard">Book a puja <ArrowRight /></a></Button>}
      />
    );
  }

  return (
    <div className="space-y-8 font-dashbody">
      {live.length > 0 && (
        <section className="space-y-5" aria-label="Live now">
          {live.map((i) => <LiveSpotlight key={i.order_id ?? i.listing.id} item={i} now={now} />)}
        </section>
      )}
      {rest.length > 0 && (
        <section className="space-y-4" aria-labelledby="coming-up">
          <h2 id="coming-up" className="font-dash text-[20px] font-bold text-grand-teal">Coming up</h2>
          <div className="grid gap-5 md:grid-cols-2">
            {rest.map((i) => i.state === 'pending_payment'
              ? <PendingCard key={i.payment_id ?? i.order_id ?? i.listing.id} item={i} />
              : <UpcomingCard key={i.order_id ?? i.listing.id} item={i} now={now} />)}
          </div>
        </section>
      )}
    </div>
  );
}
