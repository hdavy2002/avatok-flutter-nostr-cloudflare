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
import { AlertCircle, ArrowDownToLine, Check, Copy, Filter, Loader2, RefreshCw, Search } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { request, type RequestOptions } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { cn } from '../../lib/utils';
import { Input } from '../../components/ui/input';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '../../components/ui/drawer';
import { toast } from '../../components/ui/sonner';
import { DesiCard, DesiChip, DesiEmpty, Jasmine, Marigold } from './desi';
import { cacheClear, cacheGet, cachePut } from './adminCache';
import { ApiError, adminApi, adminBlob, saveBlob, errMessage, isAbort, formatPaise } from './adminApi';

export { formatPaise };

/* ── API ────────────────────────────────────────────────────────────────── */

export type AdminCallOpts<T> = Omit<RequestOptions, 'auth'> & {
  /** [HF-ADMIN-CACHE-1] GET only. Opt in to stale-while-revalidate: called synchronously with the last
   *  response for this path+query (if any, under 30 min old) before the live fetch, which still runs and is returned. */
  onCached?: (cached: T) => void;
};

/** adminApi() with one fresh-token retry on 401. */
export async function adminCall<T>(path: string, opts: AdminCallOpts<T> = {}): Promise<T> {
  const { onCached, ...rest } = opts;
  const isGet = !rest.method || rest.method === 'GET';
  if (isGet && onCached) {
    const hit = cacheGet<T>(path, rest.query);
    if (hit !== undefined) { try { onCached(hit); } catch { /* a bad cached shape must not block the live fetch */ } }
  }
  let out: T;
  try {
    out = await adminApi<T>(path, rest);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const fresh = await getActiveTokenWaited(5000, { skipCache: true });
    if (!fresh) throw e;
    if (!isGet) cacheClear();
    try { out = await request<T>(path, { timeoutMs: 20_000, ...rest, auth: fresh }); } finally { if (!isGet) cacheClear(); }
  }
  if (isGet && onCached) cachePut(path, rest.query, out);
  return out;
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
      const r = await adminCall<Page<T>>(path, {
        query: q.current, signal: c.signal,
        // [HF-ADMIN-CACHE-1] paint the last response at once; the live fetch below replaces it.
        onCached: (hit) => { if (c.signal.aborted) return; setItems(hit.items ?? []); setFirst(hit); setCursor(hit.next_cursor ?? null); setPhase('ready'); },
      });
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
type ChipTone = 'tea' | 'gold' | 'rani' | 'lav' | 'grey';
/* Money in = peacock, waiting = gold, money back = rani, info = lavender. */
export const STATUS_META: Record<Status, { label: string; tone: ChipTone; ink: string }> = {
  paid: { label: 'Paid', tone: 'tea', ink: '#0e7c86' },
  free: { label: 'Free', tone: 'lav', ink: '#6d4fd0' },
  pending: { label: 'Pending', tone: 'gold', ink: '#b45309' },
  refund_requested: { label: 'Refund requested', tone: 'gold', ink: '#b45309' },
  refunded: { label: 'Refunded', tone: 'rani', ink: '#d81b72' },
  requested: { label: 'Requested', tone: 'gold', ink: '#b45309' },
  rejected: { label: 'Rejected', tone: 'grey', ink: '#6f5b6f' },
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const m = STATUS_META[status as Status];
  return <DesiChip tone={m?.tone ?? 'grey'} className={cn('whitespace-nowrap', className)}>{m?.label ?? status}</DesiChip>;
}

export function StatusToggles<S extends Status>({ options, value, onChange }: { options: readonly S[]; value: string; onChange: (v: string) => void }) {
  const on = new Set(value ? value.split(',') : []);
  return (
    <div role="group" aria-label="Status" className="hfa-pills">
      {options.map((s) => {
        const active = on.has(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            onClick={() => { const n = new Set(on); if (active) n.delete(s); else n.add(s); onChange([...n].join(',')); }}
            className="hfa-pill inline-flex items-center gap-2"
          >
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: active ? '#ffd166' : STATUS_META[s].ink }} />
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
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--a-muted,#6f5b6f)] transition-colors hover:bg-[var(--a-blush,#ffe6ef)] hover:text-[var(--a-rani,#d81b72)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]"
      >
        {done ? <Check className="h-4 w-4 text-[var(--a-peacock,#0e7c86)]" /> : <Copy className="h-4 w-4" />}
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
      <a href={`/admin/users?user=${encodeURIComponent(c.uid)}`} className="font-extrabold text-[var(--a-ink,#2b1530)] underline-offset-2 hover:text-[var(--a-rani,#d81b72)] hover:underline">
        {c.name ?? 'No name'}
      </a>
      {c.email && <div className={cn('truncate text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]', compact && 'text-[14px]')} title={c.email}>{c.email}</div>}
      {phone && (
        <div className={cn('text-[14px] font-semibold tabular-nums text-[var(--a-muted,#6f5b6f)]', c.phone_hash_only && 'italic')}
          title={c.phone_hash_only ? 'Only a hash of this number is stored. Search with the full 10-digit number to find it.' : undefined}>
          {phone}
        </div>
      )}
    </div>
  );
}

/** A rounded pill search field. */
export function SearchBox({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--a-rani,#d81b72)]" />
      <Input
        type="search" value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label}
        className="h-11 min-h-11 rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white pl-10 pr-4 text-[length:var(--fs-small,14px)] font-semibold shadow-none focus-visible:border-[var(--a-plum,#4a1747)] focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]"
      />
    </div>
  );
}

export function DateField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label htmlFor={id} className="grid gap-1 text-[14px] font-bold text-[var(--a-muted,#6f5b6f)]">
      {label}
      <Input
        id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-11 min-h-11 rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white px-4 font-semibold text-[var(--a-ink,#2b1530)] shadow-none focus-visible:ring-2 focus-visible:ring-[var(--a-rani,#d81b72)]"
      />
    </label>
  );
}

/**
 * Filters: a rounded pill toolbar at md+, a bottom drawer on phones (search stays visible). `count` is the
 * number of active filters shown on the phone button.
 */
export function FilterBar({ search, children, count, title, onClear, resultLabel }: {
  search: ReactNode; children: ReactNode; count: number; title: string; onClear: () => void; resultLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="relative hidden overflow-hidden rounded-[32px] border border-[var(--a-line,#f1e3d6)] bg-[linear-gradient(100deg,#fff,#fff6ee_60%,#ffeaf3)] p-3 shadow-[var(--a-shadow,0_10px_26px_-14px_rgba(74,23,71,.24))] md:block">
        <span aria-hidden className="pointer-events-none absolute -right-3 -top-3 opacity-60"><Jasmine size={46} /></span>
        <div className="relative flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">{search}</div>
          {children}
          {count > 0 && <button type="button" className="hfa-btn ghost" onClick={onClear}>Clear filters</button>}
        </div>
      </div>
      <div className="flex items-center gap-2 md:hidden">
        <div className="flex-1">{search}</div>
        <button
          type="button"
          className="hfa-btn relative !h-11 !w-11 shrink-0 !px-0"
          onClick={() => setOpen(true)}
          aria-label={`Filters${count ? `, ${count} active` : ''}`}
        >
          <Filter className="h-5 w-5" />
          {count > 0 && <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-[var(--a-rani,#d81b72)] px-1 text-[14px] font-extrabold text-white">{count}</span>}
        </button>
      </div>
      <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <DrawerContent className="hf-admin-operations">
          <DrawerHeader className="text-left">
            <DrawerTitle className="flex items-center gap-2 text-[var(--a-plum,#4a1747)]"><Marigold size={22} />{title}</DrawerTitle>
            <DrawerDescription>Dates are in India time (IST).</DrawerDescription>
          </DrawerHeader>
          <div className="grid gap-4 overflow-y-auto px-4 pb-2">{children}</div>
          <DrawerFooter className="flex-row gap-2">
            <button type="button" className="hfa-btn ghost flex-1" onClick={onClear} disabled={!count}>Clear all</button>
            <button type="button" className="hfa-btn rani flex-1" onClick={() => setOpen(false)}>{resultLabel}</button>
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
    <button type="button" onClick={run} disabled={busy} className={cn('hfa-btn gold', className)}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
      {busy ? 'Preparing CSV…' : 'Export CSV'}
    </button>
  );
}

/** Small coloured number tile (accent = money in/peacock, gold = waiting, amber = money out/rani, muted = info/lavender). */
export function Tile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'accent' | 'gold' | 'amber' | 'muted' }) {
  const k = tone === 'accent' ? 'tea' : tone === 'gold' ? 'gold' : tone === 'amber' ? 'rani' : 'lav';
  return (
    <div className={cn('hfa-kpi', `hfa-k-${k}`)} style={{ minHeight: 0 }}>
      <span className="hfa-kpi-lbl">{label}</span>
      <span className="hfa-kpi-big" style={{ fontSize: 'clamp(22px, 17px + 1vw, 32px)' }}>{value}</span>
      {hint && <span className="hfa-kpi-sub">{hint}</span>}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-[22px] bg-[linear-gradient(100deg,#ffe6ef,#fff1d6,#f1ebff)] motion-reduce:animate-none" />)}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <DesiCard tone="rani" corner="hibiscus">
      <div role="alert" className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <AlertCircle className="h-6 w-6 shrink-0 text-[var(--a-rani,#d81b72)]" />
        <p className="flex-1 pr-10 text-[length:var(--fs-small,14px)] font-bold text-[var(--a-ink,#2b1530)]">{message}</p>
        <button type="button" className="hfa-btn ghost" onClick={onRetry}><RefreshCw className="h-4 w-4" /> Try again</button>
      </div>
    </DesiCard>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <DesiCard tone="lav" corner="jasmine" pattern="dots">
      <DesiEmpty text={<><b className="font-['Nunito'] text-[1.15em] text-[var(--a-plum,#4a1747)]">{title}</b>{body && <><br />{body}</>}</>} />
    </DesiCard>
  );
}

export function LoadMore({ show, busy, onClick, shown }: { show: boolean; busy: boolean; onClick: () => void; shown: number }) {
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      <p className="hfa-note">Showing {shown}{show ? '+' : ''}</p>
      {show && (
        <button type="button" className="hfa-btn ghost" onClick={onClick} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Load more
        </button>
      )}
    </div>
  );
}

/** Table header cell / cell classes shared by the desktop tables. */
export const TH = 'px-4 py-3 text-left text-[14px] font-extrabold uppercase tracking-[0.08em] text-[var(--a-plum,#4a1747)]';
export const TD = 'px-4 py-3 align-top text-[14px] font-semibold text-[var(--a-ink,#2b1530)]';
