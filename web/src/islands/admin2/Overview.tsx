// [ADMIN2-OVERVIEW 2026-09-26] Admin 2 home: KPI tiles, "Next events", quick actions.
// Data: GET /api/admin/v2/overview (worker/src/routes/admin2.ts). Money is paise.
// Mounted inside layouts/Admin2.astro — no Clerk provider here (AdminNav owns it).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalendarDays, CalendarRange, Ticket, IndianRupee, Undo2, Hourglass, Plus, Tags, RefreshCw, ArrowRight, Users,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Shimmer } from '../dashboard2/Shimmer';
import { cn } from '../../lib/utils';
import { captureException } from '../../lib/analytics';
import { adminApi, errMessage, formatPaise, istDay, istTime, AdminDeniedError } from './adminApi';

interface Kpis {
  events_today: number; events_7d: number; bookings_today: number; bookings_7d: number;
  revenue_today_paise: number; revenue_7d_paise: number; revenue_30d_paise: number;
  open_refunds: number; open_refunds_paise: number;
  pending_payments: number; pending_payments_paise: number; pending_review: number;
}
interface NextEvent {
  id: string; title: string; category_label: string | null; status: string; live: boolean;
  starts_at: number | null; duration_min: number | null; capacity: number | null; booked: number;
  price_paise: number; image_url: string | null; admin_url: string; public_url: string;
}
interface OverviewData { generated_at: number; kpis: Kpis; next_events: NextEvent[] }

const REFRESH_MS = 60_000;
const nf = new Intl.NumberFormat('en-IN');

function Tile({ icon: Icon, label, value, hint, href, tone = 'default' }: {
  icon: LucideIcon; label: string; value: string; hint?: string; href?: string; tone?: 'default' | 'alert';
}) {
  const body = (
    <Card className={cn('h-full transition-shadow', href && 'hover:shadow-md', tone === 'alert' && 'border-primary/60')}>
      <CardContent className="flex h-full flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', tone === 'alert' ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-accent')}>
            <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </span>
        </div>
        <div className="font-dash text-[28px] font-bold leading-none tracking-[0.01em] text-grand-teal sm:text-[30px]">{value}</div>
        {hint && <div className="text-[13px] font-semibold text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
  return href ? <a href={href} className="block no-underline">{body}</a> : body;
}

function TilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => <Shimmer key={i} className="h-[124px] rounded-xl" />)}
    </div>
  );
}

function LiveBadge() {
  return (
    <Badge variant="destructive" className="gap-1.5 uppercase">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive-foreground opacity-70 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive-foreground" />
      </span>
      Live
    </Badge>
  );
}

function EventRow({ ev }: { ev: NextEvent }) {
  const seats = ev.capacity != null ? `${nf.format(ev.booked)} / ${nf.format(ev.capacity)} booked` : `${nf.format(ev.booked)} booked`;
  return (
    <li>
      <a href={ev.admin_url} className="flex items-center gap-3 rounded-lg px-2 py-3 no-underline transition-colors hover:bg-muted sm:gap-4 sm:px-3">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border/50 bg-muted">
          {ev.image_url
            ? <img src={ev.image_url} alt="" loading="lazy" width={56} height={56} className="h-full w-full object-cover" />
            : <img src="/diya-logo.png" alt="" width={56} height={56} className="h-full w-full object-contain p-2" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {ev.live && <LiveBadge />}
            <span className="truncate font-dash text-[16px] font-bold text-foreground">{ev.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] font-semibold text-muted-foreground">
            <span>{ev.live ? 'Streaming now' : `${istDay(ev.starts_at)} · ${istTime(ev.starts_at)}`}</span>
            {ev.category_label && <span>{ev.category_label}</span>}
            <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{seats}</span>
          </div>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="font-dash text-[15px] font-bold text-foreground">{ev.price_paise ? formatPaise(ev.price_paise) : 'Free'}</div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </a>
    </li>
  );
}

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async (quiet = false) => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    if (!quiet) setLoading(true);
    try {
      const d = await adminApi<OverviewData>('/api/admin/v2/overview', { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setData(d); setError(null);
    } catch (e) {
      if (ctrl.signal.aborted || e instanceof AdminDeniedError) return;
      if (!quiet) setError(errMessage(e, "We couldn't load the overview. Please try again."));
      captureException(e, { where: 'admin2_overview' });
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); inflight.current?.abort(); };
  }, [load]);

  const k = data?.kpis;

  return (
    <div className="grid gap-6 sm:gap-8">
      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <Button asChild><a href="/admin/events/new" className="no-underline"><Plus />New event</a></Button>
        <Button asChild variant="outline">
          <a href="/admin/refunds" className="no-underline">
            <Undo2 />Open refunds
            {k && k.open_refunds > 0 && <Badge className="ml-1">{nf.format(k.open_refunds)}</Badge>}
          </a>
        </Button>
        <Button asChild variant="outline"><a href="/admin/prices" className="no-underline"><Tags />Set prices</a></Button>
      </div>

      {error && !data ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-5">
            <p className="text-[15px] font-semibold text-foreground">{error}</p>
            <Button variant="outline" onClick={() => void load()}><RefreshCw />Try again</Button>
          </CardContent>
        </Card>
      ) : loading && !data ? (
        <TilesSkeleton />
      ) : k ? (
        <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Tile icon={CalendarDays} label="Events today" value={nf.format(k.events_today)} href="/admin/events" />
          <Tile icon={CalendarRange} label="Next 7 days" value={nf.format(k.events_7d)} hint="Events, today included" href="/admin/events" />
          <Tile icon={Ticket} label="Bookings today" value={nf.format(k.bookings_today)} hint={`${nf.format(k.bookings_7d)} in the last 7 days`} href="/admin/bookings" />
          <Tile icon={IndianRupee} label="Revenue today" value={formatPaise(k.revenue_today_paise)} hint="Paid, GST included" href="/admin/payments" />
          <Tile icon={IndianRupee} label="Revenue 7 days" value={formatPaise(k.revenue_7d_paise)} href="/admin/payments" />
          <Tile icon={IndianRupee} label="Revenue 30 days" value={formatPaise(k.revenue_30d_paise)} href="/admin/payments" />
          <Tile
            icon={Undo2} label="Refund requests" value={nf.format(k.open_refunds)}
            hint={k.open_refunds ? `${formatPaise(k.open_refunds_paise)} to send` : 'Nothing waiting'}
            href="/admin/refunds" tone={k.open_refunds ? 'alert' : 'default'}
          />
          <Tile
            icon={Hourglass} label="Pending payments" value={nf.format(k.pending_payments)}
            hint={k.pending_review ? `${nf.format(k.pending_review)} need a check` : k.pending_payments ? formatPaise(k.pending_payments_paise) : 'Nothing pending'}
            href="/admin/payments" tone={k.pending_review ? 'alert' : 'default'}
          />
        </section>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
          <CardTitle className="font-dash text-[20px] text-grand-teal">Next events</CardTitle>
          <Button asChild variant="ghost" size="sm"><a href="/admin/events" className="no-underline">All events<ArrowRight /></a></Button>
        </CardHeader>
        <CardContent className="px-2 pb-3 sm:px-4">
          {loading && !data ? (
            <div className="grid gap-3 p-2">{[0, 1, 2].map((i) => <Shimmer key={i} className="h-16 rounded-lg" />)}</div>
          ) : data && data.next_events.length ? (
            <ul className="divide-y divide-border/50">{data.next_events.map((ev) => <EventRow key={ev.id} ev={ev} />)}</ul>
          ) : data ? (
            <div className="flex flex-col items-start gap-3 px-2 py-4">
              <p className="text-[15px] font-semibold text-muted-foreground">No upcoming events. Create the next puja or havan.</p>
              <Button asChild size="sm"><a href="/admin/events/new" className="no-underline"><Plus />New event</a></Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
