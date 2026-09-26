/* AdminEvents — [ADMIN2-EVENTS 2026-09-26] /admin/events: every puja/havan Saa Thum runs.
 * Contract: Specs/SPEC-2026-09-26-ADMIN-2.md ("Events"). API: GET /api/admin/v2/events
 * (worker/src/routes/admin2_events.ts). Tabs are computed server-side from
 * lib/listing_schedule.ts, so this list and the customer dashboard never disagree
 * about whether a show is over. Tab / search / category sync to the URL.
 *
 * No Clerk provider here: AdminNav owns it; calls go through adminApi().
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, Copy, ExternalLink, Filter, MonitorPlay, Pencil, Plus, Search, SearchX, Ticket, Users, VideoOff, X,
} from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from '../../components/ui/sonner';
import { fmtDuration, fmtIstDateTime, listingImage, ErrorState, EmptyState, Shimmer } from '../../components/dash2/shared';
import { adminApi, errMessage, formatPaise, isAbort } from './adminApi';
import { EVENT_TABS, eventsPath, statusMeta, type EventRow, type EventTab, type EventsListResponse, type EventsMeta } from './eventsApi';

const ALL = '__all';

function readUrl(): { tab: EventTab; q: string; cat: string } {
  if (typeof window === 'undefined') return { tab: 'upcoming', q: '', cat: '' };
  const u = new URL(window.location.href).searchParams;
  const t = u.get('tab') as EventTab | null;
  return { tab: EVENT_TABS.some((x) => x.key === t) ? (t as EventTab) : 'upcoming', q: u.get('q') ?? '', cat: u.get('cat') ?? '' };
}

export default function AdminEvents() {
  const init = useMemo(readUrl, []);
  const [tab, setTab] = useState<EventTab>(init.tab);
  const [q, setQ] = useState(init.q);
  const [qLive, setQLive] = useState(init.q);
  const [cat, setCat] = useState(init.cat);
  const [data, setData] = useState<EventsListResponse | null>(null);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounce the search box.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(qLive.trim()), 300);
    return () => window.clearTimeout(t);
  }, [qLive]);

  useEffect(() => {
    adminApi<EventsMeta>(eventsPath(undefined, 'meta')).then(setMeta).catch((e) => captureException(e, { where: 'admin2_events_meta' }));
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true); setError(null);
    try {
      const r = await adminApi<EventsListResponse>(eventsPath(), { query: { tab, q: q || undefined, cat: cat || undefined }, signal: ac.signal });
      setData(r);
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'admin2_events_list' });
      setError(errMessage(e));
    } finally {
      if (abortRef.current === ac) setLoading(false);
    }
  }, [tab, q, cat]);

  useEffect(() => { void load(); }, [load]);

  // URL sync (replaceState — filters are not history entries).
  useEffect(() => {
    const u = new URL(window.location.href);
    const set = (k: string, v: string) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k));
    set('tab', tab === 'upcoming' ? '' : tab); set('q', q); set('cat', cat);
    window.history.replaceState(null, '', u.toString());
  }, [tab, q, cat]);

  const catLabel = (id: string) => meta?.categories.find((c) => c.id === id)?.label ?? id;
  const filtered = !!(q || cat);

  return (
    <div className="flex flex-col gap-5">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as EventTab)}>
            <TabsList className="h-auto">
              {EVENT_TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
                  {t.key === 'live' && (data?.counts.live ?? 0) > 0 && <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />}
                  {t.label}
                  {data && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{data.counts[t.key] ?? 0}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={qLive}
              onChange={(e) => setQLive(e.target.value)}
              placeholder="Search title or id"
              aria-label="Search events"
              className="pl-9 pr-9"
            />
            {qLive && (
              <button type="button" onClick={() => setQLive('')} aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select value={cat || ALL} onValueChange={(v) => setCat(v === ALL ? '' : v)}>
            <SelectTrigger className="sm:w-52" aria-label="Filter by category">
              <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {(meta?.categories ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              {cat && !meta?.categories.some((c) => c.id === cat) && <SelectItem value={cat}>{cat}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>

      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-muted-foreground">
          <span>Filtered:</span>
          {q && <Badge variant="outline" className="gap-1">“{q}” <button type="button" aria-label="Remove search" onClick={() => setQLive('')}><X className="h-3 w-3" /></button></Badge>}
          {cat && <Badge variant="outline" className="gap-1">{catLabel(cat)} <button type="button" aria-label="Remove category" onClick={() => setCat('')}><X className="h-3 w-3" /></button></Badge>}
        </div>
      )}

      {/* Body */}
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : loading && !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <Shimmer key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : data && data.items.length === 0 ? (
        filtered ? (
          <EmptyState icon={<SearchX className="h-6 w-6" />} title="No events match"
            body="Try a different word, or clear the category."
            action={<Button variant="outline" onClick={() => { setQLive(''); setCat(''); }}>Clear filters</Button>} />
        ) : (
          <EmptyState icon={<CalendarDays className="h-6 w-6" />} title={emptyTitle(tab)} body={emptyBody(tab)}
            action={tab === 'upcoming' || tab === 'drafts'
              ? <Button asChild><a href="/admin/events/new"><Plus /> New event</a></Button>
              : undefined} />
        )
      ) : (
        <ul className={cn('flex flex-col gap-3 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {data?.items.map((ev) => <EventCard key={ev.id} ev={ev} />)}
          {data && data.items.length >= 200 && (
            <li className="text-center text-[13px] font-semibold text-muted-foreground">Showing the first 200. Search or filter to narrow down.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function emptyTitle(tab: EventTab): string {
  return { upcoming: 'No upcoming events', live: 'Nothing is live right now', past: 'No past events yet', drafts: 'No drafts', cancelled: 'No cancelled events' }[tab];
}
function emptyBody(tab: EventTab): string {
  return {
    upcoming: 'Create a puja or havan and publish it to open bookings.',
    live: 'Events show here from their start time until they end.',
    past: 'Finished events land here.',
    drafts: 'Saved but not published events wait here.',
    cancelled: 'Events you cancel (with their refunds) are listed here.',
  }[tab];
}

function EventCard({ ev }: { ev: EventRow }) {
  const st = statusMeta(ev.status, ev.tab);
  const img = listingImage(ev.image_url, 320);
  const publicUrl = ev.book_url;
  const seats = ev.capacity ? `${ev.seats_booked} / ${ev.capacity}` : `${ev.seats_booked}`;

  async function copyLink() {
    const url = `${window.location.origin}${publicUrl}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied', { description: url });
      capture('admin2_event_link_copied', { listing_id: ev.id });
    } catch {
      toast.error('Could not copy. Long-press the View on site button instead.');
    }
  }

  return (
    <li className="dash-surface overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex gap-3 p-3 sm:gap-4 sm:p-4">
        <a href={`/admin/events/${encodeURIComponent(ev.id)}`} className="relative block h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-24 sm:w-32" aria-label={`Edit ${ev.title}`}>
          {img ? <img src={img} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center text-[11px] font-bold text-muted-foreground">No image</span>}
          {ev.tab === 'live' && (
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-destructive-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive-foreground" aria-hidden="true" />Live
            </span>
          )}
        </a>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <a href={`/admin/events/${encodeURIComponent(ev.id)}`} className="min-w-0 font-dash text-[16px] font-bold leading-snug text-grand-teal no-underline hover:underline sm:text-[17px]">
              <span className="line-clamp-2">{ev.title || 'Untitled event'}</span>
            </a>
            <span className="shrink-0 font-dash text-[16px] font-bold tabular-nums text-foreground">{formatPaise(ev.price_paise)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-semibold text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{fmtIstDateTime(ev.starts_at)}</span>
            {ev.duration_min ? <span>{fmtDuration(ev.duration_min)}</span> : null}
            <span className="inline-flex items-center gap-1" title="Seats booked"><Users className="h-3.5 w-3.5" aria-hidden="true" />{seats}</span>
            {ev.pending_payments > 0 && <span className="text-accent">+{ev.pending_payments} paying</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={st.variant}>{st.label}</Badge>
            {(ev.category_label || ev.category) && <Badge variant="outline">{ev.category_label ?? ev.category}</Badge>}
            {ev.deity && <Badge variant="muted">{ev.deity}</Badge>}
            <span
              className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold', ev.youtube_set ? 'bg-accent/15 text-accent' : 'bg-muted text-muted-foreground')}
              title={ev.youtube_set ? 'YouTube link set' : 'No YouTube link yet'}
            >
              {ev.youtube_set ? <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" /> : <VideoOff className="h-3.5 w-3.5" aria-hidden="true" />}
              <span className="sr-only sm:not-sr-only">{ev.youtube_set ? 'Video set' : 'No video'}</span>
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-muted/40 px-2 py-1.5 sm:px-3">
        <Button asChild variant="ghost" size="sm"><a href={`/admin/events/${encodeURIComponent(ev.id)}`}><Pencil /> Edit</a></Button>
        <Button variant="ghost" size="sm" onClick={() => void copyLink()}><Copy /> Copy link</Button>
        <Button asChild variant="ghost" size="sm"><a href={publicUrl} target="_blank" rel="noopener"><ExternalLink /> View on site</a></Button>
        <Button asChild variant="ghost" size="sm"><a href={`/admin/bookings?event=${encodeURIComponent(ev.id)}`}><Ticket /> Bookings</a></Button>
      </div>
    </li>
  );
}
