/* PaymentReview — [SAATHUM-UPI3 2026-09-29] Layer 3 of the UPI confirmation: manual verification.
 * Contract: Specs/PLAN-SAATHUM-UPI-3LAYER.md ("API contract → Admin").
 *   GET  /api/admin/saathum/payments/review → { checkouts, unmatched_sms, sources }
 *   POST /api/admin/saathum/checkout/:id/confirm  { message_hash?, note? }
 *   POST /api/admin/saathum/checkout/:id/reject   { reason }
 * Refreshes every 20 s; confirm/reject remove the row at once and restore it if the call fails. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RefreshCw, Smartphone, WifiOff, X, Check } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { istDateTime, istTime, errMessage, isAbort } from './adminApi';
import { CopyValue, Empty, ErrorBox, ListSkeleton, TD, TH, adminCall } from './peopleKit';

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

/* ── payment sources strip ─────────────────────────────────────────────── */

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
    <section aria-label="Payment sources">
      <h2 className="mb-2 font-dash text-[18px] font-bold text-grand-teal">Payment sources</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {cards.map(({ key, s }) => {
          const label = SOURCE_LABEL[key];
          const forwarder = key === 'forwarder';
          const hb = s ? toMs(s.last_heartbeat_at) : null;
          const lastSms = s ? toMs(s.last_sms_at) : null;
          // Forwarder: red only when the server says so. Others: heartbeat < 15 min and server healthy.
          const healthy = forwarder ? s?.healthy !== false : !!s && hb != null && now - hb < OFFLINE_MS && s.healthy !== false;
          return (
            <div key={`${key}-${s?.device_id ?? 'none'}`} className={cn('rounded-xl border bg-card p-4 shadow-sm', healthy ? 'border-accent/50' : 'border-destructive/50')}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-dash text-[16px] font-bold text-foreground">{label}</span>
                </div>
                {healthy
                  ? <Badge variant="accent" className="text-[13px]"><CheckCircle2 className="mr-1 h-4 w-4" /> Healthy</Badge>
                  : <Badge variant="destructive" className="text-[13px]"><WifiOff className="mr-1 h-4 w-4" /> {forwarder ? 'Silent' : 'Offline'}</Badge>}
              </div>
              {forwarder ? (
                <>
                  <p className={cn('mt-2 text-[14px] font-bold', healthy ? 'text-muted-foreground' : 'text-destructive')}>
                    {healthy ? 'Sends each message as it arrives (no heartbeat).' : 'No messages for 24 h while bank credits arrived'}
                  </p>
                  <p className="mt-1 text-[14px] font-semibold text-muted-foreground">
                    Last message: {lastSms ? `${ago(lastSms, now)} · ${istTime(lastSms)}` : 'none yet'}
                  </p>
                </>
              ) : (
                <>
                  <p className={cn('mt-2 text-[14px] font-bold', healthy ? 'text-muted-foreground' : 'text-destructive')}>
                    {!s ? 'Never reported in' : healthy ? `Last heartbeat ${ago(hb, now)}` : hb ? `Offline since ${istTime(hb)} (${ago(hb, now)})` : 'Offline — no heartbeat yet'}
                  </p>
                  <p className="mt-1 text-[14px] font-semibold text-muted-foreground">
                    Last SMS: {lastSms ? `${ago(lastSms, now)} · ${istTime(lastSms)}` : 'none yet'}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── confirmed by forwarder only (read-only) ───────────────────────────── */

function CorroChip({ open }: { open: boolean }) {
  return open
    ? <Badge className="border-transparent bg-amber-100 text-[13px] text-amber-900 hover:bg-amber-100">Awaiting second source</Badge>
    : <Badge variant="destructive" className="text-[13px]"><AlertTriangle className="mr-1 h-4 w-4" /> Not corroborated, check bank statement</Badge>;
}

function Uncorroborated({ items, now }: { items: Uncorroborated[]; now: number }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Confirmed by forwarder only">
      <h2 className="font-dash text-[18px] font-bold text-grand-teal">Confirmed by forwarder only <span className="text-muted-foreground">({items.length})</span></h2>
      <p className="mb-2 text-[14px] font-semibold text-muted-foreground">Confirmed automatically from the forwarder app alone. The Google Messages watcher has not yet seen the same bank SMS.</p>
      <div className="hidden overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm md:block">
        <table className="w-full border-collapse">
          <thead className="bg-muted/60">
            <tr><th className={TH}>Buyer</th><th className={TH}>Event</th><th className={`${TH} text-right`}>Amount</th><th className={TH}>Bank ref</th><th className={TH}>Confirmed</th><th className={TH}>Via</th><th className={TH}>Status</th></tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {items.map((u) => {
              const t = toMs(u.confirmed_at);
              return (
                <tr key={u.checkout_id} className="hover:bg-muted/30">
                  <td className={`${TD} font-bold`}>{u.buyer_name ?? '—'}</td>
                  <td className={`${TD} max-w-[200px]`}>{u.listing_title ?? '—'}</td>
                  <td className={`${TD} whitespace-nowrap text-right text-[16px] font-extrabold tabular-nums`}>{rupees(u.pay_amount_paise)}</td>
                  <td className={`${TD} text-[13px]`}>{u.bank_reference ? <CopyValue value={u.bank_reference} label="Bank reference" /> : '—'}</td>
                  <td className={`${TD} whitespace-nowrap text-[13px]`}>{t ? istDateTime(t) : '—'}<div className="text-muted-foreground">{ago(t, now)}</div></td>
                  <td className={`${TD} text-[13px]`}>{u.confirmed_via}</td>
                  <td className={TD}><CorroChip open={u.corroboration_window_open} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {items.map((u) => {
          const t = toMs(u.confirmed_at);
          return (
            <li key={u.checkout_id} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="font-dash text-[20px] font-bold tabular-nums">{rupees(u.pay_amount_paise)}</div>
                <div className="text-right text-[13px] font-semibold text-muted-foreground">{ago(t, now)}</div>
              </div>
              <div className="mt-1 text-[15px] font-bold">{u.buyer_name ?? '—'}</div>
              <div className="text-[14px] font-semibold text-muted-foreground">{u.listing_title ?? '—'}</div>
              <div className="mt-1 text-[13px] font-semibold text-muted-foreground">
                {t ? istDateTime(t) : '—'} · via {u.confirmed_via}{u.bank_reference ? ` · Ref ${u.bank_reference}` : ''}
              </div>
              <div className="mt-2"><CorroChip open={u.corroboration_window_open} /></div>
            </li>
          );
        })}
      </ul>
    </section>
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

  const flag = (on: boolean | undefined) => (on ? <Badge variant="accent">On</Badge> : <Badge variant="muted">Off</Badge>);

  return (
    <section aria-label="Forwarder setup" className="rounded-xl border border-border/60 bg-card shadow-sm">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="font-dash text-[17px] font-bold text-grand-teal">Forwarder setup</span>
        <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/40 p-4">
          {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !d ? <ListSkeleton rows={2} /> : (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px] font-bold">
                <span className="flex items-center gap-2">Forwarder {flag(d.forwarder_enabled)}</span>
                <span className="flex items-center gap-2">Capture mode {flag(d.capture_enabled)}</span>
                <Button variant="outline" size="sm" className="h-10 text-[14px]" disabled={busy} onClick={() => void load()}>
                  {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
                </Button>
              </div>
              {d.captures.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-foreground">No captures yet. Turn capture mode on and send a test message from the forwarder app.</p>
              ) : (
                <ul className="space-y-3">
                  {d.captures.map((c) => {
                    const t = toMs(c.received_at);
                    const keys = Array.isArray(c.top_keys) ? c.top_keys.map(String).join(', ') : String(c.top_keys ?? '');
                    return (
                      <li key={c.id} className="rounded-lg border border-border/60 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[14px] font-bold">
                          <Badge variant="outline">{c.method}</Badge>
                          <span className="text-muted-foreground">{c.content_type ?? 'no content-type'}</span>
                          <span className="ml-auto text-[13px] font-semibold text-muted-foreground">{t ? `${istDateTime(t)} · ${ago(t, now)}` : ''}</span>
                        </div>
                        <p className="mt-1 break-words text-[14px] font-semibold text-muted-foreground">Top keys: <span className="text-foreground">{keys || '—'}</span></p>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-[13px] leading-relaxed text-foreground">{c.body_sample}</pre>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
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
              <DialogTitle className="font-dash text-[20px] text-grand-teal">Confirm payment</DialogTitle>
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
                        className={cn('flex min-h-[56px] w-full items-start gap-3 rounded-lg border p-3 text-left', on ? 'border-accent bg-accent/10' : 'border-border bg-card hover:bg-muted')}>
                        <span className={cn('mt-1 h-4 w-4 shrink-0 rounded-full border-2', on ? 'border-accent bg-accent' : 'border-muted-foreground')} aria-hidden />
                        <span className="min-w-0 flex-1 text-[14px] font-semibold">
                          <span className="flex flex-wrap items-center gap-2">
                            <b className="text-[16px] tabular-nums">{rupees(m.amount_paise)}</b>
                            {exact ? <Badge variant="accent">Same amount</Badge> : <Badge variant="muted">Different amount</Badge>}
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
                    className={cn('flex min-h-[56px] w-full items-center gap-3 rounded-lg border p-3 text-left', noSms ? 'border-accent bg-accent/10' : 'border-border bg-card hover:bg-muted')}>
                    <span className={cn('h-4 w-4 shrink-0 rounded-full border-2', noSms ? 'border-accent bg-accent' : 'border-muted-foreground')} aria-hidden />
                    <span className="text-[14px] font-bold">Confirm without an SMS</span>
                  </button>
                </li>
              </ul>
              {ranked.length === 0 && <p className="text-[13px] font-semibold text-muted-foreground">No unmatched bank SMS right now.</p>}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="pr-note" className="text-[14px] font-bold">Note{noSms ? ' (required)' : ' (optional)'}</Label>
              <Input id="pr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                placeholder={noSms ? 'e.g. Saw the credit in the HDFC app, ref …' : 'Anything worth remembering'} className="text-[16px]" />
              {noSms && <p className="text-[13px] font-semibold text-muted-foreground">Without an SMS, say how you verified the money arrived.</p>}
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button variant="accent" disabled={!canSubmit}
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
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button variant="destructive" disabled={!canSubmit} onClick={() => onSubmit(checkout, reason)}><X /> Reject</Button>
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

  const btns = (c: ReviewCheckout) => (
    <div className="flex gap-2">
      <Button variant="accent" size="sm" className="h-10 flex-1 text-[14px] md:flex-none" disabled={busy.has(c.checkout_id)} onClick={() => setConfirming(c)}><Check /> Confirm</Button>
      <Button variant="outline" size="sm" className="h-10 flex-1 text-[14px] text-destructive md:flex-none" disabled={busy.has(c.checkout_id)} onClick={() => setRejecting(c)}><X /> Reject</Button>
    </div>
  );

  const ageCell = (c: ReviewCheckout) => {
    const t = checkoutMs(c);
    const slow = t != null && now - t > SLOW_MS;
    return (
      <span className={cn('inline-flex items-center gap-1 font-bold', slow ? 'text-destructive' : 'text-foreground')}>
        {slow && <AlertTriangle className="h-4 w-4" aria-label="Waiting more than 10 minutes" />}{ago(t, now).replace(' ago', '')}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {stale && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[14px] font-bold text-foreground">
          <WifiOff className="h-4 w-4 text-primary" /> Could not refresh — showing the last data. Retrying automatically.
        </div>
      )}

      <SourceCards sources={data?.sources ?? []} now={now} />

      <section aria-label="Waiting for verification">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="font-dash text-[18px] font-bold text-grand-teal">Waiting for verification <span className="text-muted-foreground">({checkouts.length})</span></h2>
          <Button variant="outline" size="sm" className="h-10 text-[14px]" onClick={() => void load(true)}><RefreshCw /> Refresh</Button>
        </div>

        {checkouts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-accent" aria-hidden />
            <p className="font-dash text-[18px] font-bold text-foreground">All payments verified</p>
            <p className="text-[14px] font-semibold text-muted-foreground">Nothing is waiting for you. This page refreshes every 20 seconds.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm md:block">
              <table className="w-full border-collapse">
                <thead className="bg-muted/60">
                  <tr>
                    <th className={TH}>Buyer</th><th className={TH}>Event</th><th className={`${TH} text-right`}>Amount</th>
                    <th className={TH}>Claimed paid</th><th className={TH}>Waiting</th><th className={TH}>UTR</th><th className={TH}>Reason</th><th className={TH}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {checkouts.map((c) => {
                    const t = checkoutMs(c);
                    return (
                      <tr key={c.checkout_id} className={cn('hover:bg-muted/30', t != null && now - t > SLOW_MS && 'bg-destructive/5')}>
                        <td className={`${TD} max-w-[220px]`}>
                          <div className="font-bold">{c.buyer_name ?? '—'}</div>
                          {c.whatsapp && <div className="text-[13px] text-muted-foreground">WhatsApp {c.whatsapp}</div>}
                          {c.email && <div className="truncate text-[13px] text-muted-foreground">{c.email}</div>}
                        </td>
                        <td className={`${TD} max-w-[200px]`}>{c.listing_title ?? '—'}</td>
                        <td className={`${TD} whitespace-nowrap text-right text-[16px] font-extrabold tabular-nums`}>{rupees(c.pay_amount_paise)}</td>
                        <td className={`${TD} whitespace-nowrap text-[13px]`}>{t ? istDateTime(t) : '—'}{!toMs(c.paid_claimed_at) && <div className="text-muted-foreground">(not tapped “I’ve paid”)</div>}</td>
                        <td className={`${TD} whitespace-nowrap`}>{ageCell(c)}</td>
                        <td className={`${TD} text-[13px]`}>{c.utr ? <CopyValue value={c.utr} label="UTR" /> : <span className="text-muted-foreground">—</span>}</td>
                        <td className={`${TD} text-[13px]`}>{reasonText(c.reason_code)}</td>
                        <td className={`${TD} whitespace-nowrap`}>{btns(c)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="space-y-3 md:hidden">
              {checkouts.map((c) => {
                const t = checkoutMs(c);
                const slow = t != null && now - t > SLOW_MS;
                return (
                  <li key={c.checkout_id} className={cn('rounded-xl border bg-card p-4 shadow-sm', slow ? 'border-destructive/50' : 'border-border/60')}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-dash text-[22px] font-bold tabular-nums">{rupees(c.pay_amount_paise)}</div>
                      <div className="text-right text-[14px]">{ageCell(c)}<div className="text-[12.5px] font-semibold text-muted-foreground">waiting</div></div>
                    </div>
                    <div className="mt-1 text-[15px] font-bold">{c.buyer_name ?? '—'}</div>
                    <div className="text-[14px] font-semibold text-muted-foreground">{c.listing_title ?? '—'}</div>
                    <div className="mt-2 grid gap-0.5 text-[14px] font-semibold text-muted-foreground">
                      {c.whatsapp && <a href={`https://wa.me/${c.whatsapp.replace(/\D/g, '')}`} className="text-foreground underline-offset-2 hover:underline">WhatsApp {c.whatsapp}</a>}
                      {c.email && <span className="break-all">{c.email}</span>}
                      <span>Claimed paid {t ? istDateTime(t) : '—'}</span>
                      {c.utr && <span>UTR <CopyValue value={c.utr} label="UTR" className="text-foreground" /></span>}
                      <span>{reasonText(c.reason_code)}</span>
                    </div>
                    <div className="mt-3">{btns(c)}</div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section aria-label="Unmatched bank SMS">
        <h2 className="mb-2 font-dash text-[18px] font-bold text-grand-teal">Unmatched bank SMS <span className="text-muted-foreground">({sms.length})</span></h2>
        {sms.length === 0 ? (
          <Empty title="No unmatched bank SMS" body="Every credit SMS has been matched to a checkout." />
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm md:block">
              <table className="w-full border-collapse">
                <thead className="bg-muted/60">
                  <tr><th className={`${TH} text-right`}>Amount</th><th className={TH}>Payer UPI ID</th><th className={TH}>Bank ref</th><th className={TH}>Received</th><th className={TH}>Source</th></tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {sms.map((m) => (
                    <tr key={m.message_hash} className="hover:bg-muted/30">
                      <td className={`${TD} text-right text-[16px] font-extrabold tabular-nums`}>{rupees(m.amount_paise)}</td>
                      <td className={`${TD} break-all`}>{m.payer_vpa ?? '—'}</td>
                      <td className={TD}>{m.bank_reference ? <CopyValue value={m.bank_reference} label="Bank reference" /> : '—'}</td>
                      <td className={`${TD} whitespace-nowrap text-[13px]`}>{istDateTime(m.received_at_ms)}<div className="text-muted-foreground">{ago(m.received_at_ms, now)}</div></td>
                      <td className={`${TD} text-[13px]`}>{m.source_device ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 md:hidden">
              {sms.map((m) => (
                <li key={m.message_hash} className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-dash text-[20px] font-bold tabular-nums">{rupees(m.amount_paise)}</div>
                    <div className="text-right text-[13px] font-semibold text-muted-foreground">{ago(m.received_at_ms, now)}</div>
                  </div>
                  <div className="mt-1 break-all text-[14px] font-semibold text-foreground">{m.payer_vpa ?? 'Unknown payer'}</div>
                  <div className="text-[13px] font-semibold text-muted-foreground">
                    {istDateTime(m.received_at_ms)}{m.bank_reference ? ` · Ref ${m.bank_reference}` : ''}{m.source_device ? ` · ${m.source_device}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <Uncorroborated items={data?.confirmed_uncorroborated ?? []} now={now} />

      <ForwarderSetup now={now} />

      <ConfirmDialog checkout={confirming} sms={sms} now={now} onClose={() => setConfirming(null)} onSubmit={(c, b) => void act('confirm', c, b)} />
      <RejectDialog checkout={rejecting} onClose={() => setRejecting(null)} onSubmit={(c, r) => void act('reject', c, { reason: r })} />
      {busy.size > 0 && <div className="fixed bottom-24 right-4 z-50 rounded-full bg-card p-2 shadow-lg sm:bottom-4" aria-hidden><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>}
    </div>
  );
}
