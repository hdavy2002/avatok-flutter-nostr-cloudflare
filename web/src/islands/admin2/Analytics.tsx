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
  ArrowUpRight, ArrowDownRight, Minus, RefreshCw, ArrowRight, Plus, CalendarRange, Eye, MonitorPlay, type LucideIcon,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Shimmer } from '../dashboard2/Shimmer';
import { cn } from '../../lib/utils';
import { capture, captureException } from '../../lib/analytics';
import { adminApi, errMessage, formatPaise, istDay, istTime, istDateTime, AdminDeniedError } from './adminApi';
import { ADMIN_NAV } from './nav';
import { DateField } from './peopleKit';
import { DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, DesiTicker, DesiMogra } from './desi';
import {
  C1, C2, GRAD, INK_MUTED, DayColumns, DayTable, HBars, LegendKey, Sparkline, TrendLine, compactPaise, fmtCount, longDay,
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
  /** [SAATHUM-FREEVID-ADMIN-1] Absent on an older API — the section is hidden then. */
  video_views?: {
    viewers: Pair; plays: Pair;
    by_event: { listing_id: string; title: string | null; free: boolean; kind?: 'event' | 'free_video'; viewers: number; plays: number }[];
  };
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


const LAV = '#6d4fd0', TEA = '#0e7c86';

function RangeBar({ sel, onChange, busy }: { sel: RangeSel; onChange: (r: RangeSel) => void; busy: boolean }) {
  const [open, setOpen] = useState(sel.kind === 'custom');
  const [from, setFrom] = useState(sel.kind === 'custom' ? sel.from : '');
  const [to, setTo] = useState(sel.kind === 'custom' ? sel.to : '');
  const valid = DAY_RE.test(from) && DAY_RE.test(to) && from <= to;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Date range" className="hfa-pills">
          {PRESETS.map((p) => {
            const on = sel.kind === 'preset' && sel.preset === p.key && !open;
            return (
              <button key={p.key} type="button" aria-pressed={on} className="hfa-pill"
                onClick={() => { setOpen(false); onChange({ kind: 'preset', preset: p.key }); }}>
                {p.label}
              </button>
            );
          })}
          <button type="button" aria-pressed={open || sel.kind === 'custom'} aria-expanded={open} className="hfa-pill inline-flex items-center gap-1.5"
            onClick={() => setOpen((o) => !o)}>
            <CalendarRange className="h-4 w-4" />Custom
          </button>
        </div>
        {busy && <RefreshCw aria-label="Updating" className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
      </div>
      {open && (
        <form
          className="hfa-card hfa-t-lav flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); if (valid) onChange({ kind: 'custom', from, to }); }}
        >
          <DateField id="an-from" label="From" value={from} onChange={setFrom} />
          <DateField id="an-to" label="To" value={to} onChange={setTo} />
          <Button type="submit" disabled={!valid} className="min-h-[44px]">Apply</Button>
          {from && to && from > to && <span className="hfa-note font-bold text-[#d81b72]">The start date is after the end date.</span>}
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

/* ── KPI tile ───────────────────────────────────────────────────────────── */

function Delta({ cur, prev, upIsGood = true, vs, onDark }: { cur: number; prev: number; upIsGood?: boolean; vs: string; onDark?: boolean }) {
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
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[14px] font-semibold opacity-90">
      <span className={cn('inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-extrabold',
        onDark ? 'bg-white/20 text-white' : good === true ? 'bg-[#e3f5f6] text-[#0e7c86]' : good === false ? 'bg-[#ffe6ef] text-[#d81b72]' : 'bg-black/5')}>
        <Icon className="h-3.5 w-3.5" strokeWidth={2.6} aria-hidden />
        <span className="sr-only">{dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : ''}</span>
        {text}
      </span>
      <span>vs {vs}</span>
    </span>
  );
}

type KpiTone = 'plum' | 'rani' | 'lav' | 'tea' | 'gold';
const SPARK: Record<KpiTone, string> = { plum: '#ffd166', rani: '#d81b72', lav: LAV, tea: TEA, gold: '#b45309' };

function Kpi({ icon: Icon, label, value, delta, hint, spark, sparkLabel, href, tone, alert, badge, wide }: {
  icon: LucideIcon; label: string; value: string; delta?: ReactNode; hint?: ReactNode; spark?: number[]; sparkLabel?: string;
  href: string; tone: KpiTone; alert?: boolean; badge?: ReactNode; wide?: boolean;
}) {
  return (
    <a href={href} className={cn('block rounded-[22px] no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d81b72]', wide && 'sm:col-span-2')}>
      <DesiKpi tone={tone} alert={alert} label={label} icon={<Icon strokeWidth={2.2} />}
        value={<span className="inline-flex flex-wrap items-center gap-2">{value}{badge}</span>}
        sub={
          <span className="flex flex-col gap-1.5">
            {delta}
            {hint && <span>{hint}</span>}
            {spark ? <Sparkline values={spark} color={SPARK[tone]} /> : <span className="block h-7" aria-hidden />}
            {sparkLabel && <span>{sparkLabel}</span>}
          </span>
        } />
    </a>
  );
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#d1001f] px-2.5 py-0.5 text-[14px] font-extrabold uppercase text-white">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
      </span>
      Live
    </span>
  );
}

const SeeAll = ({ href, children = 'See all' }: { href: string; children?: ReactNode }) => (
  <a href={href} className="hfa-btn ghost no-underline">{children}<ArrowRight className="h-4 w-4" /></a>
);

function PageSkeleton() {
  return (
    <div className="hfa-stack" aria-busy="true">
      <div className="hfa-kpis">
        {Array.from({ length: 9 }, (_, i) => <Shimmer key={i} className="h-[168px] rounded-[22px]" />)}
      </div>
      <Shimmer className="h-[320px] rounded-[24px]" />
      <div className="hfa-row"><Shimmer className="h-[300px] rounded-[24px]" /><Shimmer className="h-[300px] rounded-[24px]" /></div>
      <span className="sr-only">Loading analytics…</span>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(v * 100 >= 10 || v === 0 ? 0 : 1)}%`);

const PAY_CHIP: Record<string, { tone: 'tea' | 'gold' | 'rani' | 'lav' | 'grey'; label: string }> = {
  paid: { tone: 'tea', label: 'Paid' }, free: { tone: 'lav', label: 'Free' }, pending: { tone: 'gold', label: 'Pending' },
  refund_requested: { tone: 'lav', label: 'Refund requested' }, refunded: { tone: 'rani', label: 'Refunded' },
  requested: { tone: 'rani', label: 'Requested' }, rejected: { tone: 'grey', label: 'Rejected' },
};
const PayChip = ({ status }: { status: string }) => {
  const m = PAY_CHIP[status] ?? { tone: 'grey' as const, label: status };
  return <DesiChip tone={m.tone}>{m.label}</DesiChip>;
};

const MEDAL = [
  'linear-gradient(135deg,#fde68a,#f59e0b)', // gold
  'linear-gradient(135deg,#f4f4f8,#a9a3b8)', // silver
  'linear-gradient(135deg,#f6c59a,#b86a2c)', // bronze
];
const dayNum = new Intl.DateTimeFormat('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' });
const monShort = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' });

/** A calendar-leaf date tile for the "Next events" list. */
function DateTile({ ms, live }: { ms: number | null; live: boolean }) {
  return (
    <span className={cn('flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl border-2 font-extrabold leading-none',
      live ? 'border-[#d1001f] bg-[#d1001f] text-white' : 'border-[#c7b6f5] bg-white text-[#6d4fd0]')} aria-hidden>
      {live || !ms ? <span className="text-[14px] uppercase">{live ? 'Live' : '—'}</span> : (
        <>
          <span className="font-['Nunito'] text-[22px]">{dayNum.format(ms)}</span>
          <span className="text-[14px] uppercase">{monShort.format(ms)}</span>
        </>
      )}
    </span>
  );
}

/** Funnel step as a full-width gradient bar. */
function FunnelBars({ rows }: { rows: { key: string; label: string; value: number; text: string; href: string; grad: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul className="grid gap-2.5">
      {rows.map((r) => (
        <li key={r.key}>
          <a href={r.href} className="block rounded-xl p-1 no-underline transition-colors hover:bg-white/60">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[14px] font-bold text-[var(--a-ink)]">
              <span>{r.label}</span><span className="font-['Nunito'] font-black tabular-nums">{r.text}</span>
            </div>
            <div className="h-6 w-full overflow-hidden rounded-full bg-white/70" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, background: r.grad }} />
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}

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

  const ticker: ReactNode[] = [];
  if (k) {
    if (k.live_now > 0) ticker.push(<>{fmtCount(k.live_now)} event{k.live_now === 1 ? '' : 's'} streaming live right now</>);
    if (k.pending_payments.count > 0) ticker.push(<>{fmtCount(k.pending_payments.count)} payment{k.pending_payments.count === 1 ? '' : 's'} pending · {formatPaise(k.pending_payments.paise)}{k.pending_payments.review ? ` · ${fmtCount(k.pending_payments.review)} need a check` : ''}</>);
    if (k.open_refunds.count > 0) ticker.push(<>{fmtCount(k.open_refunds.count)} refund request{k.open_refunds.count === 1 ? '' : 's'} waiting · {formatPaise(k.open_refunds.paise)} to send</>);
    if (k.upcoming_events.next_7d > 0) ticker.push(<>{fmtCount(k.upcoming_events.next_7d)} event{k.upcoming_events.next_7d === 1 ? '' : 's'} in the next 7 days</>);
  }

  return (
    <div className="hf-admin-operations hfa-stack">
      {d && k && <DesiTicker items={ticker} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <RangeBar sel={sel} onChange={change} busy={loading && !!data} />
        {d && <p className="hfa-note sm:pt-2">{rangeText} · IST · compared with {longDay(d.range.prev_from)} – {longDay(d.range.prev_to)}</p>}
      </div>

      {error && !d ? (
        <DesiCard tone="rani" corner="hibiscus" pattern="stripes">
          <div className="flex flex-col items-start gap-3">
            <p className="font-bold">{error}</p>
            <button type="button" className="hfa-btn rani" onClick={() => void load()}><RefreshCw className="h-4 w-4" />Try again</button>
          </div>
        </DesiCard>
      ) : !d || !k || !s ? (
        <PageSkeleton />
      ) : (
        <div className={cn('hfa-stack transition-opacity', loading && 'opacity-60')}>
          {error && (
            <div className="hfa-card hfa-t-rani flex flex-wrap items-center gap-3 font-semibold">
              {error}<button type="button" className="hfa-btn ghost" onClick={() => void load()}><RefreshCw className="h-4 w-4" />Retry</button>
            </div>
          )}

          {/* KPI tiles: revenue is the plum hero */}
          <section aria-label="Key numbers" className="hfa-kpis">
            <Kpi tone="plum" wide icon={IndianRupee} label="Revenue" value={formatPaise(k.revenue_paise.cur)}
              delta={<Delta {...k.revenue_paise} vs={vs} onDark />} hint="Paid, GST included, refunds out"
              spark={s.revenue_paise} href={qs('/admin/payments', payRange)} />
            <Kpi tone="rani" icon={Ticket} label="Paid bookings" value={fmtCount(k.paid_bookings.cur)}
              delta={<Delta {...k.paid_bookings} vs={vs} />} hint={`${fmtCount(k.seats.cur)} seats incl. free`}
              spark={s.paid_bookings} href={qs('/admin/bookings', { status: 'paid', from: F, to: T })} />
            <Kpi tone="lav" icon={Users} label="Unique customers" value={fmtCount(k.unique_customers.cur)}
              delta={<Delta {...k.unique_customers} vs={vs} />} hint="People who paid"
              spark={s.unique_customers} href={customersHref} />
            <Kpi tone="tea" icon={UserPlus} label="New sign-ups" value={fmtCount(k.signups.cur)}
              delta={<Delta {...k.signups} vs={vs} />} spark={s.signups} href={qs(customersHref, { joined_from: F, joined_to: T })} />
            <Kpi tone="gold" icon={ReceiptIndianRupee} label="Avg order value" value={formatPaise(k.aov_paise.cur)}
              delta={<Delta {...k.aov_paise} vs={vs} />} spark={s.aov_paise} href={qs('/admin/payments', payRange)} />
            <Kpi tone="rani" icon={Undo2} label="Refunds sent" value={`${fmtCount(k.refunds.count.cur)} · ${compactPaise(k.refunds.paise.cur)}`}
              delta={<Delta {...k.refunds.count} upIsGood={false} vs={vs} />}
              hint={<>Refund rate {pct(k.refund_rate.cur)}{k.refund_rate.prev != null && <> (was {pct(k.refund_rate.prev)})</>}</>}
              spark={s.refunds_paise} href={qs('/admin/refunds', { status: 'refunded' })} />
            <Kpi tone="gold" icon={Hourglass} label="Pending payments" value={fmtCount(k.pending_payments.count)}
              alert={!!k.pending_payments.review}
              hint={k.pending_payments.count ? `${formatPaise(k.pending_payments.paise)}${k.pending_payments.review ? ` · ${fmtCount(k.pending_payments.review)} need a check` : ''}` : 'Nothing pending'}
              sparkLabel="Right now" href={qs('/admin/payments', { status: 'pending' })} />
            <Kpi tone="lav" icon={CalendarDays} label="Upcoming events" value={fmtCount(k.upcoming_events.total)}
              hint={`${fmtCount(k.upcoming_events.next_7d)} in the next 7 days`}
              spark={s.upcoming.map((u) => u.count)} sparkLabel="Events per day, next 14 days" href={qs('/admin/events', { tab: 'upcoming' })} />
            <Kpi tone="tea" icon={Radio} label="Live now" value={fmtCount(k.live_now)} badge={k.live_now > 0 ? <LiveBadge /> : undefined}
              hint={k.live_now ? 'Streaming right now' : 'Nothing live'} sparkLabel="Right now" href={qs('/admin/events', { tab: 'live' })} />
            <Kpi tone="rani" icon={Undo2} label="Refund requests" value={fmtCount(k.open_refunds.count)} alert={k.open_refunds.count > 0}
              hint={k.open_refunds.count ? `${formatPaise(k.open_refunds.paise)} to send` : 'Nothing waiting'}
              sparkLabel="Open now" href={qs('/admin/refunds', {})} />
          </section>

          {/* Focal row: revenue chart (wide) + next events (lavender date tiles) */}
          <div className="hfa-row-wide">
            <DesiCard title="Revenue by day" tone="rani" corner="marigold" pattern="dots"
              action={
                <div className="flex flex-wrap items-center gap-3">
                  <LegendKey kind="line" color={C1} label="This period" />
                  <LegendKey kind="line" color={INK_MUTED} dashed label="Previous period" />
                </div>
              }>
              {k.revenue_paise.cur === 0 && k.revenue_paise.prev === 0
                ? <DesiEmpty text="No paid bookings in this period or the one before." />
                : <>
                    <TrendLine days={s.days} cur={s.revenue_paise} prev={s.revenue_prev_paise} format={formatPaise} axisFormat={compactPaise}
                      label={`Revenue by day, ${rangeText}`} onPick={(day) => location.assign(qs('/admin/payments', { paid_from: day, paid_to: day }))} />
                    <DayTable days={s.days} cols={[
                      { label: 'Revenue', values: s.revenue_paise, format: formatPaise },
                      { label: 'Previous', values: s.revenue_prev_paise, format: formatPaise },
                      { label: 'Paid bookings', values: s.paid_bookings, format: fmtCount },
                    ]} />
                  </>}
            </DesiCard>

            <DesiCard title="Next events" tone="lav" corner="jasmine" action={<SeeAll href="/admin/events" />}>
              {d.next_events.length === 0 ? (
                <DesiEmpty text="No upcoming events. Create the next puja or havan.">
                  <a href="/admin/events/new" className="hfa-btn gold no-underline"><Plus className="h-4 w-4" />New event</a>
                </DesiEmpty>
              ) : (
                <ul className="grid gap-2">
                  {d.next_events.map((ev) => (
                    <li key={ev.id}>
                      <a href={ev.admin_url} className="flex min-h-[44px] items-center gap-3 rounded-2xl bg-white/70 p-2 no-underline transition-colors hover:bg-white">
                        <DateTile ms={ev.starts_at} live={ev.live} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {ev.live && <LiveBadge />}
                            <span className="truncate font-bold text-[var(--a-ink)]">{ev.title}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[14px] font-semibold text-[var(--a-muted)]">
                            <span>{ev.live ? 'Streaming now' : `${istDay(ev.starts_at)} · ${istTime(ev.starts_at)}`}</span>
                            <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />
                              {ev.capacity != null ? `${fmtCount(ev.booked)} / ${fmtCount(ev.capacity)} booked` : `${fmtCount(ev.booked)} booked`}
                            </span>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-[#6d4fd0]" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </DesiCard>
          </div>

          <DesiMogra />

          <div className="hfa-row">
            <DesiCard title="Bookings by day" tone="rani" corner="hibiscus" action={
              <div className="flex flex-wrap items-center gap-3">
                <LegendKey kind="rect" color={C1} label="Paid" />
                <LegendKey kind="rect" color={C2} label="Free" />
              </div>
            }>
              {k.seats.cur === 0
                ? <DesiEmpty text="No seats booked in this period." />
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
            </DesiCard>

            <DesiCard title="New sign-ups by day" tone="tea" corner="marigold" action={<SeeAll href={qs(customersHref, { joined_from: F, joined_to: T })}>Users</SeeAll>}>
              {k.signups.cur === 0
                ? <DesiEmpty text="No new sign-ups in this period." />
                : <>
                    <DayColumns days={s.days} format={fmtCount} label={`New sign-ups by day, ${rangeText}`}
                      series={[{ key: 'signups', label: 'sign-ups', color: TEA, values: s.signups }]}
                      onPick={(day) => location.assign(qs(customersHref, { joined_from: day, joined_to: day }))} />
                    <DayTable days={s.days} cols={[{ label: 'Sign-ups', values: s.signups, format: fmtCount }]} />
                  </>}
            </DesiCard>
          </div>

          <div className="hfa-row">
            <DesiCard title="Revenue by category" tone="gold" corner="yellow" pattern="dots" action={<SeeAll href={qs('/admin/payments', payRange)}>Payments</SeeAll>}>
              {d.by_category.length === 0
                ? <DesiEmpty text="No revenue in this period." />
                : <HBars rows={d.by_category.map((c) => ({
                    key: c.category ?? '_none', label: c.label, value: c.revenue_paise, valueText: formatPaise(c.revenue_paise),
                    sub: `${fmtCount(c.paid_bookings)} paid booking${c.paid_bookings === 1 ? '' : 's'}`,
                    href: qs('/admin/payments', { cat: c.category, ...payRange }),
                  }))} />}
            </DesiCard>

            <DesiCard title="UPI checkout funnel" tone="lav" corner="jasmine" action={<SeeAll href={qs('/admin/payments', { status: 'pending' })}>Pending</SeeAll>}>
              {!d.funnel
                ? <DesiEmpty text="No UPI checkouts started in this period." />
                : <>
                    <FunnelBars rows={([
                      ['started', 'Checkout started', d.funnel.started, 'linear-gradient(90deg,#a48cf0,#6d4fd0)'],
                      ['sent', 'Payment sent', d.funnel.sent, 'linear-gradient(90deg,#a48cf0,#d81b72)'],
                      ['confirmed', 'Payment confirmed', d.funnel.confirmed, 'linear-gradient(90deg,#f59e0b,#d81b72)'],
                      ['kept', 'Seat kept', d.funnel.kept, 'linear-gradient(90deg,#4fb5bd,#0e7c86)'],
                    ] as const).map(([key, label, v, grad]) => ({
                      key, label, value: v, grad,
                      text: `${fmtCount(v)}${key === 'started' ? '' : ` · ${pct(d.funnel!.started ? v / d.funnel!.started : null)}`}`,
                      href: key === 'sent' ? qs('/admin/payments', { status: 'pending' }) : qs('/admin/payments', payRange),
                    }))} />
                    <p className="hfa-note mt-3">One step per customer and event. “Seat kept” excludes refunds.</p>
                  </>}
            </DesiCard>
          </div>

          <DesiCard title="Top 10 events by revenue" tone="cream" pattern="bahi" corner="marigold" action={<SeeAll href="/admin/events">All events</SeeAll>}>
            {d.top_events.length === 0
              ? <DesiEmpty text="No paid bookings in this period." />
              : (
                <div className="hfa-scroll">
                  <table className="hfa-table min-w-[520px]">
                    <thead>
                      <tr><th className="w-14">#</th><th>Event</th><th className="text-right">Paid</th><th className="w-[38%]">Revenue</th></tr>
                    </thead>
                    <tbody>
                      {d.top_events.map((e, i) => {
                        const max = d.top_events[0].revenue_paise || 1;
                        const href = qs('/admin/bookings', { event: e.id });
                        return (
                          <tr key={e.id}>
                            <td>
                              <span className="grid h-10 w-10 place-items-center rounded-full border-2 border-white font-['Nunito'] font-black shadow-md"
                                style={{ background: MEDAL[i] ?? '#f1ebff', color: i < 3 ? '#3b1600' : '#6d4fd0' }}>{i + 1}</span>
                            </td>
                            <td className="max-w-0">
                              <a href={href} className="block min-h-[24px] truncate font-bold text-[var(--a-ink)] no-underline hover:underline">{e.title ?? e.id}</a>
                              {e.category_label && <div className="hfa-note truncate">{e.category_label}</div>}
                            </td>
                            <td className="text-right font-semibold tabular-nums">{fmtCount(e.paid_bookings)}</td>
                            <td>
                              <a href={href} className="flex items-center gap-2 no-underline" aria-label={`${e.title ?? e.id}: ${formatPaise(e.revenue_paise)}`}>
                                <span className="h-3 min-w-[2px] rounded-full" style={{ width: `${Math.max(1, (e.revenue_paise / max) * 70)}%`, background: GRAD }} aria-hidden />
                                <span className="shrink-0 font-['Nunito'] font-black tabular-nums text-[var(--a-plum)]">{formatPaise(e.revenue_paise)}</span>
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </DesiCard>

          {d.video_views && (
            <DesiCard title="Video views" tone="lav" corner="hibiscus" pattern="dots" action={<SeeAll href="/admin/events">All events</SeeAll>}>
              <DesiKpis>
                <Kpi tone="lav" icon={Eye} label="Viewers" value={fmtCount(d.video_views.viewers.cur)}
                  delta={<Delta {...d.video_views.viewers} vs={vs} />} hint="People who watched a video" href="/admin/events" />
                <Kpi tone="rani" icon={MonitorPlay} label="Plays" value={fmtCount(d.video_views.plays.cur)}
                  delta={<Delta {...d.video_views.plays} vs={vs} />} hint="Times play was pressed" href="/admin/events" />
              </DesiKpis>
              {d.video_views.by_event.length === 0
                ? <div className="mt-4"><DesiEmpty text="Nobody watched a video in this period." /></div>
                : (
                  <div className="hfa-scroll mt-4">
                    <table className="hfa-table min-w-[420px]">
                      <thead>
                        <tr><th className="w-12">#</th><th>Event</th><th className="text-right">Viewers</th><th className="text-right">Plays</th></tr>
                      </thead>
                      <tbody>
                        {d.video_views.by_event.map((e, i) => (
                          <tr key={e.listing_id}>
                            <td className="font-bold tabular-nums text-[var(--a-muted)]">{i + 1}</td>
                            <td className="max-w-0">
                              <a href={e.kind === 'free_video' ? `/admin/free-videos/${encodeURIComponent(e.listing_id)}` : `/admin/events/${encodeURIComponent(e.listing_id)}`} className="flex min-h-[24px] items-center gap-2 no-underline">
                                <span className="truncate font-bold text-[var(--a-ink)] hover:underline">{e.title ?? e.listing_id}</span>
                                {e.free && <DesiChip tone="tea" className="shrink-0">FREE</DesiChip>}
                                {e.kind === 'free_video' && <DesiChip tone="lav" className="shrink-0">Free video</DesiChip>}
                              </a>
                            </td>
                            <td className="text-right font-semibold tabular-nums">{fmtCount(e.viewers)}</td>
                            <td className="text-right font-semibold tabular-nums">{fmtCount(e.plays)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </DesiCard>
          )}

          <div className="hfa-row">
            <DesiCard title="Recent payments" tone="tea" corner="marigold" action={<SeeAll href="/admin/payments" />}>
              {d.recent_payments.length === 0 ? <DesiEmpty text="No payments yet." /> : (
                <ul className="grid gap-2">
                  {d.recent_payments.map((p) => (
                    <li key={p.id}>
                      <a href={qs('/admin/payments', { q: p.id })} className="flex min-h-[44px] items-center gap-3 rounded-2xl border-l-[6px] border-[#0e7c86] bg-white/75 px-3 py-2 no-underline transition-colors hover:bg-white">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-bold text-[var(--a-ink)]">{p.customer ?? 'Customer'}</div>
                          <div className="truncate text-[14px] font-semibold text-[var(--a-muted)]">{p.event_title ?? p.listing_id} · {istDateTime(p.at)}</div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="font-['Nunito'] text-[16px] font-black tabular-nums text-[#0e7c86]">{formatPaise(p.amount_paise)}</span>
                          <PayChip status={p.status} />
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </DesiCard>

            <DesiCard title="Open refund requests" tone="rani" corner="hibiscus" pattern="stripes" action={<SeeAll href="/admin/refunds" />}>
              {d.open_refunds.length === 0 ? <DesiEmpty text="No refund requests waiting." /> : (
                <ul className="grid gap-2">
                  {d.open_refunds.map((r) => (
                    <li key={r.id}>
                      <a href={qs('/admin/refunds', { q: r.id })} className="flex min-h-[44px] items-center gap-3 rounded-2xl border-l-[6px] border-[#d81b72] bg-white/85 px-3 py-2 no-underline transition-colors hover:bg-white">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-bold text-[var(--a-ink)]">{r.customer ?? 'Customer'}</div>
                          <div className="truncate text-[14px] font-semibold text-[var(--a-muted)]">
                            {r.event_title ?? 'Event'} · asked {istDay(r.requested_at)}{r.reason ? ` · “${r.reason}”` : ''}
                          </div>
                        </div>
                        <span className="shrink-0 font-['Nunito'] text-[16px] font-black tabular-nums text-[#d81b72]">{formatPaise(r.amount_paise)}</span>
                      </a>
                    </li>
                  ))}
                  {k.open_refunds.count > d.open_refunds.length && (
                    <li className="hfa-note px-1.5 pt-1 font-semibold">
                      +{fmtCount(k.open_refunds.count - d.open_refunds.length)} more waiting
                    </li>
                  )}
                </ul>
              )}
            </DesiCard>
          </div>
        </div>
      )}
    </div>
  );
}
