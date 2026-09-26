/* peopleKit — [ADMIN2-PEOPLE 2026-09-26] Shared pieces for the Admin 2 Bookings, Payments,
 * Customers, Refunds and Prices screens. Contract: Specs/SPEC-2026-09-26-ADMIN-2.md.
 *
 *  - adminCall(): adminApi() plus ONE retry with a freshly minted Clerk token on a 401
 *    (a Clerk session JWT lives about a minute; admin pages stay open for hours).
 *  - usePaged(): cursor-paged list with abort-on-refilter and "Load more".
 *  - URL-synced filters (replaceState), status pills, the customer cell, the CSV export
 *    button (emits admin2_export {kind}), the totals tile, empty/error states.
 * Screen islands never mount a Clerk provider: AdminNav owns it (see adminApi.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownToLine, Check, Copy, Filter, Loader2, RefreshCw, Search, SearchX } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { request, type RequestOptions } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '../../components/ui/drawer';
import { toast } from '../../components/ui/sonner';
import { ApiError, adminApi, adminBlob, saveBlob, errMessage, isAbort, formatPaise } from './adminApi';

export { formatPaise };

/* ── API ────────────────────────────────────────────────────────────────── */

/** adminApi() with one fresh-token retry on 401. */
export async function adminCall<T>(path: string, opts: Omit<RequestOptions, 'auth'> = {}): Promise<T> {
  try {
    return await adminApi<T>(path, opts);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const fresh = await getActiveTokenWaited(5000, { skipCache: true });
    if (!fresh) throw e;
    return request<T>(path, { timeoutMs: 20_000, ...opts, auth: fresh });
  }
}

export interface Customer { uid: string; name: string | null; email: string | null; phone_masked: string | null; phone_hash_only: boolean }

export interface Page<T> { items: T[]; next_cursor?: string; [k: string]: unknown }

/**
 * Cursor-paged GET. Refetches from the top whenever `key` changes (the serialised query);
 * a newer fetch aborts the older one. `first` keeps the first page's extra fields (totals…).
 */
export function usePaged<T>(path: string, query: Record<string, string | undefined>, key: string) {
  const [items, setItems] = useState<T[]>([]);
  const [first, setFirst] = useState<Page<T> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const q = useRef(query);
  q.current = query;

  const load = useCallback(async () => {
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    setPhase('loading'); setError(null);
    try {
      const r = await adminCall<Page<T>>(path, { query: q.current, signal: c.signal });
      if (c.signal.aborted) return;
      setItems(r.items ?? []); setFirst(r); setCursor(r.next_cursor ?? null); setPhase('ready');
    } catch (e) {
      if (isAbort(e) || c.signal.aborted) return;
      captureException(e, { where: 'admin2_list', path });
      setError(errMessage(e, 'Could not load this list.')); setPhase('error');
    }
  }, [path]);

  useEffect(() => { void load(); return () => ctl.current?.abort(); }, [load, key]);

  const loadMore = useCallback(async () => {
    if (!cursor || more) return;
    setMore(true);
    try {
      const r = await adminCall<Page<T>>(path, { query: { ...q.current, cursor } });
      setItems((prev) => [...prev, ...(r.items ?? [])]); setCursor(r.next_cursor ?? null);
    } catch (e) {
      captureException(e, { where: 'admin2_list_more', path });
      toast.error(errMessage(e, 'Could not load more.'));
    } finally { setMore(false); }
  }, [cursor, more, path]);

  return { items, setItems, first, cursor, phase, error, more, reload: load, loadMore };
}

/* ── URL-synced filters ─────────────────────────────────────────────────── */

export function readParams<K extends string>(keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  const u = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  for (const k of keys) out[k] = (u.get(k) ?? '').slice(0, 120);
  return out;
}
export function writeParams(f: Record<string, string>) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(f)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
  history.replaceState(history.state, '', u.toString());
}

/** Filter state mirrored into the URL. `q` is debounced into `applied` (350 ms). */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [f, setF] = useState<Record<K, string>>(() => readParams(keys));
  const [applied, setApplied] = useState(f);
  useEffect(() => {
    const t = setTimeout(() => setApplied(f), 'q' in f ? 350 : 0);
    return () => clearTimeout(t);
  }, [f]);
  useEffect(() => { writeParams(applied); }, [applied]);
  const set = useCallback((p: Partial<Record<K, string>>) => setF((o) => ({ ...o, ...p })), []);
  const clear = useCallback(() => setF((o) => {
    const n = { ...o }; for (const k of keys) if (k !== 'event' && k !== 'uid') n[k] = ''; return n;
  }), [keys]);
  return { f, applied, set, clear, key: JSON.stringify(applied) };
}

/** "YYYY-MM-DD" (IST calendar day) -> epoch ms at the start / end of that day. */
export function dayMs(day: string, end = false): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const ms = Date.parse(`${day}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  return Number.isFinite(ms) ? String(ms) : undefined;
}

/* ── status pills ───────────────────────────────────────────────────────── */

export type Status = 'paid' | 'free' | 'pending' | 'refund_requested' | 'refunded' | 'requested' | 'rejected';
const AMBER = 'bg-[color-mix(in_srgb,var(--grand-gold,#d1ae70)_58%,var(--grand-red,#c82c25))] text-primary-foreground';
export const STATUS_META: Record<Status, { label: string; cls: string; dot: string }> = {
  paid: { label: 'Paid', cls: 'bg-accent text-accent-foreground', dot: 'bg-accent' },
  free: { label: 'Free', cls: 'bg-secondary text-secondary-foreground', dot: 'bg-secondary' },
  pending: { label: 'Pending', cls: 'border-grand-gold bg-grand-gold/25 text-foreground', dot: 'bg-grand-gold' },
  refund_requested: { label: 'Refund requested', cls: AMBER, dot: 'bg-[color-mix(in_srgb,var(--grand-gold,#d1ae70)_58%,var(--grand-red,#c82c25))]' },
  refunded: { label: 'Refunded', cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  requested: { label: 'Requested', cls: AMBER, dot: 'bg-primary' },
  rejected: { label: 'Rejected', cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const m = STATUS_META[status as Status] ?? { label: status, cls: 'bg-muted text-muted-foreground' };
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full border border-transparent px-2.5 py-0.5 text-[11.5px] font-extrabold tracking-[0.04em]', m.cls, className)}>
      {m.label}
    </span>
  );
}

export function StatusToggles<S extends Status>({ options, value, onChange }: { options: readonly S[]; value: string; onChange: (v: string) => void }) {
  const on = new Set(value ? value.split(',') : []);
  return (
    <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
      {options.map((s) => {
        const active = on.has(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            onClick={() => { const n = new Set(on); if (active) n.delete(s); else n.add(s); onChange([...n].join(',')); }}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
            )}
          >
            <span aria-hidden className={cn('h-2 w-2 rounded-full', active ? 'bg-accent-foreground' : STATUS_META[s].dot)} />
            {STATUS_META[s].label}
          </button>
        );
      })}
    </div>
  );
}

/* ── small pieces ───────────────────────────────────────────────────────── */

export function CopyValue({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="select-all break-all font-dashbody font-extrabold tabular-nums tracking-[0.04em]">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={async (e) => {
          e.stopPropagation();
          try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }
          catch { toast.error('Could not copy. Long-press to copy instead.'); }
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {done ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

export function phoneText(c: Pick<Customer, 'phone_masked' | 'phone_hash_only'>): string | null {
  if (c.phone_masked) return c.phone_masked;
  return c.phone_hash_only ? 'Phone on file (not readable)' : null;
}

/** Name → the user's panel on /admin/users, then email and masked phone. */
export function CustomerCell({ c, compact }: { c: Customer; compact?: boolean }) {
  const phone = phoneText(c);
  return (
    <div className="min-w-0">
      <a href={`/admin/users?user=${encodeURIComponent(c.uid)}`} className="font-extrabold text-foreground underline-offset-2 hover:text-accent hover:underline">
        {c.name ?? 'No name'}
      </a>
      {c.email && <div className={cn('truncate text-[12.5px] font-semibold text-muted-foreground', compact && 'text-[12px]')} title={c.email}>{c.email}</div>}
      {phone && (
        <div className={cn('text-[12.5px] font-semibold tabular-nums text-muted-foreground', c.phone_hash_only && 'italic')}
          title={c.phone_hash_only ? 'Only a hash of this number is stored. Search with the full 10-digit number to find it.' : undefined}>
          {phone}
        </div>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="pl-9" />
    </div>
  );
}

export function DateField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label htmlFor={id} className="grid gap-1 text-[12px] font-bold text-muted-foreground">
      {label}
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} className="font-semibold text-foreground" />
    </label>
  );
}

/**
 * Filters: inline at md+, a bottom drawer on phones (search stays visible). `count` is the
 * number of active filters shown on the phone button.
 */
export function FilterBar({ search, children, count, title, onClear, resultLabel }: {
  search: ReactNode; children: ReactNode; count: number; title: string; onClear: () => void; resultLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="hidden rounded-xl border border-border/60 bg-card p-4 shadow-sm md:block">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">{search}</div>
          {children}
          {count > 0 && <Button variant="ghost" size="sm" onClick={onClear}>Clear filters</Button>}
        </div>
      </div>
      <div className="flex items-center gap-2 md:hidden">
        <div className="flex-1">{search}</div>
        <Button variant="outline" size="icon" className="relative shrink-0" onClick={() => setOpen(true)} aria-label={`Filters${count ? `, ${count} active` : ''}`}>
          <Filter />
          {count > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-extrabold text-primary-foreground">{count}</span>}
        </Button>
      </div>
      <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>Dates are in India time (IST).</DrawerDescription>
          </DrawerHeader>
          <div className="grid gap-4 overflow-y-auto px-4 pb-2">{children}</div>
          <DrawerFooter className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onClick={onClear} disabled={!count}>Clear all</Button>
            <Button variant="accent" className="flex-1" onClick={() => setOpen(false)}>{resultLabel}</Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

/** Downloads the worker's CSV for the current filters; emits admin2_export {kind}. */
export function ExportButton({ kind, path, query, className }: { kind: string; path: string; query: Record<string, string | undefined>; className?: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
      qs.set('format', 'csv');
      const { blob, filename } = await adminBlob(`${path}?${qs.toString()}`);
      saveBlob(blob, filename ?? `saathum-${kind}.csv`);
      capture('admin2_export', { kind, ok: true, bytes: blob.size, filtered: Object.values(query).some(Boolean), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      capture('admin2_export', { kind, ok: false, reason: e instanceof ApiError ? e.error : 'network' });
      captureException(e, { where: 'admin2_export', kind });
      toast.error(errMessage(e, 'Could not export. Please try again.'));
    } finally { setBusy(false); }
  };
  return (
    <Button variant="outline" onClick={run} disabled={busy} className={className}>
      {busy ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
      {busy ? 'Preparing CSV…' : 'Export CSV'}
    </Button>
  );
}

export function Tile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'accent' | 'gold' | 'amber' | 'muted' }) {
  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 shadow-sm',
      tone === 'accent' ? 'border-accent/50' : tone === 'gold' ? 'border-grand-gold/70' : tone === 'amber' ? 'border-primary/40' : 'border-border/60',
    )}>
      <div className="text-[12px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-dash text-[22px] font-bold leading-tight text-foreground tabular-nums sm:text-[24px]">{value}</div>
      {hint && <div className="mt-1 text-[12.5px] font-semibold text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center">
      <AlertCircle className="h-5 w-5 shrink-0 text-primary" />
      <p className="flex-1 text-[14px] font-semibold text-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw /> Try again</Button>
    </div>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <SearchX className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="font-dash text-[17px] font-bold text-foreground">{title}</p>
      {body && <p className="max-w-md text-[14px] font-semibold text-muted-foreground">{body}</p>}
    </div>
  );
}

export function LoadMore({ show, busy, onClick, shown }: { show: boolean; busy: boolean; onClick: () => void; shown: number }) {
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      <p className="text-[12.5px] font-semibold text-muted-foreground">Showing {shown}{show ? '+' : ''}</p>
      {show && (
        <Button variant="outline" onClick={onClick} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Load more
        </Button>
      )}
    </div>
  );
}

/** Table header cell / cell classes shared by the desktop tables. */
export const TH = 'px-4 py-3 text-left text-[12px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground';
export const TD = 'px-4 py-3 align-top text-[14px] font-semibold text-foreground';
