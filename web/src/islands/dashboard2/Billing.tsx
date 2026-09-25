/* Billing — [DASH2-BILLING 2026-09-25] Dashboard 2 payments, receipts and refunds.
 * Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md (GET /api/me/payments, /:id,
 * /:id/refund-request, /:id/receipt.pdf). Money arrives in PAISE; times are
 * epoch ms and shown in IST.
 *
 *  - A list of payment lines, newest first. A row expands a drawer directly
 *    below it (one open at a time); the drawer loads /api/me/payments/:id lazily.
 *  - Filters: an inline bar at md+, a vaul Drawer on phones. They sync to the
 *    URL (replaceState), and active filters show as removable chips.
 *  - Paging: `next_cursor`, loaded by an IntersectionObserver sentinel plus a
 *    "Load more" button (keyboard / no-IO fallback).
 *  - Telemetry: dash2_receipt_download, dash2_refund_request, dash2_filter_apply,
 *    dash2_search (lib/analytics.ts). Failures -> captureException.
 *  - No Clerk provider here: DashNav owns it (see accountApi.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import type { DateRange } from 'react-day-picker';
import {
  AlertCircle, ArrowDownToLine, CalendarDays, Check, ChevronDown, Copy, FileText, Filter, IndianRupee,
  Loader2, ReceiptText, RefreshCw, RotateCcw, Search, SearchX, Sparkles, Undo2, X,
} from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Calendar } from '../../components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '../../components/ui/drawer';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { Shimmer } from './Shimmer';
import {
  dayKey, dayToDate, errCode, errMessage, formatPaise, isAbort, istDate, istDateTime, istDay, istDayToMs, istTime, istYear, meApi, meBlob,
} from './accountApi';

/* ── types ──────────────────────────────────────────────────────────────── */

type PayStatus = 'paid' | 'pending' | 'refund_requested' | 'refunded';

interface PaymentLine {
  id: string;
  listing_id: string | null;
  event_title: string | null;
  category: string | null;
  category_label: string | null;
  event_starts_at: number | null;
  amount_paise: number;
  status: PayStatus;
  paid_at: number | null;
}
interface Refund {
  status: string;
  requested_at: number | null;
  refunded_at?: number;
  amount_paise?: number;
  refund_vpa?: string;
  refund_utr?: string;
}
interface PaymentDetail extends PaymentLine {
  utr?: string;
  payer_vpa?: string;
  order_id: string | null;
  sankalp_name?: string;
  refund?: Refund;
  can_request_refund: boolean;
  receipt_url: string | null;
}
interface PageResp { items: PaymentLine[]; next_cursor?: string }
interface Category { id: string; label: string }

const STATUS_META: Record<PayStatus, { label: string; cls: string; dot: string }> = {
  paid: { label: 'Paid', cls: 'bg-accent text-accent-foreground', dot: 'bg-accent' },
  pending: { label: 'Pending', cls: 'border-grand-gold bg-grand-gold/25 text-foreground', dot: 'bg-grand-gold' },
  // Amber: the landing gold warmed towards the landing red (no raw hex).
  refund_requested: {
    label: 'Refund requested',
    cls: 'bg-[color-mix(in_srgb,var(--grand-gold)_58%,var(--grand-red))] text-primary-foreground',
    dot: 'bg-[color-mix(in_srgb,var(--grand-gold)_58%,var(--grand-red))]',
  },
  refunded: { label: 'Refunded', cls: 'bg-secondary text-secondary-foreground', dot: 'bg-secondary' },
};
const STATUSES = Object.keys(STATUS_META) as PayStatus[];

/* ── filters <-> URL ────────────────────────────────────────────────────── */

interface Filters {
  q: string;
  cat: string;
  status: PayStatus[];
  event_from: string; event_to: string;   // YYYY-MM-DD (IST calendar days)
  paid_from: string; paid_to: string;
  min: string; max: string;               // rupees
}
const EMPTY: Filters = { q: '', cat: '', status: [], event_from: '', event_to: '', paid_from: '', paid_to: '', min: '', max: '' };

function readUrl(): Filters {
  if (typeof window === 'undefined') return EMPTY;
  const u = new URLSearchParams(location.search);
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(u.get(k) ?? '') ? u.get(k)! : '');
  const num = (k: string) => (/^\d{1,9}$/.test(u.get(k) ?? '') ? u.get(k)! : '');
  return {
    q: (u.get('q') ?? '').slice(0, 80),
    cat: (u.get('cat') ?? '').slice(0, 80),
    status: (u.get('status') ?? '').split(',').filter((s): s is PayStatus => (STATUSES as string[]).includes(s)),
    event_from: day('event_from'), event_to: day('event_to'),
    paid_from: day('paid_from'), paid_to: day('paid_to'),
    min: num('min'), max: num('max'),
  };
}
function writeUrl(f: Filters) {
  const u = new URL(location.href);
  for (const k of Object.keys(EMPTY) as (keyof Filters)[]) {
    const v = k === 'status' ? f.status.join(',') : (f[k] as string);
    if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
  }
  history.replaceState(history.state, '', u.toString());
}
function toQuery(f: Filters) {
  return {
    q: f.q.trim() || undefined,
    cat: f.cat || undefined,
    status: f.status.length ? f.status.join(',') : undefined,
    event_from: f.event_from ? istDayToMs(f.event_from) : undefined,
    event_to: f.event_to ? istDayToMs(f.event_to, true) : undefined,
    paid_from: f.paid_from ? istDayToMs(f.paid_from) : undefined,
    paid_to: f.paid_to ? istDayToMs(f.paid_to, true) : undefined,
    min: f.min || undefined,
    max: f.max || undefined,
  };
}
const activeCount = (f: Filters) =>
  (f.q.trim() ? 1 : 0) + (f.cat ? 1 : 0) + (f.status.length ? 1 : 0) + (f.event_from || f.event_to ? 1 : 0) +
  (f.paid_from || f.paid_to ? 1 : 0) + (f.min || f.max ? 1 : 0);

const shortDay = (d: string) => (d ? istDate(istDayToMs(d)) : '');
function rangeLabel(from: string, to: string, empty: string) {
  if (!from && !to) return empty;
  if (from && to) return from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
  return from ? `From ${shortDay(from)}` : `Until ${shortDay(to)}`;
}
function amountLabel(min: string, max: string) {
  const r = (v: string) => formatPaise(Number(v) * 100);
  if (min && max) return `${r(min)} – ${r(max)}`;
  if (min) return `${r(min)}+`;
  if (max) return `Up to ${r(max)}`;
  return 'Any amount';
}

/* ── small pieces ───────────────────────────────────────────────────────── */

function StatusChip({ status, className }: { status: PayStatus; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full border border-transparent px-2.5 py-0.5 text-[11.5px] font-extrabold tracking-[0.04em]', m.cls, className)}>
      {m.label}
    </span>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch (e) {
      captureException(e, { where: 'dash2_billing_copy' });
      toast.error('Could not copy. Long-press the number to copy it instead.');
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="select-all break-all font-dashbody font-extrabold tabular-nums tracking-[0.06em]">{value}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {done ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
      </button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 sm:grid sm:grid-cols-[140px_1fr] sm:justify-start">
      <dt className="shrink-0 text-[13px] font-bold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-[14px] font-semibold text-foreground sm:text-left">{children}</dd>
    </div>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/40 bg-background/70 p-4">
      <h3 className="mb-1 flex items-center gap-2 font-dash text-[14px] font-bold text-grand-teal">{icon}{title}</h3>
      <dl className="divide-y divide-border/30">{children}</dl>
    </section>
  );
}

/* ── the expanded drawer (below a row) ──────────────────────────────────── */

function RefundTimeline({ refund }: { refund: Refund }) {
  const done = refund.status === 'refunded';
  const steps = [
    { key: 'req', title: 'Refund requested', at: refund.requested_at, on: true },
    { key: 'done', title: done ? 'Refunded' : 'Refund in progress', at: refund.refunded_at ?? null, on: done },
  ];
  return (
    <section className="rounded-xl border border-border/40 bg-background/70 p-4">
      <h3 className="mb-3 flex items-center gap-2 font-dash text-[14px] font-bold text-grand-teal"><Undo2 className="h-4 w-4" />Refund</h3>
      <ol className="relative ml-2 space-y-4 border-l-2 border-border/50 pl-5">
        {steps.map((s) => (
          <li key={s.key} className="relative">
            <span
              aria-hidden
              className={cn(
                'absolute -left-[29px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-card',
                s.on ? 'bg-accent' : 'border-2 border-border bg-card',
              )}
            >
              {s.on && <Check className="h-2.5 w-2.5 text-accent-foreground" strokeWidth={3} />}
            </span>
            <div className="text-[14px] font-extrabold text-foreground">{s.title}</div>
            <div className="text-[12.5px] font-semibold text-muted-foreground">
              {s.at ? istDateTime(s.at) : s.key === 'done' ? 'Refunds are sent by hand from our bank, usually within 5–7 working days.' : '—'}
            </div>
          </li>
        ))}
      </ol>
      <dl className="mt-3 divide-y divide-border/30">
        {refund.amount_paise != null && <Field label="Amount">{formatPaise(refund.amount_paise)}</Field>}
        {refund.refund_vpa && <Field label="To UPI id">{refund.refund_vpa}</Field>}
        {refund.refund_utr && <Field label="Refund UTR"><CopyValue value={refund.refund_utr} label="refund UTR" /></Field>}
        {!refund.refund_vpa && refund.status !== 'refunded' && (
          <p className="pt-2 text-[12.5px] font-semibold text-muted-foreground">
            Add a UPI id in <a className="font-bold text-accent underline underline-offset-2" href="/dashboard/profile#upi">Profile</a> so we know where to send it.
          </p>
        )}
      </dl>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2" aria-busy="true" aria-label="Loading payment details">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border border-border/40 bg-background/70 p-4">
          <Shimmer className="h-4 w-28" />
          {[0, 1, 2, 3].map((j) => <Shimmer key={j} className="h-3.5 w-full" />)}
        </div>
      ))}
    </div>
  );
}

function PaymentDrawer({
  detail, error, onRetry, onRefunded,
}: {
  detail: PaymentDetail | undefined;
  error: string | undefined;
  onRetry: () => void;
  onRefunded: (id: string, refund: Refund) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refunding, setRefunding] = useState(false);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center">
        <AlertCircle className="h-5 w-5 shrink-0 text-primary" />
        <p className="flex-1 text-[14px] font-semibold text-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw /> Try again</Button>
      </div>
    );
  }
  if (!detail) return <DetailSkeleton />;

  const d = detail;
  const download = async () => {
    if (!d.receipt_url || downloading) return;
    setDownloading(true);
    const t0 = performance.now();
    try {
      const { blob, filename } = await meBlob(d.receipt_url);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? `saathum-receipt-${d.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      capture('dash2_receipt_download', { payment_id: d.id, status: d.status, ok: true, bytes: blob.size, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      capture('dash2_receipt_download', { payment_id: d.id, status: d.status, ok: false, reason: errCode(e) ?? 'network' });
      captureException(e, { where: 'dash2_receipt_download', payment_id: d.id });
      toast.error(errMessage(e, 'We could not download the receipt. Please try again.'));
    } finally {
      setDownloading(false);
    }
  };

  const requestRefund = async () => {
    setRefunding(true);
    try {
      const r = await meApi<{ ok: boolean; refund: Refund }>(`/api/me/payments/${encodeURIComponent(d.id)}/refund-request`, {
        method: 'POST', body: { reason: reason.trim() || null },
      });
      capture('dash2_refund_request', { payment_id: d.id, ok: true, has_reason: !!reason.trim() });
      onRefunded(d.id, r.refund);
      setRefundOpen(false);
      setReason('');
      toast.success('Refund requested', { description: 'We will send it to your UPI id and let you know.' });
    } catch (e) {
      const code = errCode(e);
      capture('dash2_refund_request', { payment_id: d.id, ok: false, reason: code ?? 'network' });
      if (code !== 'refund_window_closed' && code !== 'refund_already_requested') captureException(e, { where: 'dash2_refund_request', payment_id: d.id });
      toast.error(errMessage(e, 'We could not request the refund. Please try again.'));
      if (code === 'refund_window_closed' || code === 'refund_already_requested') { setRefundOpen(false); onRetry(); }
    } finally {
      setRefunding(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Section icon={<Sparkles className="h-4 w-4" />} title="What it was for">
          <Field label="Ritual">{d.event_title ?? 'Saathum booking'}</Field>
          {d.listing_id && <Field label="Event ID"><CopyValue value={d.listing_id} label="event ID" /></Field>}
          {(d.category_label || d.category) && <Field label="Category">{d.category_label ?? d.category}</Field>}
          <Field label="Event date">{d.event_starts_at ? istDay(d.event_starts_at) : 'To be scheduled'}</Field>
          {d.event_starts_at && <Field label="Time">{istTime(d.event_starts_at)}</Field>}
          {d.sankalp_name && <Field label="Sankalp name">{d.sankalp_name}</Field>}
        </Section>
        <Section icon={<IndianRupee className="h-4 w-4" />} title="Payment">
          <Field label="Amount"><span className="font-dash text-[15px] font-bold">{formatPaise(d.amount_paise)}</span></Field>
          <Field label="Paid on">{d.paid_at ? istDateTime(d.paid_at) : 'Waiting for the bank to confirm'}</Field>
          {d.payer_vpa && <Field label="Paid from">{d.payer_vpa}</Field>}
          {d.utr && <Field label="UPI ref (UTR)"><CopyValue value={d.utr} label="UPI transaction number" /></Field>}
          {d.order_id && <Field label="Order ID"><CopyValue value={d.order_id} label="order ID" /></Field>}
        </Section>
      </div>
      {d.refund && <RefundTimeline refund={d.refund} />}

      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
        {d.receipt_url ? (
          <Button variant="accent" onClick={download} disabled={downloading} className="sm:w-auto">
            {downloading ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
            {downloading ? 'Preparing receipt…' : 'Download receipt (PDF)'}
          </Button>
        ) : (
          <p className="text-[13px] font-semibold text-muted-foreground">The receipt will be ready once the bank confirms your payment.</p>
        )}
        {d.can_request_refund && (
          <Button variant="outline" className="text-primary" onClick={() => setRefundOpen(true)}>
            <RotateCcw /> Request refund
          </Button>
        )}
      </div>

      <AlertDialog open={refundOpen} onOpenChange={(o) => !refunding && setRefundOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-dash">Request a refund?</AlertDialogTitle>
            <AlertDialogDescription className="text-[14px] leading-relaxed">
              You can ask for a full refund of <strong className="text-foreground">{formatPaise(d.amount_paise)}</strong> until 24 hours before
              the ritual starts. Your seat is released, and we send the money back by hand to your default UPI id, usually within 5–7 working days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`refund-reason-${d.id}`} className="text-[13px] font-bold">Reason <span className="font-semibold text-muted-foreground">(optional)</span></Label>
            <textarea
              id={`refund-reason-${d.id}`}
              value={reason}
              maxLength={500}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Plans changed, booked the wrong date…"
              className="flex w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={refunding}>Keep my booking</AlertDialogCancel>
            <AlertDialogAction
              disabled={refunding}
              onClick={(e) => { e.preventDefault(); void requestRefund(); }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {refunding ? <Loader2 className="animate-spin" /> : <RotateCcw />} Request refund
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── one row ────────────────────────────────────────────────────────────── */

function PaymentRow({
  line, open, onToggle, children, index,
}: { line: PaymentLine; open: boolean; onToggle: (o: boolean) => void; children: ReactNode; index: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      layout={reduce ? false : 'position'}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.22, delay: Math.min(index, 8) * 0.03 }}
      className={cn('dash-surface overflow-hidden transition-shadow', open && 'shadow-[var(--dash-shadow-lg)] ring-1 ring-accent/30')}
    >
      <Collapsible open={open} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 sm:px-5 sm:py-4"
          >
            <span aria-hidden className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground sm:flex">
              <ReceiptText className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-dash text-[15px] font-bold leading-snug text-foreground sm:text-[16px]">
                {line.event_title ?? 'Saathum booking'}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] font-semibold text-muted-foreground">
                <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{line.event_starts_at ? istDate(line.event_starts_at) : 'Date to be set'}</span>
                {(line.category_label || line.category) && (
                  <Badge variant="outline" className="border-border/70 px-2 py-0 text-[11px] font-bold text-foreground/80">{line.category_label ?? line.category}</Badge>
                )}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1.5">
              <span className="font-dash text-[16px] font-bold tabular-nums text-foreground sm:text-[17px]">{formatPaise(line.amount_paise)}</span>
              <StatusChip status={line.status} />
            </span>
            <ChevronDown
              aria-hidden
              className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none">
          <div className="border-t border-border/40 bg-muted/20 px-4 py-4 sm:px-5">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </motion.li>
  );
}

/* ── filters ────────────────────────────────────────────────────────────── */

function DateRangePicker({
  label, from, to, onChange, className,
}: { label: string; from: string; to: string; onChange: (from: string, to: string) => void; className?: string }) {
  const selected: DateRange | undefined = from || to ? { from: dayToDate(from), to: dayToDate(to) } : undefined;
  const on = !!(from || to);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn('h-11 justify-start gap-2 font-semibold', on && 'border-accent text-accent', className)}>
          <CalendarDays className="h-4 w-4" />
          <span className="truncate">{rangeLabel(from, to, label)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          numberOfMonths={1}
          selected={selected}
          defaultMonth={dayToDate(from) ?? dayToDate(to)}
          onSelect={(r?: DateRange) => onChange(r?.from ? dayKey(r.from) : '', r?.to ? dayKey(r.to) : r?.from ? dayKey(r.from) : '')}
          initialFocus
        />
        <div className="flex items-center justify-between gap-2 border-t border-border/40 p-2">
          <span className="px-1 text-[12px] font-semibold text-muted-foreground">{label} (IST)</span>
          <Button size="sm" variant="ghost" disabled={!on} onClick={() => onChange('', '')}>Clear</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AmountFields({ min, max, onChange }: { min: string; max: string; onChange: (min: string, max: string) => void }) {
  const clean = (v: string) => v.replace(/\D/g, '').slice(0, 9);
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-1">
        <Label htmlFor="bf-min" className="text-[12px] font-bold text-muted-foreground">Min ₹</Label>
        <Input id="bf-min" inputMode="numeric" placeholder="0" value={min} onChange={(e) => onChange(clean(e.target.value), max)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="bf-max" className="text-[12px] font-bold text-muted-foreground">Max ₹</Label>
        <Input id="bf-max" inputMode="numeric" placeholder="Any" value={max} onChange={(e) => onChange(min, clean(e.target.value))} />
      </div>
    </div>
  );
}

function StatusToggles({ value, onChange }: { value: PayStatus[]; onChange: (v: PayStatus[]) => void }) {
  const reduce = useReducedMotion();
  return (
    <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
      {STATUSES.map((s) => {
        const on = value.includes(s);
        return (
          <motion.button
            key={s}
            type="button"
            aria-pressed={on}
            whileTap={reduce ? undefined : { scale: 0.95 }}
            onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
            )}
          >
            <span aria-hidden className={cn('h-2 w-2 rounded-full', on ? 'bg-accent-foreground' : STATUS_META[s].dot)} />
            {STATUS_META[s].label}
          </motion.button>
        );
      })}
    </div>
  );
}

function CategorySelect({ value, cats, onChange, className }: { value: string; cats: Category[]; onChange: (v: string) => void; className?: string }) {
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger aria-label="Category" className={cn('font-semibold', value && 'border-accent text-accent', className)}>
        <SelectValue placeholder="All categories" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All categories</SelectItem>
        {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function SearchBox({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        maxLength={80}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search ritual or UPI ref"
        aria-label="Search payments"
        className="pl-9"
      />
    </div>
  );
}

function ActiveChips({ f, cats, set, clear }: { f: Filters; cats: Category[]; set: (p: Partial<Filters>) => void; clear: () => void }) {
  const reduce = useReducedMotion();
  const chips: { key: string; label: string; remove: () => void }[] = [];
  if (f.q.trim()) chips.push({ key: 'q', label: `“${f.q.trim()}”`, remove: () => set({ q: '' }) });
  if (f.cat) chips.push({ key: 'cat', label: cats.find((c) => c.id === f.cat)?.label ?? f.cat, remove: () => set({ cat: '' }) });
  for (const s of f.status) chips.push({ key: `s-${s}`, label: STATUS_META[s].label, remove: () => set({ status: f.status.filter((x) => x !== s) }) });
  if (f.event_from || f.event_to) chips.push({ key: 'ev', label: `Event: ${rangeLabel(f.event_from, f.event_to, '')}`, remove: () => set({ event_from: '', event_to: '' }) });
  if (f.paid_from || f.paid_to) chips.push({ key: 'pd', label: `Paid: ${rangeLabel(f.paid_from, f.paid_to, '')}`, remove: () => set({ paid_from: '', paid_to: '' }) });
  if (f.min || f.max) chips.push({ key: 'amt', label: amountLabel(f.min, f.max), remove: () => set({ min: '', max: '' }) });
  if (!chips.length) return null;
  return (
    <LayoutGroup>
      <motion.div layout={!reduce} className="flex flex-wrap items-center gap-2" aria-label="Active filters">
        <AnimatePresence initial={false}>
          {chips.map((c) => (
            <motion.span
              key={c.key}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85 }}
              transition={{ duration: reduce ? 0 : 0.16 }}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 pl-3 pr-1 text-[12.5px] font-bold text-accent"
            >
              <span className="max-w-[220px] truncate">{c.label}</span>
              <button
                type="button"
                onClick={c.remove}
                aria-label={`Remove filter ${c.label}`}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.span>
          ))}
          <motion.button
            key="clear"
            layout={!reduce}
            type="button"
            onClick={clear}
            className="h-8 rounded-full px-2 text-[12.5px] font-extrabold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear all
          </motion.button>
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>
  );
}

/* ── states ─────────────────────────────────────────────────────────────── */

function ListSkeleton() {
  return (
    <ul className="space-y-3" aria-busy="true" aria-label="Loading payments">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="dash-surface flex items-center gap-4 px-4 py-4 sm:px-5">
          <Shimmer className="hidden h-11 w-11 rounded-xl sm:block" />
          <div className="flex-1 space-y-2"><Shimmer className="h-4 w-3/5" /><Shimmer className="h-3 w-2/5" /></div>
          <div className="flex flex-col items-end gap-2"><Shimmer className="h-4 w-16" /><Shimmer className="h-5 w-20 rounded-full" /></div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="dash-surface flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground shadow-[var(--dash-shadow)]">
        {filtered ? <SearchX className="h-7 w-7" /> : <FileText className="h-7 w-7" />}
      </span>
      <h2 className="font-dash text-[18px] font-bold text-grand-teal">{filtered ? 'Nothing matches these filters' : 'No payments yet'}</h2>
      <p className="mt-2 max-w-sm text-[14px] font-semibold text-muted-foreground">
        {filtered
          ? 'Try a wider date range or fewer filters.'
          : 'When you book a puja or havan, its payment, receipt and any refund will show up here.'}
      </p>
      <div className="mt-5">
        {filtered ? (
          <Button variant="outline" onClick={onClear}><X /> Clear filters</Button>
        ) : (
          <Button asChild><a href="/dashboard">Book an event</a></Button>
        )}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="dash-surface flex flex-col items-center px-6 py-10 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><AlertCircle className="h-7 w-7" /></span>
      <h2 className="font-dash text-[17px] font-bold text-foreground">We couldn’t load your payments</h2>
      <p className="mt-2 max-w-sm text-[14px] font-semibold text-muted-foreground">{message}</p>
      <Button className="mt-5" variant="outline" onClick={onRetry}><RefreshCw /> Try again</Button>
    </div>
  );
}

function SummaryStrip({ items, partial }: { items: PaymentLine[]; partial: boolean }) {
  const year = istYear(Date.now());
  const kept = items.filter((p) => (p.status === 'paid' || p.status === 'refund_requested') && p.paid_at && istYear(p.paid_at) === year);
  if (!kept.length) return null;
  const total = kept.reduce((s, p) => s + p.amount_paise, 0);
  const rituals = new Set(kept.map((p) => p.listing_id ?? p.id)).size;
  return (
    <div className="dash-surface relative grid grid-cols-2 overflow-hidden">
      <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-grand-gold via-grand-red/60 to-grand-teal" />
      <div className="px-4 py-4 sm:px-6">
        <div className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Paid in {year}</div>
        <div className="mt-1 font-dash text-[22px] font-bold tabular-nums text-grand-teal sm:text-[26px]">{formatPaise(total)}</div>
      </div>
      <div className="border-l border-border/40 px-4 py-4 sm:px-6">
        <div className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Rituals</div>
        <div className="mt-1 font-dash text-[22px] font-bold tabular-nums text-grand-teal sm:text-[26px]">{rituals}</div>
      </div>
      {partial && (
        <div className="col-span-2 border-t border-border/30 px-4 py-1.5 text-[11.5px] font-semibold text-muted-foreground sm:px-6">
          From loaded payments — scroll to load the rest.
        </div>
      )}
    </div>
  );
}

/* ── screen ─────────────────────────────────────────────────────────────── */

export default function Billing() {
  const [f, setF] = useState<Filters>(EMPTY);
  const [qLive, setQLive] = useState('');
  const [items, setItems] = useState<PaymentLine[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreErr, setMoreErr] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PaymentDetail>>({});
  const [detailErr, setDetailErr] = useState<Record<string, string>>({});
  const [catalogCats, setCatalogCats] = useState<Category[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const listAbort = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const firstLoad = useRef(true);

  // URL -> state once on mount.
  useEffect(() => {
    const init = readUrl();
    setF(init);
    setQLive(init.q);
    setHydrated(true);
  }, []);

  // Debounced free text.
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => setF((cur) => (cur.q === qLive ? cur : { ...cur, q: qLive })), 350);
    return () => clearTimeout(t);
  }, [qLive, hydrated]);

  const set = useCallback((p: Partial<Filters>) => {
    if ('q' in p) setQLive(p.q ?? '');
    setF((cur) => ({ ...cur, ...p }));
  }, []);
  const clearAll = useCallback(() => { setQLive(''); setF(EMPTY); }, []);

  // Categories for the filter: the live catalog's list, plus any seen on loaded rows.
  useEffect(() => {
    let dead = false;
    meApi<{ categories?: { id: string; label: string }[] }>('/api/me/catalog')
      .then((r) => { if (!dead) setCatalogCats((r.categories ?? []).map((c) => ({ id: c.id, label: c.label }))); })
      .catch((e) => { if (!isAbort(e)) captureException(e, { where: 'dash2_billing_categories' }); });
    return () => { dead = true; };
  }, []);
  const cats = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of catalogCats) m.set(c.id, c.label);
    for (const p of items) if (p.category && !m.has(p.category)) m.set(p.category, p.category_label ?? p.category);
    if (f.cat && !m.has(f.cat)) m.set(f.cat, f.cat);
    return [...m].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [catalogCats, items, f.cat]);

  const fetchPage = useCallback(async (filters: Filters, after?: string, signal?: AbortSignal) =>
    meApi<PageResp>('/api/me/payments', { query: { ...toQuery(filters), cursor: after }, signal }), []);

  const loadFirst = useCallback(async (filters: Filters) => {
    listAbort.current?.abort();
    const ac = new AbortController();
    listAbort.current = ac;
    setPhase('loading');
    setMoreErr('');
    setOpenId(null);
    const t0 = performance.now();
    try {
      const r = await fetchPage(filters, undefined, ac.signal);
      if (ac.signal.aborted) return;
      setItems(r.items ?? []);
      setCursor(r.next_cursor);
      setPhase('ready');
      const n = activeCount(filters);
      if (!firstLoad.current || n) {
        capture('dash2_filter_apply', {
          screen: 'billing', active: n, results: r.items?.length ?? 0, has_more: !!r.next_cursor,
          filters: Object.entries(toQuery(filters)).filter(([, v]) => v != null).map(([k]) => k).join(','),
          ms: Math.round(performance.now() - t0),
        });
        if (filters.q.trim()) capture('dash2_search', { screen: 'billing', q_len: filters.q.trim().length, results: r.items?.length ?? 0 });
      }
      firstLoad.current = false;
    } catch (e) {
      if (isAbort(e) || ac.signal.aborted) return;
      captureException(e, { where: 'dash2_billing_list' });
      setError(errMessage(e));
      setPhase('error');
    }
  }, [fetchPage]);

  // Filters -> URL + reload.
  useEffect(() => {
    if (!hydrated) return;
    writeUrl(f);
    void loadFirst(f);
  }, [f, hydrated, loadFirst]);

  useEffect(() => () => listAbort.current?.abort(), []);

  const loadMore = useCallback(async () => {
    if (!cursor || moreBusy || phase !== 'ready') return;
    setMoreBusy(true);
    setMoreErr('');
    const sig = listAbort.current?.signal;
    try {
      const r = await fetchPage(f, cursor, sig);
      if (sig?.aborted) return;
      setItems((cur) => {
        const seen = new Set(cur.map((x) => x.id));
        return [...cur, ...(r.items ?? []).filter((x) => !seen.has(x.id))];
      });
      setCursor(r.next_cursor);
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'dash2_billing_more' });
      setMoreErr(errMessage(e));
    } finally {
      setMoreBusy(false);
    }
  }, [cursor, moreBusy, phase, fetchPage, f]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || moreErr || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) void loadMore(); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore, moreErr]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailErr((m) => { const n = { ...m }; delete n[id]; return n; });
    try {
      const d = await meApi<PaymentDetail>(`/api/me/payments/${encodeURIComponent(id)}`);
      setDetails((m) => ({ ...m, [id]: d }));
      // Keep the row in step with the detail (a status may have moved on).
      setItems((cur) => cur.map((x) => (x.id === id ? { ...x, status: d.status, paid_at: d.paid_at } : x)));
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'dash2_billing_detail', payment_id: id });
      setDetailErr((m) => ({ ...m, [id]: errMessage(e, 'We could not load this payment. Please try again.') }));
    }
  }, []);

  const toggle = (id: string, open: boolean) => {
    setOpenId(open ? id : null);
    if (open && !details[id]) void loadDetail(id);
  };

  const onRefunded = (id: string, refund: Refund) => {
    setItems((cur) => cur.map((x) => (x.id === id ? { ...x, status: 'refund_requested' } : x)));
    setDetails((m) => (m[id] ? { ...m, [id]: { ...m[id], status: 'refund_requested', refund, can_request_refund: false } } : m));
  };

  const n = activeCount({ ...f, q: qLive });

  return (
    <div className="space-y-5 font-dashbody">
      {phase === 'ready' && !n && <SummaryStrip items={items} partial={!!cursor} />}

      {/* Desktop: inline filter bar */}
      <div className="dash-surface hidden flex-col gap-3 p-3 md:flex">
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={qLive} onChange={setQLive} className="min-w-[220px] flex-[2]" />
          <CategorySelect value={f.cat} cats={cats} onChange={(v) => set({ cat: v })} className="w-[190px] flex-1" />
          <DateRangePicker label="Event date" from={f.event_from} to={f.event_to} onChange={(a, b) => set({ event_from: a, event_to: b })} />
          <DateRangePicker label="Paid on" from={f.paid_from} to={f.paid_to} onChange={(a, b) => set({ paid_from: a, paid_to: b })} />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className={cn('h-11 gap-2 font-semibold', (f.min || f.max) && 'border-accent text-accent')}>
                <IndianRupee className="h-4 w-4" />{amountLabel(f.min, f.max)}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3">
              <div className="font-dash text-[14px] font-bold">Amount</div>
              <AmountFields min={f.min} max={f.max} onChange={(a, b) => set({ min: a, max: b })} />
            </PopoverContent>
          </Popover>
        </div>
        <StatusToggles value={f.status} onChange={(v) => set({ status: v })} />
      </div>

      {/* Phone: search + a Filters button that opens a bottom drawer */}
      <div className="flex items-center gap-2 md:hidden">
        <SearchBox value={qLive} onChange={setQLive} className="flex-1" />
        <Button variant="outline" size="icon" className="relative shrink-0" onClick={() => setDrawerOpen(true)} aria-label={`Filters${n ? `, ${n} active` : ''}`}>
          <Filter />
          {n > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-extrabold text-primary-foreground">{n}</span>
          )}
        </Button>
      </div>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} shouldScaleBackground={false}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle>Filter payments</DrawerTitle>
            <DrawerDescription>Dates are in India time (IST).</DrawerDescription>
          </DrawerHeader>
          <div className="space-y-5 overflow-y-auto px-4 pb-2">
            <div className="space-y-2"><Label className="text-[13px] font-bold">Category</Label><CategorySelect value={f.cat} cats={cats} onChange={(v) => set({ cat: v })} /></div>
            <div className="space-y-2"><Label className="text-[13px] font-bold">Status</Label><StatusToggles value={f.status} onChange={(v) => set({ status: v })} /></div>
            <div className="grid grid-cols-1 gap-3">
              <div className="space-y-2"><Label className="text-[13px] font-bold">Event date</Label>
                <DateRangePicker label="Any event date" from={f.event_from} to={f.event_to} onChange={(a, b) => set({ event_from: a, event_to: b })} className="w-full" /></div>
              <div className="space-y-2"><Label className="text-[13px] font-bold">Payment date</Label>
                <DateRangePicker label="Any payment date" from={f.paid_from} to={f.paid_to} onChange={(a, b) => set({ paid_from: a, paid_to: b })} className="w-full" /></div>
            </div>
            <div className="space-y-2"><Label className="text-[13px] font-bold">Amount</Label><AmountFields min={f.min} max={f.max} onChange={(a, b) => set({ min: a, max: b })} /></div>
          </div>
          <DrawerFooter className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onClick={clearAll} disabled={!n}>Clear all</Button>
            <Button variant="accent" className="flex-1" onClick={() => setDrawerOpen(false)}>
              {phase === 'loading' ? <Loader2 className="animate-spin" /> : null}
              Show {phase === 'ready' ? `${items.length}${cursor ? '+' : ''} ` : ''}results
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <ActiveChips f={{ ...f, q: qLive }} cats={cats} set={set} clear={clearAll} />

      <div aria-live="polite" className="sr-only">
        {phase === 'ready' ? `${items.length}${cursor ? ' or more' : ''} payments` : phase === 'loading' ? 'Loading payments' : ''}
      </div>

      {phase === 'loading' && <ListSkeleton />}
      {phase === 'error' && <ErrorState message={error} onRetry={() => void loadFirst(f)} />}
      {phase === 'ready' && items.length === 0 && <EmptyState filtered={n > 0} onClear={clearAll} />}
      {phase === 'ready' && items.length > 0 && (
        <>
          <ul className="space-y-3">
            {items.map((line, i) => (
              <PaymentRow key={line.id} line={line} index={i} open={openId === line.id} onToggle={(o) => toggle(line.id, o)}>
                <PaymentDrawer
                  detail={details[line.id]}
                  error={detailErr[line.id]}
                  onRetry={() => void loadDetail(line.id)}
                  onRefunded={onRefunded}
                />
              </PaymentRow>
            ))}
          </ul>
          <div ref={sentinel} className="flex flex-col items-center gap-2 pt-1">
            {cursor ? (
              <>
                {moreErr && <p className="text-[13px] font-semibold text-primary">{moreErr}</p>}
                <Button variant="outline" onClick={() => void loadMore()} disabled={moreBusy}>
                  {moreBusy ? <Loader2 className="animate-spin" /> : moreErr ? <RefreshCw /> : <ChevronDown />}
                  {moreBusy ? 'Loading…' : moreErr ? 'Try again' : 'Load more'}
                </Button>
              </>
            ) : (
              items.length > 8 && <p className="text-[12.5px] font-semibold text-muted-foreground">That’s everything.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
