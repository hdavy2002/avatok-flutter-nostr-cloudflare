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
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, BellRing, CalendarDays, CalendarPlus, Clock, Download, Flame, Loader2, Package, Play, Radio, Ticket,
} from 'lucide-react';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { toast } from '../../components/ui/sonner';
import {
  authedBlob, authedRequest, EmptyState, ErrorState, errorMessage, fetchMyCheckoutsSafe, fmtAddressOneLine, fmtDuration,
  fmtIstDateTime, listingImage, putSaathumCheckoutAddress, Shimmer, type EventItem, type EventsResponse,
  type SaathumAddress, type SaathumCheckoutSummary,
} from '../../components/dash2/shared';
import { YouTubeGuardedPlayer, type GuardedPlayerHandle } from '../../components/dash2/YouTubeGuardedPlayer';

/** The one Saa Thum checkout backing this listing for "my events" purposes — prefer the
 * newest CONFIRMED checkout (prasad/receipt/sankalp only make sense once paid), falling
 * back to the newest of any status so a not-yet-confirmed prasad address can still show.
 * No match (a non-Saa-Thum booking, or my-checkouts unavailable) → null, no UI added. */
function checkoutFor(checkouts: SaathumCheckoutSummary[], listingId: string): SaathumCheckoutSummary | null {
  const matches = checkouts.filter((c) => c.listing.id === listingId);
  if (!matches.length) return null;
  const confirmed = matches.filter((c) => c.status === 'confirmed');
  const pool = confirmed.length ? confirmed : matches;
  return pool.reduce((best, c) => (c.created_at > best.created_at ? c : best));
}

const PIN_RE = /^\d{6}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

interface AddressDraft { name: string; phone: string; line1: string; line2: string; city: string; state: string; pincode: string }
function draftFromAddress(a: SaathumAddress | null): AddressDraft {
  return { name: a?.name ?? '', phone: a?.phone ?? '', line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '', state: a?.state ?? '', pincode: a?.pincode ?? '' };
}

function AddressDialog({
  open, onOpenChange, checkout, onSaved,
}: { open: boolean; onOpenChange: (o: boolean) => void; checkout: SaathumCheckoutSummary; onSaved: (c: SaathumCheckoutSummary) => void }) {
  const [d, setD] = useState<AddressDraft>(() => draftFromAddress(checkout.address));
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setD(draftFromAddress(checkout.address)); setFieldErr({}); } }, [open, checkout.address]);
  const up = (p: Partial<AddressDraft>) => setD((c) => ({ ...c, ...p }));

  const submit = async () => {
    const t = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.trim()])) as AddressDraft;
    const errs: Record<string, string> = {};
    if (!t.name) errs.name = 'Enter the name for delivery.';
    if (!PHONE_RE.test(t.phone)) errs.phone = 'Enter a 10-digit mobile number.';
    if (!t.line1) errs.line1 = 'Enter the first address line.';
    if (!t.city) errs.city = 'Enter the city.';
    if (!t.state) errs.state = 'Enter the state.';
    if (!PIN_RE.test(t.pincode)) errs.pincode = 'Enter a 6-digit PIN code.';
    if (Object.keys(errs).length) { setFieldErr(errs); return; }
    setSaving(true);
    try {
      const address: SaathumAddress = { name: t.name, phone: t.phone, line1: t.line1, line2: t.line2 || null, city: t.city, state: t.state, pincode: t.pincode };
      const updated = await putSaathumCheckoutAddress(checkout.checkout_id, address);
      capture('dash2_prasad_address_changed', { ok: true });
      onSaved(updated);
      onOpenChange(false);
      toast.success('Address updated');
    } catch (e) {
      capture('dash2_prasad_address_changed', { ok: false, reason: e instanceof ApiError ? e.error : 'network' });
      if (!(e instanceof ApiError) || e.status >= 500) captureException(e, { where: 'dash2_prasad_address_changed' });
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const F = (k: keyof AddressDraft, label: string, extra: Partial<ComponentProps<typeof Input>> = {}) => (
    <div>
      <Label htmlFor={`prasad-${k}`} className="text-[13px] font-bold">{label}</Label>
      <div className="mt-1.5">
        <Input
          id={`prasad-${k}`}
          value={d[k]}
          onChange={(e) => up({ [k]: e.target.value } as Partial<AddressDraft>)}
          aria-invalid={!!fieldErr[k]}
          aria-describedby={fieldErr[k] ? `prasad-${k}-err` : undefined}
          {...extra}
        />
      </div>
      {fieldErr[k] && <p id={`prasad-${k}-err`} className="mt-1 text-[12.5px] font-bold text-destructive">{fieldErr[k]}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-grand-teal">Change prasad address</DialogTitle>
          <DialogDescription>Prasad ships the same day as the havan. You can change this address any time before it starts.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {F('name', 'Full name')}
          {F('phone', 'Mobile number', { inputMode: 'numeric', maxLength: 10, placeholder: '98765 43210' })}
          <div className="sm:col-span-2">{F('line1', 'Address line 1')}</div>
          <div className="sm:col-span-2">{F('line2', 'Address line 2 (optional)')}</div>
          {F('city', 'City')}
          {F('state', 'State')}
          {F('pincode', 'PIN code', { inputMode: 'numeric', maxLength: 6 })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : null} Save address</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Prasad to: …" / "Change address" for a Saa Thum checkout that opted into prasad.
 * No prasad on this checkout → renders nothing. */
function PrasadBlock({ checkout, now, onUpdated }: { checkout: SaathumCheckoutSummary; now: number; onUpdated: (c: SaathumCheckoutSummary) => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!checkout.prasad) return null;
  const started = checkout.listing.starts_at != null && checkout.listing.starts_at <= now;
  const canEdit = checkout.can_edit_address && !started;
  return (
    <div className="mt-1 space-y-2 rounded-xl border border-border/50 bg-secondary/40 p-3">
      <p className="flex items-start gap-2 text-[13px] font-semibold text-foreground">
        <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        {checkout.address ? <>Prasad to: <span className="font-extrabold">{fmtAddressOneLine(checkout.address)}</span></> : 'Add a prasad delivery address'}
      </p>
      {canEdit ? (
        <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>Change address</Button>
      ) : (
        <p className="text-[12.5px] font-semibold text-muted-foreground">Prasad ships the same day as the havan.</p>
      )}
      <AddressDialog open={dialogOpen} onOpenChange={setDialogOpen} checkout={checkout} onSaved={onUpdated} />
    </div>
  );
}

/** Receipt download for a confirmed Saa Thum checkout. Not confirmed yet → nothing. */
function ReceiptButton({ checkout }: { checkout: SaathumCheckoutSummary }) {
  const [busy, setBusy] = useState(false);
  if (checkout.status !== 'confirmed') return null;
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { blob, filename } = await authedBlob(`/api/saathum/checkout/${encodeURIComponent(checkout.checkout_id)}/receipt.pdf`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename ?? `saathum-receipt-${checkout.checkout_id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      capture('dash2_receipt_download', { source: 'checkout', ok: true });
    } catch (e) {
      capture('dash2_receipt_download', { source: 'checkout', ok: false });
      captureException(e, { where: 'dash2_receipt_download' });
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="sm" onClick={() => void download()} disabled={busy} className="w-fit">
      {busy ? <Loader2 className="animate-spin" /> : <Download />} Receipt
    </Button>
  );
}

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
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Saa Thum//My events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${item.order_id ?? item.listing.id}@saathum.com`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(item.listing.title)}`,
    `DESCRIPTION:${icsEscape(`Join your Saa Thum puja: ${url}`)}`,
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
function SankalpLine({ item, checkout }: { item: EventItem; checkout?: SaathumCheckoutSummary | null }) {
  const s = checkout?.sankalp ?? item.sankalp;
  if (!s?.name) return null;
  return (
    <p className="text-[13px] font-semibold text-muted-foreground">
      Sankalp in the name of <span className="font-extrabold text-foreground">{s.name}</span>
      {s.gotra ? <> · gotra <span className="font-extrabold text-foreground">{s.gotra}</span></> : null}
    </p>
  );
}

function LiveSpotlight({
  item, now, checkout, onCheckoutUpdated,
}: { item: EventItem; now: number; checkout: SaathumCheckoutSummary | null; onCheckoutUpdated: (c: SaathumCheckoutSummary) => void }) {
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
          <div className="mt-1"><SankalpLine item={item} checkout={checkout} /></div>
          {checkout && <PrasadBlock checkout={checkout} now={now} onUpdated={onCheckoutUpdated} />}
          {checkout && <ReceiptButton checkout={checkout} />}
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

function UpcomingCard({
  item, now, checkout, onCheckoutUpdated,
}: { item: EventItem; now: number; checkout: SaathumCheckoutSummary | null; onCheckoutUpdated: (c: SaathumCheckoutSummary) => void }) {
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
        <SankalpLine item={item} checkout={checkout} />
        {item.listing.duration_min ? <p className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground"><Clock className="h-3.5 w-3.5" /> {fmtDuration(item.listing.duration_min)}</p> : null}
        {checkout && <PrasadBlock checkout={checkout} now={now} onUpdated={onCheckoutUpdated} />}
        {checkout && <ReceiptButton checkout={checkout} />}
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
  const [checkouts, setCheckouts] = useState<SaathumCheckoutSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef<AbortController | null>(null);

  const onCheckoutUpdated = useCallback((updated: SaathumCheckoutSummary) => {
    setCheckouts((prev) => prev.map((c) => (c.checkout_id === updated.checkout_id ? { ...c, ...updated } : c)));
  }, []);

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

  // Independent of /api/me/events — my-checkouts may 404/fail until A1 (SAATHUM-CHECKOUT-API)
  // deploys, and fetchMyCheckoutsSafe() swallows that to [] so this screen keeps rendering
  // exactly as it does today, minus the prasad/receipt extras.
  useEffect(() => { void fetchMyCheckoutsSafe().then(setCheckouts); }, []);

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
          {live.map((i) => (
            <LiveSpotlight
              key={i.order_id ?? i.listing.id}
              item={i}
              now={now}
              checkout={checkoutFor(checkouts, i.listing.id)}
              onCheckoutUpdated={onCheckoutUpdated}
            />
          ))}
        </section>
      )}
      {rest.length > 0 && (
        <section className="space-y-4" aria-labelledby="coming-up">
          <h2 id="coming-up" className="font-dash text-[20px] font-bold text-grand-teal">Coming up</h2>
          <div className="grid gap-5 md:grid-cols-2">
            {rest.map((i) => i.state === 'pending_payment'
              ? <PendingCard key={i.payment_id ?? i.order_id ?? i.listing.id} item={i} />
              : (
                <UpcomingCard
                  key={i.order_id ?? i.listing.id}
                  item={i}
                  now={now}
                  checkout={checkoutFor(checkouts, i.listing.id)}
                  onCheckoutUpdated={onCheckoutUpdated}
                />
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
