/* PaymentReview — [SAATHUM-UPI3 2026-09-29] Layer 3 of the UPI confirmation: manual verification.
 * Contract: Specs/PLAN-SAATHUM-UPI-3LAYER.md ("API contract → Admin").
 *   GET  /api/admin/saathum/payments/review → { checkouts, unmatched_sms, sources }
 *   POST /api/admin/saathum/checkout/:id/confirm  { message_hash?, note? }
 *   POST /api/admin/saathum/checkout/:id/reject   { reason }
 * Refreshes every 20 s; confirm/reject remove the row at once and restore it if the call fails. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RefreshCw, WifiOff, X, Check } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { istDateTime, istTime, errMessage, isAbort } from './adminApi';
import { CopyValue, ErrorBox, ListSkeleton, adminCall } from './peopleKit';
import { DesiCard, DesiChip, DesiCounter, DesiEmpty, DesiSays, DesiSlip } from './desi';

/* ── wire types (timestamps may be epoch ms, epoch seconds or ISO strings — toMs() copes) ── */
type Ts = number | string | null | undefined;
interface ReviewCheckout {
  checkout_id: string; uid: string; buyer_name: string | null; whatsapp: string | null; email: string | null;
  listing_title: string | null; pay_amount_paise: number; status: string; reason_code: string | null;
  created_at: Ts; paid_claimed_at: Ts; utr: string | null;
}
interface UnmatchedSms {
  message_hash: string; amount_paise: number; payer_vpa: string | null; bank_reference: string | null;
  received_at_ms: number; source_device: string | null;
}
interface SourceHealth {
  device_id: string; source: string; last_heartbeat_at: Ts; last_sms_at: Ts; healthy: boolean;
  /** false for the forwarder: it never heartbeats. */
  heartbeat?: boolean; silent_24h_with_watcher_credits?: boolean;
}
interface Uncorroborated {
  checkout_id: string; buyer_name: string | null; listing_title: string | null; pay_amount_paise: number;
  bank_reference: string | null; confirmed_at: Ts; confirmed_via: string; corroboration_window_open: boolean;
}
interface ReviewData { checkouts: ReviewCheckout[]; unmatched_sms: UnmatchedSms[]; sources: SourceHealth[]; confirmed_uncorroborated: Uncorroborated[] }
interface Capture { id: number; received_at: Ts; method: string; content_type: string | null; top_keys: unknown; body_sample: string }
interface Captures { capture_enabled: boolean; forwarder_enabled: boolean; captures: Capture[] }

const REFRESH_MS = 20_000;
const OFFLINE_MS = 15 * 60_000;
const SLOW_MS = 10 * 60_000;

function toMs(t: Ts): number | null {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Number(t);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

/** Always two decimals: ₹199.37, ₹1,199.00 (the unique-amount trick makes paise matter). */
function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ago(ms: number | null, now: number): string {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const REASONS: Record<string, string> = {
  awaiting_bank: 'Bank SMS not received',
  provisioning_failed: 'Booking setup failed',
};
const reasonText = (c: string | null) => (c ? REASONS[c] ?? c.replace(/_/g, ' ') : 'Needs review');

const checkoutMs = (c: ReviewCheckout) => toMs(c.paid_claimed_at) ?? toMs(c.created_at);

/* ── payment sources: each SMS forwarder is a little phone with a live dot ── */

const SOURCE_LABEL: Record<string, string> = {
  watcher: 'Google Messages watcher', forwarder: 'SMS forwarder app', companion: 'SMS companion (legacy)',
};

function SourceCards({ sources, now }: { sources: SourceHealth[]; now: number }) {
  // Watcher and forwarder always show (even before they report); companion only if the payload has it.
  const cards = useMemo(() => {
    const out: { key: string; s: SourceHealth | null }[] = [];
    for (const key of ['watcher', 'forwarder']) out.push({ key, s: sources.find((x) => x.source === key) ?? null });
    for (const s of sources) if (s.source === 'companion') out.push({ key: 'companion', s });
    return out;
  }, [sources]);

  return (
    <DesiCard title="Payment sources" note="The phones that forward your bank SMS. A red dot means that phone needs a look." tone="cream" corner="jasmine" className="h-full">
      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {cards.map(({ key, s }) => {
          const label = SOURCE_LABEL[key];
          const forwarder = key === 'forwarder';
          const hb = s ? toMs(s.last_heartbeat_at) : null;
          const lastSms = s ? toMs(s.last_sms_at) : null;
          // Forwarder: red only when the server says so. Others: heartbeat < 15 min and server healthy.
          const healthy = forwarder ? s?.healthy !== false : !!s && hb != null && now - hb < OFFLINE_MS && s.healthy !== false;
          const dot = healthy ? '#0e7c86' : '#d81b72';
          return (
            <div key={`${key}-${s?.device_id ?? 'none'}`} className="relative flex min-w-0 flex-col gap-2 rounded-[28px] border-[3px] px-4 pb-4 pt-7 shadow-sm"
              style={{ borderColor: dot, background: healthy ? 'linear-gradient(180deg,#e3f5f6,#fff 70%)' : 'linear-gradient(180deg,#ffe6ef,#fff 70%)' }}>
              <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-1.5 w-14 -translate-x-1/2 rounded-full" style={{ background: healthy ? '#9fd3d8' : '#f2a9c8' }} />
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
                  {healthy && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: dot }} />}
                  <span className="relative inline-flex h-3.5 w-3.5 rounded-full" style={{ background: dot }} />
                </span>
                <b className="min-w-0 break-words font-dash" style={{ fontSize: 'var(--fs-body)', color: 'var(--a-plum)' }}>{label}</b>
              </div>
              <div>
                {healthy
                  ? <DesiChip tone="tea"><CheckCircle2 className="h-4 w-4" aria-hidden /> Healthy</DesiChip>
                  : <DesiChip tone="rani"><WifiOff className="h-4 w-4" aria-hidden /> {forwarder ? 'Silent' : 'Offline'}</DesiChip>}
              </div>
              {forwarder ? (
                <>
                  <p className={cn('text-[14px] font-bold', healthy ? 'text-muted-foreground' : 'text-destructive')}>
                    {healthy ? 'Sends each message as it arrives (no heartbeat).' : 'No messages for 24 h while bank credits arrived'}
                  </p>
                  <p className="text-[14px] font-semibold text-muted-foreground">
                    Last message: {lastSms ? `${ago(lastSms, now)} · ${istTime(lastSms)}` : 'none yet'}
                  </p>
                </>
              ) : (
                <>
                  <p className={cn('text-[14px] font-bold', healthy ? 'text-muted-foreground' : 'text-destructive')}>
                    {!s ? 'Never reported in' : healthy ? `Last heartbeat ${ago(hb, now)}` : hb ? `Offline since ${istTime(hb)} (${ago(hb, now)})` : 'Offline — no heartbeat yet'}
                  </p>
                  <p className="text-[14px] font-semibold text-muted-foreground">
                    Last SMS: {lastSms ? `${ago(lastSms, now)} · ${istTime(lastSms)}` : 'none yet'}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </DesiCard>
  );
}

/* ── confirmed by forwarder only (read-only) ───────────────────────────── */

function CorroChip({ open }: { open: boolean }) {
  return open
    ? <DesiChip tone="gold">Awaiting second source</DesiChip>
    : <DesiChip tone="rani"><AlertTriangle className="h-4 w-4" aria-hidden /> Not corroborated, check bank statement</DesiChip>;
}

function Uncorroborated({ items, now }: { items: Uncorroborated[]; now: number }) {
  if (items.length === 0) return null;
  return (
    <DesiCard title={<>Confirmed by forwarder only <span className="opacity-70">({items.length})</span></>}
      note="Confirmed automatically from the forwarder app alone. The Google Messages watcher has not yet seen the same bank SMS."
      tone="lav" corner="hibiscus" pattern="dots" id="confirmed-forwarder-only">
      <div className="hfa-row">
        {items.map((u) => {
          const t = toMs(u.confirmed_at);
          return (
            <DesiSlip key={u.checkout_id} tone={u.corroboration_window_open ? 'lav' : 'rani'}
              strip={`Confirmed via ${u.confirmed_via}`} stripRight={<span className="text-[14px] font-bold">{ago(t, now)}</span>}>
              <div className="hfa-amount">{rupees(u.pay_amount_paise)}</div>
              <div className="min-w-0">
                <div className="font-dash text-[17px] font-bold">{u.buyer_name ?? '—'}</div>
                <div className="text-[14px] font-semibold text-muted-foreground">{u.listing_title ?? '—'}</div>
                <div className="mt-1 text-[14px] font-semibold text-muted-foreground">{t ? istDateTime(t) : '—'}</div>
                {u.bank_reference && <div className="text-[14px] font-semibold text-muted-foreground">Bank ref <CopyValue value={u.bank_reference} label="Bank reference" className="text-foreground" /></div>}
                <div className="mt-2"><CorroChip open={u.corroboration_window_open} /></div>
              </div>
            </DesiSlip>
          );
        })}
      </div>
    </DesiCard>
  );
}

/* ── forwarder setup (collapsible; loads on first open) ────────────────── */

function ForwarderSetup({ now }: { now: number }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Captures | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setD(await adminCall<Captures>('/api/admin/saathum/forwarder/captures')); }
    catch (e) { captureException(e, { where: 'admin2_forwarder_captures' }); setErr(errMessage(e, 'Could not load forwarder captures.')); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (open && !d && !busy) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const flag = (on: boolean | undefined) => (on ? <DesiChip tone="tea">On</DesiChip> : <DesiChip tone="grey">Off</DesiChip>);

  return (
    <DesiCard title="Forwarder setup" tone="cream" corner="jasmine" pattern="bahi"
      action={
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="hfa-btn ghost">
          {open ? 'Hide' : 'Show'} <ChevronDown className={cn('h-5 w-5 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      }>
      {open && (
        <div className="space-y-3">
          {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !d ? <ListSkeleton rows={2} /> : (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px] font-bold">
                <span className="flex items-center gap-2">Forwarder {flag(d.forwarder_enabled)}</span>
                <span className="flex items-center gap-2">Capture mode {flag(d.capture_enabled)}</span>
                <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => void load()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
                </button>
              </div>
              {d.captures.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-foreground">No captures yet. Turn capture mode on and send a test message from the forwarder app.</p>
              ) : (
                <ul className="space-y-3">
                  {d.captures.map((c) => {
                    const t = toMs(c.received_at);
                    const keys = Array.isArray(c.top_keys) ? c.top_keys.map(String).join(', ') : String(c.top_keys ?? '');
                    return (
                      <li key={c.id} className="rounded-2xl border-2 border-dashed border-[#e9c98d] bg-white/80 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[14px] font-bold">
                          <DesiChip tone="lav">{c.method}</DesiChip>
                          <span className="text-muted-foreground">{c.content_type ?? 'no content-type'}</span>
                          <span className="ml-auto text-[14px] font-semibold text-muted-foreground">{t ? `${istDateTime(t)} · ${ago(t, now)}` : ''}</span>
                        </div>
                        <p className="mt-1 break-words text-[14px] font-semibold text-muted-foreground">Top keys: <span className="text-foreground">{keys || '—'}</span></p>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-dashbody text-[14px] leading-relaxed text-foreground">{c.body_sample}</pre>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </DesiCard>
  );
}

/* ── confirm dialog ────────────────────────────────────────────────────── */

function ConfirmDialog({ checkout, sms, now, onClose, onSubmit }: {
  checkout: ReviewCheckout | null; sms: UnmatchedSms[]; now: number; onClose: () => void;
  onSubmit: (c: ReviewCheckout, body: { message_hash?: string; note?: string }) => void;
}) {
  const [pick, setPick] = useState<string>('none');
  const [note, setNote] = useState('');

  const ranked = useMemo(() => {
    if (!checkout) return [] as UnmatchedSms[];
    const t = checkoutMs(checkout) ?? now;
    return [...sms].sort((a, b) => {
      const am = a.amount_paise === checkout.pay_amount_paise ? 0 : 1;
      const bm = b.amount_paise === checkout.pay_amount_paise ? 0 : 1;
      return am - bm || Math.abs(a.received_at_ms - t) - Math.abs(b.received_at_ms - t);
    });
  }, [checkout, sms, now]);

  useEffect(() => {
    if (!checkout) return;
    setNote('');
    const best = ranked[0];
    setPick(best && best.amount_paise === checkout.pay_amount_paise ? best.message_hash : 'none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout?.checkout_id]);

  const noSms = pick === 'none';
  const canSubmit = !noSms || note.trim().length >= 3;

  return (
    <Dialog open={!!checkout} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        {checkout && (
          <>
            <DialogHeader>
              <DialogTitle className="font-dash text-[20px] text-[var(--hf-admin-plum,#4a1747)]">Confirm payment</DialogTitle>
              <DialogDescription className="text-[14px] font-semibold">
                {checkout.buyer_name ?? 'Buyer'} · <b className="text-foreground">{rupees(checkout.pay_amount_paise)}</b> · {checkout.listing_title ?? 'Event'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label className="text-[14px] font-bold">Link the bank SMS that proves this payment</Label>
              <ul className="grid gap-2" role="radiogroup" aria-label="Unmatched bank SMS">
                {ranked.map((m) => {
                  const exact = m.amount_paise === checkout.pay_amount_paise;
                  const on = pick === m.message_hash;
                  return (
                    <li key={m.message_hash}>
                      <button type="button" role="radio" aria-checked={on} onClick={() => setPick(m.message_hash)}
                        className={cn('flex min-h-[56px] w-full items-start gap-3 rounded-lg border p-3 text-left', on ? 'border-[#0e7c86] bg-[#e3f5f6]' : 'border-border bg-card hover:bg-muted')}>
                        <span className={cn('mt-1 h-4 w-4 shrink-0 rounded-full border-2', on ? 'border-[#0e7c86] bg-[#0e7c86]' : 'border-muted-foreground')} aria-hidden />
                        <span className="min-w-0 flex-1 text-[14px] font-semibold">
                          <span className="flex flex-wrap items-center gap-2">
                            <b className="text-[16px] tabular-nums">{rupees(m.amount_paise)}</b>
                            {exact ? <DesiChip tone="tea">Same amount</DesiChip> : <DesiChip tone="grey">Different amount</DesiChip>}
                          </span>
                          <span className="block text-muted-foreground">{istDateTime(m.received_at_ms)} · {ago(m.received_at_ms, now)}</span>
                          <span className="block break-all text-muted-foreground">{m.payer_vpa ?? 'Unknown payer'}{m.bank_reference ? ` · Ref ${m.bank_reference}` : ''}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button type="button" role="radio" aria-checked={noSms} onClick={() => setPick('none')}
                    className={cn('flex min-h-[56px] w-full items-center gap-3 rounded-lg border p-3 text-left', noSms ? 'border-[#0e7c86] bg-[#e3f5f6]' : 'border-border bg-card hover:bg-muted')}>
                    <span className={cn('h-4 w-4 shrink-0 rounded-full border-2', noSms ? 'border-[#0e7c86] bg-[#0e7c86]' : 'border-muted-foreground')} aria-hidden />
                    <span className="text-[14px] font-bold">Confirm without an SMS</span>
                  </button>
                </li>
              </ul>
              {ranked.length === 0 && <p className="text-[14px] font-semibold text-muted-foreground">No unmatched bank SMS right now.</p>}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="pr-note" className="text-[14px] font-bold">Note{noSms ? ' (required)' : ' (optional)'}</Label>
              <Input id="pr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                placeholder={noSms ? 'e.g. Saw the credit in the HDFC app, ref …' : 'Anything worth remembering'} className="text-[16px]" />
              {noSms && <p className="text-[14px] font-semibold text-muted-foreground">Without an SMS, say how you verified the money arrived.</p>}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
              <Button className="min-h-[44px] bg-[#0e7c86] text-white hover:bg-[#0a5c63]" disabled={!canSubmit}
                onClick={() => onSubmit(checkout, { message_hash: noSms ? undefined : pick, note: note.trim() || undefined })}>
                <Check /> Confirm payment
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── reject dialog ─────────────────────────────────────────────────────── */

const REJECT_CHOICES = [
  { id: 'payment_not_found', label: 'Payment not found' },
  { id: 'wrong_amount', label: 'Wrong amount' },
  { id: 'other', label: 'Other' },
] as const;

function RejectDialog({ checkout, onClose, onSubmit }: {
  checkout: ReviewCheckout | null; onClose: () => void; onSubmit: (c: ReviewCheckout, reason: string) => void;
}) {
  const [kind, setKind] = useState<string>('payment_not_found');
  const [text, setText] = useState('');
  useEffect(() => { if (checkout) { setKind('payment_not_found'); setText(''); } }, [checkout?.checkout_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = REJECT_CHOICES.find((r) => r.id === kind)?.label ?? kind;
  const reason = [label, text.trim()].filter(Boolean).join(': ');
  const canSubmit = kind !== 'other' || text.trim().length >= 3;

  return (
    <Dialog open={!!checkout} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {checkout && (
          <>
            <DialogHeader>
              <DialogTitle className="font-dash text-[20px] text-destructive">Reject payment</DialogTitle>
              <DialogDescription className="text-[14px] font-semibold">
                {checkout.buyer_name ?? 'Buyer'} · <b className="text-foreground">{rupees(checkout.pay_amount_paise)}</b>. They will be told we could not find their payment.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label className="text-[14px] font-bold">Reason</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger aria-label="Reason" className="text-[15px] font-semibold"><SelectValue /></SelectTrigger>
                <SelectContent>{REJECT_CHOICES.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pr-reject-text" className="text-[14px] font-bold">Details{kind === 'other' ? ' (required)' : ' (optional)'}</Label>
              <Input id="pr-reject-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} className="text-[16px]" />
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" className="min-h-[44px]" onClick={onClose}>Cancel</Button>
              <Button variant="destructive" className="min-h-[44px]" disabled={!canSubmit} onClick={() => onSubmit(checkout, reason)}><X /> Reject</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── main ──────────────────────────────────────────────────────────────── */

export default function PaymentReview() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<ReviewCheckout | null>(null);
  const [rejecting, setRejecting] = useState<ReviewCheckout | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Rows removed optimistically and not yet settled — a refresh must not resurrect them. */
  const hidden = useRef<{ checkouts: Set<string>; sms: Set<string> }>({ checkouts: new Set(), sms: new Set() });
  const inflight = useRef(false);

  const load = useCallback(async (manual = false) => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await adminCall<ReviewData>('/api/admin/saathum/payments/review');
      setData({ checkouts: r.checkouts ?? [], unmatched_sms: r.unmatched_sms ?? [], sources: r.sources ?? [], confirmed_uncorroborated: r.confirmed_uncorroborated ?? [] });
      setPhase('ready'); setStale(false); setNow(Date.now());
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'admin2_payment_review_load' });
      setPhase((p) => {
        if (p === 'ready') { setStale(true); if (manual) toast.error(errMessage(e, 'Could not refresh.')); return p; }
        setError(errMessage(e, 'Could not load the payment queue.')); return 'error';
      });
    } finally { inflight.current = false; }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const vis = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); clearInterval(tick); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  const checkouts = useMemo(
    () => (data?.checkouts ?? []).filter((c) => !hidden.current.checkouts.has(c.checkout_id))
      .sort((a, b) => (checkoutMs(a) ?? 0) - (checkoutMs(b) ?? 0)),
    [data],
  );
  const sms = useMemo(
    () => (data?.unmatched_sms ?? []).filter((m) => !hidden.current.sms.has(m.message_hash)).sort((a, b) => b.received_at_ms - a.received_at_ms),
    [data],
  );

  async function act(kind: 'confirm' | 'reject', c: ReviewCheckout, body: Record<string, unknown>) {
    const linked = typeof body.message_hash === 'string' ? body.message_hash : null;
    hidden.current.checkouts.add(c.checkout_id);
    if (linked) hidden.current.sms.add(linked);
    setBusy((b) => new Set(b).add(c.checkout_id));
    setConfirming(null); setRejecting(null);
    setData((d) => (d ? { ...d } : d)); // re-run the filters
    try {
      await adminCall(`/api/admin/saathum/checkout/${encodeURIComponent(c.checkout_id)}/${kind}`, { method: 'POST', body });
      capture(`admin_payment_${kind}`, { linked_sms: Boolean(linked) });
      toast.success(kind === 'confirm' ? 'Payment confirmed' : 'Payment rejected',
        { description: kind === 'confirm' ? 'The buyer is being sent their receipt.' : 'The buyer is being told we could not find it.' });
      hidden.current.checkouts.delete(c.checkout_id); // server no longer lists it; if it still does, it reappears
      if (linked) hidden.current.sms.delete(linked);
    } catch (e) {
      hidden.current.checkouts.delete(c.checkout_id);
      if (linked) hidden.current.sms.delete(linked);
      captureException(e, { where: `admin2_payment_${kind}` });
      toast.error(errMessage(e, kind === 'confirm' ? 'Could not confirm this payment.' : 'Could not reject this payment.'),
        { description: `${c.buyer_name ?? 'Buyer'} · ${rupees(c.pay_amount_paise)} is back in the queue.` });
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(c.checkout_id); return n; });
      setData((d) => (d ? { ...d } : d));
      void load();
    }
  }

  if (phase === 'loading') return <ListSkeleton rows={4} />;
  if (phase === 'error') return <ErrorBox message={error ?? 'Could not load the payment queue.'} onRetry={() => { setPhase('loading'); void load(true); }} />;

  const slowOf = (c: ReviewCheckout) => { const t = checkoutMs(c); return t != null && now - t > SLOW_MS; };
  const waitingTotal = checkouts.reduce((s, c) => s + c.pay_amount_paise, 0);
  /** Closest-in-time SMS with exactly the same amount — the likely proof for this checkout. */
  const matchFor = (c: ReviewCheckout): UnmatchedSms | null => {
    const t = checkoutMs(c) ?? now;
    let best: UnmatchedSms | null = null;
    for (const m of sms) if (m.amount_paise === c.pay_amount_paise && (!best || Math.abs(m.received_at_ms - t) < Math.abs(best.received_at_ms - t))) best = m;
    return best;
  };

  return (
    <div className="hfa-stack">
      {stale && (
        <div role="status" className="hfa-card hfa-t-gold flex items-center gap-2 text-[14px] font-bold text-foreground">
          <WifiOff className="h-5 w-5 shrink-0 text-primary" /> Could not refresh — showing the last data. Retrying automatically.
        </div>
      )}

      <div className="hfa-row-wide rev">
        <DesiCounter eyebrow="Pakka? Bank se poochh lo" value={checkouts.length} label={checkouts.length === 1 ? 'payment waiting for you' : 'payments waiting for you'}>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {checkouts.length > 0 && <b className="font-dash" style={{ fontSize: 'var(--fs-body)' }}>{rupees(waitingTotal)} in total</b>}
            <button type="button" className="hfa-btn gold" onClick={() => void load(true)}><RefreshCw className="h-4 w-4" /> Refresh</button>
          </div>
        </DesiCounter>
        <SourceCards sources={data?.sources ?? []} now={now} />
      </div>

      <div className="hfa-row-wide">
        <DesiCard title={<>Waiting for you <span className="opacity-70">({checkouts.length})</span></>} note="Oldest first. Compare what the customer says with what the bank SMS says." tone="gold" corner="marigold" pattern="dots" id="waiting-for-verification">
          {checkouts.length === 0 ? (
            <DesiEmpty text="All payments verified. Nothing is waiting for you. This page refreshes every 20 seconds." />
          ) : (
            <ul className="space-y-4">
              {checkouts.map((c) => {
                const t = checkoutMs(c);
                const claimed = toMs(c.paid_claimed_at);
                const slow = slowOf(c);
                const m = matchFor(c);
                const bz = busy.has(c.checkout_id);
                return (
                  <li key={c.checkout_id}>
                    <DesiSlip tone={m ? 'tea' : 'gold'}
                      strip={claimed ? `Claimed paid · ${t ? istDateTime(t) : '—'}` : `Created · ${t ? istDateTime(t) : '—'}`}
                      stripRight={<DesiChip tone={slow ? 'rani' : 'gold'}>{slow && <AlertTriangle className="h-4 w-4" aria-label="Waiting more than 10 minutes" />}{ago(t, now).replace(' ago', '')} waiting</DesiChip>}
                      actions={
                        <>
                          <button type="button" className="hfa-btn danger" disabled={bz} onClick={() => setRejecting(c)}><X className="h-4 w-4" /> Reject</button>
                          <button type="button" className="hfa-btn ghost" disabled={bz} onClick={() => setConfirming(c)}>Link an SMS</button>
                          <button type="button" className="hfa-btn tea" disabled={bz} onClick={() => setConfirming(c)}><Check className="h-4 w-4" /> Confirm</button>
                        </>
                      }>
                      <div className="hfa-amount">{rupees(c.pay_amount_paise)}<small>{reasonText(c.reason_code)}</small></div>
                      <div className="grid min-w-0 gap-3">
                        <div className="min-w-0">
                          <div className="font-dash font-bold" style={{ fontSize: 'var(--fs-body)' }}>{c.buyer_name ?? '—'}</div>
                          <div className="text-[14px] font-semibold text-muted-foreground">{c.listing_title ?? '—'}</div>
                          <div className="mt-1 grid gap-0.5 text-[14px] font-semibold text-muted-foreground">
                            {c.whatsapp && <a href={`https://wa.me/${c.whatsapp.replace(/\D/g, '')}`} className="inline-flex min-h-[44px] items-center text-foreground underline-offset-2 hover:underline">WhatsApp {c.whatsapp}</a>}
                            {c.email && <span className="break-all">{c.email}</span>}
                            {!claimed && <span>(not tapped “I’ve paid”)</span>}
                          </div>
                        </div>
                        <div className="hfa-says-grid">
                          <DesiSays k="Customer says" tone="lav" v={<>
                            <div>{c.utr ? <>UTR <CopyValue value={c.utr} label="UTR" /></> : 'No UTR given'}</div>
                            <div className="text-[14px] font-semibold text-muted-foreground">Payer: {c.buyer_name ?? '—'}</div>
                          </>} />
                          {m ? (
                            <DesiSays k="Bank SMS says" tone="tea" v={<>
                              <div>{rupees(m.amount_paise)} · same amount</div>
                              <div className="text-[14px] font-semibold text-muted-foreground">{m.payer_vpa ?? 'Unknown payer'}{m.bank_reference ? ` · Ref ${m.bank_reference}` : ''}</div>
                              <div className="text-[14px] font-semibold text-muted-foreground">{istDateTime(m.received_at_ms)} · {ago(m.received_at_ms, now)}</div>
                            </>} />
                          ) : (
                            <DesiSays k="Bank SMS says" tone="none" v={<span className="text-[var(--a-rani)]">Nothing matched yet</span>} />
                          )}
                        </div>
                      </div>
                    </DesiSlip>
                  </li>
                );
              })}
            </ul>
          )}
        </DesiCard>

        <div className="hfa-stack">
          <DesiCard title={<>Unmatched bank SMS <span className="opacity-70">({sms.length})</span></>} note="Credits the bank told us about that no checkout owns yet." tone="tea" corner="jasmine" id="unmatched-bank-sms">
            {sms.length === 0 ? (
              <DesiEmpty text="No unmatched bank SMS. Every credit SMS has been matched to a checkout." />
            ) : (
              <ul className="grid gap-3">
                {sms.map((m) => (
                  <li key={m.message_hash} className="border border-[#9fd3d8] bg-[#d2eef0] p-4" style={{ borderRadius: '22px 22px 22px 4px' }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="hfa-amount" style={{ fontSize: 'clamp(24px, 14px + 1.2vw, 32px)', minWidth: 0 }}>{rupees(m.amount_paise)}</div>
                      <div className="text-right text-[14px] font-semibold text-muted-foreground">{ago(m.received_at_ms, now)}</div>
                    </div>
                    <div className="mt-1 break-all text-[14px] font-bold text-foreground">{m.payer_vpa ?? 'Unknown payer'}</div>
                    <div className="text-[14px] font-semibold text-muted-foreground">
                      {istDateTime(m.received_at_ms)}{m.source_device ? ` · ${m.source_device}` : ''}
                    </div>
                    {m.bank_reference && <div className="text-[14px] font-semibold text-muted-foreground">Bank ref <CopyValue value={m.bank_reference} label="Bank reference" className="text-foreground" /></div>}
                  </li>
                ))}
              </ul>
            )}
          </DesiCard>

          <DesiCard title="Before you confirm" tone="gold" pattern="stripes" corner="yellow">
            <ul className="grid gap-3">
              {[
                'Open the bank app and look for the credit yourself.',
                'The amount must match to the paisa, not just the rupee.',
                'Prefer linking the bank SMS that proves it.',
                'No SMS? Confirm anyway, but write how you verified.',
              ].map((t) => (
                <li key={t} className="flex items-start gap-3 text-[14px] font-bold text-[var(--a-plum)]">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#0e7c86] text-white" aria-hidden="true"><Check className="h-4 w-4" /></span>
                  {t}
                </li>
              ))}
            </ul>
          </DesiCard>
        </div>
      </div>

      <Uncorroborated items={data?.confirmed_uncorroborated ?? []} now={now} />

      <ForwarderSetup now={now} />

      <ConfirmDialog checkout={confirming} sms={sms} now={now} onClose={() => setConfirming(null)} onSubmit={(c, b) => void act('confirm', c, b)} />
      <RejectDialog checkout={rejecting} onClose={() => setRejecting(null)} onSubmit={(c, r) => void act('reject', c, { reason: r })} />
      {busy.size > 0 && <div className="fixed bottom-24 right-4 z-50 rounded-full bg-card p-2 shadow-lg sm:bottom-4" aria-hidden><Loader2 className="h-5 w-5 animate-spin text-[#0e7c86]" /></div>}
    </div>
  );
}
