/* [ADMIN2-ANALYTICS 2026-09-26] /admin landing page: "Analytics".
 * Data: GET /api/admin/v2/analytics?range|from&to&tz=Asia/Kolkata (worker/src/routes/admin2_analytics.ts).
 * Money is paise; days are IST calendar days. Every card, bar and row links to the admin page
 * that holds the underlying records, with the matching filters applied.
 * Replaces Overview.tsx (git history keeps it). Mounted inside layouts/Admin2.astro — no Clerk here.
 * Telemetry: admin2_analytics_range {range} when the admin changes the range.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  IndianRupee, Ticket, Users, UserPlus, ReceiptIndianRupee, Undo2, Hourglass, CalendarDays, Radio,
  ArrowUpRight, ArrowDownRight, Minus, RefreshCw, ArrowRight, Plus, CalendarRange, type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Shimmer } from '../dashboard2/Shimmer';
import { cn } from '../../lib/utils';
import { capture, captureException } from '../../lib/analytics';
import { adminApi, errMessage, formatPaise, istDay, istTime, istDateTime, AdminDeniedError } from './adminApi';
import { ADMIN_NAV } from './nav';
import { DateField, StatusPill } from './peopleKit';
import {
  C1, C2, INK_MUTED, DayColumns, DayTable, HBars, LegendKey, Sparkline, TrendLine, compactPaise, fmtCount, longDay,
} from './charts';

/* ── wire types ─────────────────────────────────────────────────────────── */

interface Pair { cur: number; prev: number }
interface NextEvent {
  id: string; title: string; category_label: string | null; status: string; live: boolean;
  starts_at: number | null; capacity: number | null; booked: number; price_paise: number; image_url: string | null; admin_url: string;
}
interface AnalyticsData {
  generated_at: number;
  range: { preset: string; days: number; from: string; to: string; prev_from: string; prev_to: string };
  kpis: {
    revenue_paise: Pair; paid_bookings: Pair; unique_customers: Pair; signups: Pair; aov_paise: Pair; seats: Pair;
    refunds: { count: Pair; paise: Pair }; refund_rate: { cur: number | null; prev: number | null };
    live_now: number; upcoming_events: { total: number; next_7d: number };
    pending_payments: { count: number; paise: number; review: number }; open_refunds: { count: number; paise: number };
  };
  series: {
    days: string[]; revenue_paise: number[]; revenue_prev_paise: number[]; paid_bookings: number[]; unique_customers: number[];
    aov_paise: number[]; signups: number[]; refunds: number[]; refunds_paise: number[]; seats: number[]; free_seats: number[];
    upcoming: { day: string; count: number }[];
  };
  by_category: { category: string | null; label: string; revenue_paise: number; paid_bookings: number }[];
  top_events: { id: string; title: string | null; category_label: string | null; revenue_paise: number; paid_bookings: number }[];
  funnel: { started: number; sent: number; confirmed: number; kept: number } | null;
  next_events: NextEvent[];
  recent_payments: { id: string; uid: string; customer: string | null; listing_id: string; event_title: string | null; amount_paise: number; status: string; at: number }[];
  open_refunds: { id: string; uid: string; customer: string | null; event_title: string | null; amount_paise: number; requested_at: number; reason: string | null }[];
}

/* ── range (URL-synced) ─────────────────────────────────────────────────── */

type Preset = 'today' | '7d' | '30d' | '90d';
type RangeSel = { kind: 'preset'; preset: Preset } | { kind: 'custom'; from: string; to: string };
const PRESETS: { key: Preset; label: string; long: string }[] = [
  { key: 'today', label: 'Today', long: 'yesterday' },
  { key: '7d', label: '7 days', long: 'previous 7 days' },
  { key: '30d', label: '30 days', long: 'previous 30 days' },
  { key: '90d', label: '90 days', long: 'previous 90 days' },
];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function readRange(): RangeSel {
  if (typeof window === 'undefined') return { kind: 'preset', preset: '30d' };
  const u = new URLSearchParams(location.search);
  const from = u.get('from') ?? '', to = u.get('to') ?? '';
  if (DAY_RE.test(from) && DAY_RE.test(to) && from <= to) return { kind: 'custom', from, to };
  const r = u.get('range') as Preset | null;
  return { kind: 'preset', preset: PRESETS.some((p) => p.key === r) ? (r as Preset) : '30d' };
}
function writeRange(r: RangeSel) {
  const u = new URL(location.href);
  for (const k of ['range', 'from', 'to']) u.searchParams.delete(k);
  if (r.kind === 'custom') { u.searchParams.set('from', r.from); u.searchParams.set('to', r.to); }
  else if (r.preset !== '30d') u.searchParams.set('range', r.preset);
  history.replaceState(history.state, '', u.toString());
}
const rangeQuery = (r: RangeSel): Record<string, string> =>
  r.kind === 'custom' ? { from: r.from, to: r.to, tz: 'Asia/Kolkata' } : { range: r.preset, tz: 'Asia/Kolkata' };
const rangeKey = (r: RangeSel) => (r.kind === 'custom' ? `custom:${r.from}:${r.to}` : r.preset);

function RangeBar({ sel, onChange, busy }: { sel: RangeSel; onChange: (r: RangeSel) => void; busy: boolean }) {
  const [open, setOpen] = useState(sel.kind === 'custom');
  const [from, setFrom] = useState(sel.kind === 'custom' ? sel.from : '');
  const [to, setTo] = useState(sel.kind === 'custom' ? sel.to : '');
  const valid = DAY_RE.test(from) && DAY_RE.test(to) && from <= to;
  const btn = (on: boolean) => cn(
    'h-10 min-w-[44px] rounded-lg px-3 text-[14px] font-bold transition-colors',
    on ? 'bg-accent text-accent-foreground shadow-[var(--dash-shadow,none)]' : 'text-foreground/80 hover:bg-muted',
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Date range" className="flex flex-wrap gap-1 rounded-xl border border-border/60 bg-card p-1">
          {PRESETS.map((p) => {
            const on = sel.kind === 'preset' && sel.preset === p.key && !open;
            return (
              <button key={p.key} type="button" aria-pressed={on} className={btn(on)}
                onClick={() => { setOpen(false); onChange({ kind: 'preset', preset: p.key }); }}>
                {p.label}
              </button>
            );
          })}
          <button type="button" aria-pressed={open || sel.kind === 'custom'} aria-expanded={open} className={cn(btn(open || sel.kind === 'custom'), 'inline-flex items-center gap-1.5')}
            onClick={() => setOpen((o) => !o)}>
            <CalendarRange className="h-4 w-4" />Custom
          </button>
        </div>
        {busy && <RefreshCw aria-label="Updating" className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
      </div>
      {open && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); if (valid) onChange({ kind: 'custom', from, to }); }}
        >
          <DateField id="an-from" label="From" value={from} onChange={setFrom} />
          <DateField id="an-to" label="To" value={to} onChange={setTo} />
          <Button type="submit" disabled={!valid}>Apply</Button>
          {from && to && from > to && <span className="text-[13px] font-semibold text-primary">The start date is after the end date.</span>}
        </form>
      )}
    </div>
  );
}

/* ── links ──────────────────────────────────────────────────────────────── */

const customersHref = ADMIN_NAV.find((i) => (i.key as string) === 'customers' || (i.key as string) === 'users')?.href ?? '/admin/customers';
const qs = (base: string, q: Record<string, string | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `${base}?${s}` : base;
};

/* ── KPI card ───────────────────────────────────────────────────────────── */

function Delta({ cur, prev, upIsGood = true, vs }: { cur: number; prev: number; upIsGood?: boolean; vs: string }) {
  let text: string, dir: 'up' | 'down' | 'flat';
  if (cur === prev) { text = 'No change'; dir = 'flat'; }
  else if (prev === 0) { text = 'New'; dir = 'up'; }
  else {
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    dir = pct > 0 ? 'up' : 'down';
    text = `${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`;
  }
  const good = dir === 'flat' ? null : (dir === 'up') === upIsGood;
  const Icon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12.5px] font-semibold text-muted-foreground">
      <span className={cn('inline-flex items-center gap-0.5 font-extrabold', good === true && 'text-accent', good === false && 'text-primary')}>
        <Icon className="h-3.5 w-3.5" strokeWidth={2.6} aria-hidden />
        <span className="sr-only">{dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : ''}</span>
        {text}
      </span>
      <span>vs {vs}</span>
    </span>
  );
}

function Kpi({ icon: Icon, label, value, delta, hint, spark, sparkLabel, href, tone, badge }: {
  icon: LucideIcon; label: string; value: string; delta?: ReactNode; hint?: ReactNode; spark?: number[]; sparkLabel?: string;
  href: string; tone?: 'alert'; badge?: ReactNode;
}) {
  return (
    <a href={href} className="group block no-underline">
      <Card className={cn('h-full transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring', tone === 'alert' && 'border-primary/60')}>
        <CardContent className="flex h-full flex-col gap-2 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', tone === 'alert' ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-accent')}>
              <Icon className="h-4 w-4" strokeWidth={2.2} />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-dash text-[26px] font-bold leading-none tracking-[0.01em] text-grand-teal sm:text-[28px]">{value}</span>
            {badge}
          </div>
          {delta}
          {hint && <div className="text-[12.5px] font-semibold text-muted-foreground">{hint}</div>}
          <div className="mt-auto pt-1">
            {spark ? <Sparkline values={spark} /> : <div className="h-7" aria-hidden />}
            {sparkLabel && <div className="text-[11px] font-semibold text-muted-foreground">{sparkLabel}</div>}
          </div>
        </CardContent>
      </Card>
    </a>
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

/* ── panels ─────────────────────────────────────────────────────────────── */

function Panel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="font-dash text-[18px] text-grand-teal sm:text-[19px]">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="px-3 pb-4 sm:px-5">{children}</CardContent>
    </Card>
  );
}
const Empty = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-[14px] font-semibold text-muted-foreground">
    {children}
  </div>
);
const SeeAll = ({ href, children = 'See all' }: { href: string; children?: ReactNode }) => (
  <Button asChild variant="ghost" size="sm"><a href={href} className="no-underline">{children}<ArrowRight /></a></Button>
);

function PageSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 9 }, (_, i) => <Shimmer key={i} className="h-[168px] rounded-xl" />)}
      </div>
      <Shimmer className="h-[320px] rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2"><Shimmer className="h-[300px] rounded-xl" /><Shimmer className="h-[300px] rounded-xl" /></div>
      <span className="sr-only">Loading analytics…</span>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(v * 100 >= 10 || v === 0 ? 0 : 1)}%`);

/* ── page ───────────────────────────────────────────────────────────────── */

const REFRESH_MS = 60_000;

export default function Analytics() {
  const [sel, setSel] = useState<RangeSel>(readRange);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef<AbortController | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  const load = useCallback(async (quiet = false) => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    if (!quiet) setLoading(true);
    try {
      const d = await adminApi<AnalyticsData>('/api/admin/v2/analytics', { query: rangeQuery(selRef.current), signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setData(d); setError(null);
    } catch (e) {
      if (ctrl.signal.aborted || e instanceof AdminDeniedError) return;
      if (!quiet) setError(errMessage(e, "We couldn't load the analytics. Please try again."));
      captureException(e, { where: 'admin2_analytics' });
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, rangeKey(sel)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, REFRESH_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); inflight.current?.abort(); };
  }, [load]);

  const change = (r: RangeSel) => {
    if (rangeKey(r) === rangeKey(sel)) return;
    setSel(r); writeRange(r);
    capture('admin2_analytics_range', { range: r.kind === 'custom' ? 'custom' : r.preset, ...(r.kind === 'custom' ? { from: r.from, to: r.to } : {}) });
  };

  const d = data;
  const k = d?.kpis, s = d?.series;
  const F = d?.range.from, T = d?.range.to;
  const vs = sel.kind === 'custom' ? `previous ${d?.range.days ?? ''} days` : PRESETS.find((p) => p.key === sel.preset)!.long;
  const rangeText = d ? (F === T ? longDay(F!) : `${longDay(F!)} – ${longDay(T!)}`) : '';
  const payRange = { paid_from: F, paid_to: T };

  return (
    <div className="grid gap-6 sm:gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <RangeBar sel={sel} onChange={change} busy={loading && !!data} />
        {d && <p className="text-[13px] font-semibold text-muted-foreground sm:pt-3">{rangeText} · IST · compared with {longDay(d.range.prev_from)} – {longDay(d.range.prev_to)}</p>}
      </div>

      {error && !d ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-5">
            <p className="text-[15px] font-semibold text-foreground">{error}</p>
            <Button variant="outline" onClick={() => void load()}><RefreshCw />Try again</Button>
          </CardContent>
        </Card>
      ) : !d || !k || !s ? (
        <PageSkeleton />
      ) : (
        <div className={cn('grid gap-6 transition-opacity sm:gap-8', loading && 'opacity-60')}>
          {error && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/50 bg-primary/5 px-4 py-2 text-[14px] font-semibold">
              {error}<Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button>
            </div>
          )}

          {/* KPI cards */}
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
            <Kpi icon={IndianRupee} label="Revenue" value={formatPaise(k.revenue_paise.cur)}
              delta={<Delta {...k.revenue_paise} vs={vs} />} hint="Paid, GST included, refunds out"
              spark={s.revenue_paise} href={qs('/admin/payments', payRange)} />
            <Kpi icon={Ticket} label="Paid bookings" value={fmtCount(k.paid_bookings.cur)}
              delta={<Delta {...k.paid_bookings} vs={vs} />} hint={`${fmtCount(k.seats.cur)} seats incl. free`}
              spark={s.paid_bookings} href={qs('/admin/bookings', { status: 'paid', from: F, to: T })} />
            <Kpi icon={Users} label="Unique customers" value={fmtCount(k.unique_customers.cur)}
              delta={<Delta {...k.unique_customers} vs={vs} />} hint="People who paid"
              spark={s.unique_customers} href={customersHref} />
            <Kpi icon={UserPlus} label="New sign-ups" value={fmtCount(k.signups.cur)}
              delta={<Delta {...k.signups} vs={vs} />} spark={s.signups} href={qs(customersHref, { joined_from: F, joined_to: T })} />
            <Kpi icon={ReceiptIndianRupee} label="Avg order value" value={formatPaise(k.aov_paise.cur)}
              delta={<Delta {...k.aov_paise} vs={vs} />} spark={s.aov_paise} href={qs('/admin/payments', payRange)} />
            <Kpi icon={Undo2} label="Refunds sent" value={`${fmtCount(k.refunds.count.cur)} · ${compactPaise(k.refunds.paise.cur)}`}
              delta={<Delta {...k.refunds.count} upIsGood={false} vs={vs} />}
              hint={<>Refund rate {pct(k.refund_rate.cur)}{k.refund_rate.prev != null && <> (was {pct(k.refund_rate.prev)})</>}</>}
              spark={s.refunds_paise} href={qs('/admin/refunds', { status: 'refunded' })} />
            <Kpi icon={Hourglass} label="Pending payments" value={fmtCount(k.pending_payments.count)}
              tone={k.pending_payments.review ? 'alert' : undefined}
              hint={k.pending_payments.count ? `${formatPaise(k.pending_payments.paise)}${k.pending_payments.review ? ` · ${fmtCount(k.pending_payments.review)} need a check` : ''}` : 'Nothing pending'}
              sparkLabel="Right now" href={qs('/admin/payments', { status: 'pending' })} />
            <Kpi icon={CalendarDays} label="Upcoming events" value={fmtCount(k.upcoming_events.total)}
              hint={`${fmtCount(k.upcoming_events.next_7d)} in the next 7 days`}
              spark={s.upcoming.map((u) => u.count)} sparkLabel="Events per day, next 14 days" href={qs('/admin/events', { tab: 'upcoming' })} />
            <Kpi icon={Radio} label="Live now" value={fmtCount(k.live_now)} badge={k.live_now > 0 ? <LiveBadge /> : undefined}
              hint={k.live_now ? 'Streaming right now' : 'Nothing live'} sparkLabel="Right now" href={qs('/admin/events', { tab: 'live' })} />
            <Kpi icon={Undo2} label="Refund requests" value={fmtCount(k.open_refunds.count)} tone={k.open_refunds.count ? 'alert' : undefined}
              hint={k.open_refunds.count ? `${formatPaise(k.open_refunds.paise)} to send` : 'Nothing waiting'}
              sparkLabel="Open now" href={qs('/admin/refunds', {})} />
          </section>

          {/* Revenue by day */}
          <Panel title="Revenue by day" action={
            <div className="flex flex-wrap items-center gap-3">
              <LegendKey kind="line" color={C1} label="This period" />
              <LegendKey kind="line" color={INK_MUTED} dashed label="Previous period" />
            </div>
          }>
            {k.revenue_paise.cur === 0 && k.revenue_paise.prev === 0
              ? <Empty>No paid bookings in this period or the one before.</Empty>
              : <>
                  <TrendLine days={s.days} cur={s.revenue_paise} prev={s.revenue_prev_paise} format={formatPaise} axisFormat={compactPaise}
                    label={`Revenue by day, ${rangeText}`} onPick={(day) => location.assign(qs('/admin/payments', { paid_from: day, paid_to: day }))} />
                  <DayTable days={s.days} cols={[
                    { label: 'Revenue', values: s.revenue_paise, format: formatPaise },
                    { label: 'Previous', values: s.revenue_prev_paise, format: formatPaise },
                    { label: 'Paid bookings', values: s.paid_bookings, format: fmtCount },
                  ]} />
                </>}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Bookings by day" action={
              <div className="flex flex-wrap items-center gap-3">
                <LegendKey kind="rect" color={C1} label="Paid" />
                <LegendKey kind="rect" color={C2} label="Free" />
              </div>
            }>
              {k.seats.cur === 0
                ? <Empty>No seats booked in this period.</Empty>
                : <>
                    <DayColumns days={s.days} format={fmtCount} label={`Seats booked by day, ${rangeText}`}
                      series={[
                        { key: 'paid', label: 'paid', color: C1, values: s.seats.map((v, i) => v - (s.free_seats[i] ?? 0)) },
                        { key: 'free', label: 'free', color: C2, values: s.free_seats },
                      ]}
                      onPick={(day) => location.assign(qs('/admin/bookings', { from: day, to: day }))} />
                    <DayTable days={s.days} cols={[
                      { label: 'Seats', values: s.seats, format: fmtCount },
                      { label: 'Free', values: s.free_seats, format: fmtCount },
                    ]} />
                  </>}
            </Panel>

            <Panel title="New sign-ups by day" action={<SeeAll href={qs(customersHref, { joined_from: F, joined_to: T })}>Users</SeeAll>}>
              {k.signups.cur === 0
                ? <Empty>No new sign-ups in this period.</Empty>
                : <>
                    <DayColumns days={s.days} format={fmtCount} label={`New sign-ups by day, ${rangeText}`}
                      series={[{ key: 'signups', label: 'sign-ups', color: C1, values: s.signups }]}
                      onPick={(day) => location.assign(qs(customersHref, { joined_from: day, joined_to: day }))} />
                    <DayTable days={s.days} cols={[{ label: 'Sign-ups', values: s.signups, format: fmtCount }]} />
                  </>}
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Revenue by category" action={<SeeAll href={qs('/admin/payments', payRange)}>Payments</SeeAll>}>
              {d.by_category.length === 0
                ? <Empty>No revenue in this period.</Empty>
                : <HBars rows={d.by_category.map((c) => ({
                    key: c.category ?? '_none', label: c.label, value: c.revenue_paise, valueText: formatPaise(c.revenue_paise),
                    sub: `${fmtCount(c.paid_bookings)} paid booking${c.paid_bookings === 1 ? '' : 's'}`,
                    href: qs('/admin/payments', { cat: c.category, ...payRange }),
                  }))} />}
            </Panel>

            <Panel title="UPI checkout funnel" action={<SeeAll href={qs('/admin/payments', { status: 'pending' })}>Pending</SeeAll>}>
              {!d.funnel
                ? <Empty>No UPI checkouts started in this period.</Empty>
                : <>
                    <HBars rows={([
                      ['started', 'Checkout started', d.funnel.started],
                      ['sent', 'Payment sent', d.funnel.sent],
                      ['confirmed', 'Payment confirmed', d.funnel.confirmed],
                      ['kept', 'Seat kept', d.funnel.kept],
                    ] as const).map(([key, label, v]) => ({
                      key, label, value: v,
                      valueText: `${fmtCount(v)}${key === 'started' ? '' : ` · ${pct(d.funnel!.started ? v / d.funnel!.started : null)}`}`,
                      href: key === 'sent' ? qs('/admin/payments', { status: 'pending' }) : qs('/admin/payments', payRange),
                    }))} />
                    <p className="mt-2 px-2 text-[12px] font-semibold text-muted-foreground">One step per customer and event. “Seat kept” excludes refunds.</p>
                  </>}
            </Panel>
          </div>

          <Panel title="Top 10 events by revenue" action={<SeeAll href="/admin/events">All events</SeeAll>}>
            {d.top_events.length === 0
              ? <Empty>No paid bookings in this period.</Empty>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-[14px]">
                    <thead>
                      <tr className="text-[12px] font-bold uppercase tracking-[0.05em] text-muted-foreground">
                        <th className="w-8 px-2 py-2">#</th>
                        <th className="px-2 py-2">Event</th>
                        <th className="px-2 py-2 text-right">Paid</th>
                        <th className="w-[38%] px-2 py-2">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.top_events.map((e, i) => {
                        const max = d.top_events[0].revenue_paise || 1;
                        const href = qs('/admin/bookings', { event: e.id });
                        return (
                          <tr key={e.id} className="border-t border-border/40 transition-colors hover:bg-muted">
                            <td className="px-2 py-2.5 font-bold tabular-nums text-muted-foreground">{i + 1}</td>
                            <td className="max-w-0 px-2 py-2.5">
                              <a href={href} className="block truncate font-bold text-foreground no-underline hover:underline">{e.title ?? e.id}</a>
                              {e.category_label && <div className="truncate text-[12px] font-semibold text-muted-foreground">{e.category_label}</div>}
                            </td>
                            <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{fmtCount(e.paid_bookings)}</td>
                            <td className="px-2 py-2.5">
                              <a href={href} className="flex items-center gap-2 no-underline" aria-label={`${e.title ?? e.id}: ${formatPaise(e.revenue_paise)}`}>
                                <span className="h-3 min-w-[2px] rounded-r-[4px]" style={{ width: `${Math.max(1, (e.revenue_paise / max) * 70)}%`, background: C1 }} aria-hidden />
                                <span className="shrink-0 font-dash text-[13.5px] font-bold tabular-nums text-foreground">{formatPaise(e.revenue_paise)}</span>
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </Panel>

          <div className="grid gap-6 xl:grid-cols-3">
            <Panel title="Next events" action={<SeeAll href="/admin/events" />}>
              {d.next_events.length === 0 ? (
                <div className="flex flex-col items-start gap-3 py-2">
                  <p className="text-[14px] font-semibold text-muted-foreground">No upcoming events. Create the next puja or havan.</p>
                  <Button asChild size="sm"><a href="/admin/events/new" className="no-underline"><Plus />New event</a></Button>
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {d.next_events.map((ev) => (
                    <li key={ev.id}>
                      <a href={ev.admin_url} className="flex items-center gap-3 rounded-lg px-1.5 py-2.5 no-underline transition-colors hover:bg-muted">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {ev.live && <LiveBadge />}
                            <span className="truncate font-bold text-foreground">{ev.title}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] font-semibold text-muted-foreground">
                            <span>{ev.live ? 'Streaming now' : `${istDay(ev.starts_at)} · ${istTime(ev.starts_at)}`}</span>
                            <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />
                              {ev.capacity != null ? `${fmtCount(ev.booked)} / ${fmtCount(ev.capacity)} booked` : `${fmtCount(ev.booked)} booked`}
                            </span>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Recent payments" action={<SeeAll href="/admin/payments" />}>
              {d.recent_payments.length === 0 ? <Empty>No payments yet.</Empty> : (
                <ul className="divide-y divide-border/50">
                  {d.recent_payments.map((p) => (
                    <li key={p.id}>
                      <a href={qs('/admin/payments', { q: p.id })} className="flex items-center gap-3 rounded-lg px-1.5 py-2.5 no-underline transition-colors hover:bg-muted">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-bold text-foreground">{p.customer ?? 'Customer'}</div>
                          <div className="truncate text-[12.5px] font-semibold text-muted-foreground">{p.event_title ?? p.listing_id} · {istDateTime(p.at)}</div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="font-dash text-[14px] font-bold tabular-nums text-foreground">{formatPaise(p.amount_paise)}</span>
                          <StatusPill status={p.status} />
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Open refund requests" action={<SeeAll href="/admin/refunds" />}>
              {d.open_refunds.length === 0 ? <Empty>No refund requests waiting.</Empty> : (
                <ul className="divide-y divide-border/50">
                  {d.open_refunds.map((r) => (
                    <li key={r.id}>
                      <a href={qs('/admin/refunds', { q: r.id })} className="flex items-center gap-3 rounded-lg px-1.5 py-2.5 no-underline transition-colors hover:bg-muted">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-bold text-foreground">{r.customer ?? 'Customer'}</div>
                          <div className="truncate text-[12.5px] font-semibold text-muted-foreground">
                            {r.event_title ?? 'Event'} · asked {istDay(r.requested_at)}{r.reason ? ` · “${r.reason}”` : ''}
                          </div>
                        </div>
                        <span className="shrink-0 font-dash text-[14px] font-bold tabular-nums text-foreground">{formatPaise(r.amount_paise)}</span>
                      </a>
                    </li>
                  ))}
                  {k.open_refunds.count > d.open_refunds.length && (
                    <li className="px-1.5 pt-2.5 text-[12.5px] font-semibold text-muted-foreground">
                      +{fmtCount(k.open_refunds.count - d.open_refunds.length)} more waiting
                    </li>
                  )}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
