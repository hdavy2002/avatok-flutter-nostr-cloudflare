/* Wallets — [AUMFE-WALLET-ADMIN-1] Everyone with a wallet: balance, topped up, spent, last activity.
 * GET  /api/admin/v2/wallets?q&filter&sort&from&to&cursor
 * GET  /api/admin/v2/wallets/:uid                   live balance (from the wallet itself) + statement
 * POST /api/admin/v2/wallets/:uid/adjust            {amount_tokens, reason}  + Idempotency-Key header
 * THE UNIT IS A TOKEN AND 1 TOKEN = ₹1, so amounts on the wire are tokens and shown as ₹.
 * The list is a mirror of the wallet statement (it can lag a few seconds); the panel under a row
 * always shows the live balance. Row click opens the panel directly below it (URL ?wallet=<uid>). */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, Info, Loader2, Minus, Plus, Wallet as WalletIcon } from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage, errCode } from './adminApi';
import {
  CopyValue, DateField, Empty, ErrorBox, FilterBar, ListSkeleton, LoadMore, SearchBox, TD, TH, Tile,
  adminCall, dayMs, usePaged, useUrlFilters,
} from './peopleKit';

/* ── types + helpers ────────────────────────────────────────────────────── */

interface WalletItem {
  uid: string; name: string | null; email: string | null; phone_masked: string | null;
  balance_tokens: number; topped_up_tokens: number; spent_tokens: number; spent_voice_tokens: number;
  last_activity_at: number | null; transactions: number;
}
interface StatementRow {
  id: string; type: string; amount_tokens: number; balance_after_tokens: number | null;
  app_name: string | null; category: string | null; context: string | null; ref: string | null; created_at: number;
}
interface Detail {
  uid: string;
  profile: { name: string | null; email: string | null; phone_masked: string | null; profile_url: string };
  live: { balance_tokens: number; held_tokens: number; free_tokens: number; bonus_tokens: number; spendable_tokens: number; as_of: number };
  statement: StatementRow[];
}

/** Tokens are rupees (1 token = ₹1). */
const rupees = (tokens: number) => `${tokens < 0 ? '−' : ''}₹${Math.abs(Math.round(tokens)).toLocaleString('en-IN')}`;
const MAX_TOKENS = 100_000;

const KEYS = ['q', 'filter', 'sort', 'from', 'to'] as const;
const FILTERS = [
  { key: 'has_balance', label: 'Has balance' },
  { key: 'zero_balance', label: 'Zero balance' },
  { key: 'topped_up', label: 'Topped up' },
  { key: 'spent_voice', label: 'Spent on voice' },
] as const;
const SORTS = [
  { key: 'last_activity', label: 'Latest activity' },
  { key: 'balance', label: 'Highest balance' },
  { key: 'name', label: 'Name A–Z' },
] as const;

const TYPE_LABEL: Record<string, string> = {
  topup: 'Top-up', spend: 'Spend', earn: 'Earning', refund: 'Refund / correction', payout: 'Payout', promo: 'Promo', gift: 'Gift',
  adjustment: 'Admin correction', ai_settle: 'AI usage', human_call_overage: 'Call', messenger_call_overage: 'Call',
};
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, ' ');

const who = (w: { name: string | null; email: string | null; uid: string }) => w.name ?? w.email ?? w.uid;

function Expander({ open, children, id }: { open: boolean; children: ReactNode; id: string }) {
  return (
    <div
      id={id}
      className={cn('grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function useIsDesktop(): boolean {
  const [d, setD] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 768px)');
    const on = () => setD(m.matches);
    on(); m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return d;
}

function readWalletParam(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('wallet');
  return v ? v.slice(0, 200) : null;
}
function writeWalletParam(uid: string | null) {
  const u = new URL(location.href);
  if (uid) u.searchParams.set('wallet', uid); else u.searchParams.delete('wallet');
  history.replaceState(history.state, '', u.toString());
}

/* ── main ───────────────────────────────────────────────────────────────── */

export default function Wallets() {
  const { f, applied, set, clear, key } = useUrlFilters(KEYS);
  const query = useMemo(() => ({
    q: applied.q.trim() || undefined,
    filter: applied.filter || undefined,
    sort: applied.sort && applied.sort !== 'last_activity' ? applied.sort : undefined,
    from: dayMs(applied.from),
    to: dayMs(applied.to, true),
  }), [applied]);
  const list = usePaged<WalletItem>('/api/admin/v2/wallets', query, key);
  const totals = (list.first?.totals ?? null) as { wallets: number; balance_tokens: number; topped_up_tokens: number; spent_tokens: number } | null;
  const desktop = useIsDesktop();

  const [open, setOpen] = useState<string | null>(readWalletParam);
  const [closing, setClosing] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggle = useCallback((uid: string) => {
    setOpen((cur) => {
      const next = cur === uid ? null : uid;
      if (cur) {
        setClosing(cur);
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setClosing(null), 320);
      }
      writeWalletParam(next);
      return next;
    });
  }, []);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const patch = useCallback((uid: string, p: Partial<WalletItem>) => {
    list.setItems((items) => items.map((w) => (w.uid === uid ? { ...w, ...p } : w)));
  }, [list.setItems]); // eslint-disable-line react-hooks/exhaustive-deps

  const on = new Set(f.filter ? f.filter.split(',') : []);
  const flip = (k: string) => {
    const n = new Set(on);
    if (n.has(k)) n.delete(k); else n.add(k);
    // "has balance" and "zero balance" contradict each other: picking one drops the other.
    if (n.has(k) && k === 'has_balance') n.delete('zero_balance');
    if (n.has(k) && k === 'zero_balance') n.delete('has_balance');
    set({ filter: [...n].join(',') });
  };
  const count = on.size + (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.sort && f.sort !== 'last_activity' ? 1 : 0);
  const q = applied.q.trim();
  const openInList = !!open && list.items.some((w) => w.uid === open);
  const mounted = (uid: string) => uid === open || uid === closing;

  return (
    <div className="space-y-4">
      <FilterBar
        title="Filter wallets"
        count={count}
        onClear={clear}
        resultLabel={list.phase === 'ready' ? `Show ${list.items.length}${list.cursor ? '+' : ''}` : 'Show'}
        search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search wallets" placeholder="Name, email, phone or user ID" />}
      >
        <div role="group" aria-label="Filters" className="flex flex-wrap gap-2">
          {FILTERS.map((x) => (
            <button
              key={x.key}
              type="button"
              aria-pressed={on.has(x.key)}
              onClick={() => flip(x.key)}
              className={cn(
                'inline-flex h-11 items-center rounded-full border px-4 text-[14px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on.has(x.key) ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        <DateField id="w-from" label="Active from" value={f.from} onChange={(v) => set({ from: v })} />
        <DateField id="w-to" label="Active to" value={f.to} onChange={(v) => set({ to: v })} />
        <label className="grid gap-1 text-[13px] font-bold text-muted-foreground">
          Sort
          <Select value={f.sort || 'last_activity'} onValueChange={(v) => set({ sort: v === 'last_activity' ? '' : v })}>
            <SelectTrigger className="h-11 w-[190px] font-semibold text-foreground" aria-label="Sort wallets"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </label>
      </FilterBar>

      <p className="text-[14px] font-semibold text-muted-foreground" aria-live="polite">
        {list.phase === 'loading' ? 'Loading…' : totals
          ? `${totals.wallets} wallet${totals.wallets === 1 ? '' : 's'} · ${rupees(totals.balance_tokens)} held in balances · ${rupees(totals.topped_up_tokens)} topped up · ${rupees(totals.spent_tokens)} spent`
          : ''}
      </p>

      {open && !openInList && list.phase === 'ready' && (
        <div className="rounded-xl border border-grand-gold/60 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border/50 px-4 py-2">
            <span className="text-[14px] font-bold text-muted-foreground">Opened from a link</span>
            <Button variant="ghost" className="min-h-11" onClick={() => toggle(open)}>Close</Button>
          </div>
          <WalletPanel uid={open} onChange={patch} />
        </div>
      )}

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load wallets.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <Empty
            title={q || count ? 'No wallet matches' : 'No wallets yet'}
            body={q ? 'Check the spelling, or try the full email, the full mobile number or the user ID. Only people who have used their wallet appear here.' : 'People appear here once their wallet has its first top-up or charge.'}
          />
        ) : desktop ? (
          <div className="overflow-x-auto rounded-xl border border-border/60 bg-card shadow-sm">
            <table className="w-full min-w-[960px] border-collapse">
              <thead className="bg-muted/60">
                <tr>
                  <th className={TH}>User</th><th className={`${TH} text-right`}>Balance</th><th className={`${TH} text-right`}>Topped up</th>
                  <th className={`${TH} text-right`}>Spent</th><th className={TH}>Last activity</th><th className="w-10" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {list.items.map((w) => {
                  const isOpen = w.uid === open;
                  return [
                    <tr key={w.uid} className={cn('cursor-pointer border-t border-border/40 hover:bg-muted/30', isOpen && 'bg-muted/40')} onClick={() => toggle(w.uid)}>
                      <td className={`${TD} max-w-[320px]`}>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-controls={`wallet-panel-${w.uid}`}
                          onClick={(e) => { e.stopPropagation(); toggle(w.uid); }}
                          className="min-h-11 text-left font-extrabold text-foreground underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {w.name ?? 'No name'}
                        </button>
                        <div className="truncate text-[13px] font-semibold text-muted-foreground" title={w.email ?? undefined}>{w.email ?? '—'}</div>
                        {w.phone_masked && <div className="text-[13px] font-semibold tabular-nums text-muted-foreground">{w.phone_masked}</div>}
                      </td>
                      <td className={`${TD} text-right text-[16px] font-extrabold tabular-nums`}>{rupees(w.balance_tokens)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{rupees(w.topped_up_tokens)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{rupees(w.spent_tokens)}</td>
                      <td className={`${TD} whitespace-nowrap text-[14px] text-muted-foreground`}>{w.last_activity_at ? istDateTime(w.last_activity_at) : '—'}</td>
                      <td className={`${TD} pr-3`}><ChevronDown aria-hidden className={cn('h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} /></td>
                    </tr>,
                    <tr key={`${w.uid}-panel`} className={cn(!mounted(w.uid) && 'hidden')}>
                      <td colSpan={6} className="p-0">
                        <Expander open={isOpen} id={`wallet-panel-${w.uid}`}>
                          {mounted(w.uid) && <div className="border-t border-border/40 bg-background/60"><WalletPanel uid={w.uid} onChange={patch} /></div>}
                        </Expander>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="space-y-3">
            {list.items.map((w) => {
              const isOpen = w.uid === open;
              return (
                <li key={w.uid} className={cn('overflow-hidden rounded-xl border bg-card shadow-sm', isOpen ? 'border-grand-gold/70' : 'border-border/60')}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`wallet-panel-m-${w.uid}`}
                    onClick={() => toggle(w.uid)}
                    className="flex min-h-11 w-full items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-extrabold text-foreground">{w.name ?? 'No name'}</div>
                      {w.email && <div className="truncate text-[14px] font-semibold text-muted-foreground">{w.email}</div>}
                      <div className="mt-1 text-[15px] font-extrabold text-foreground tabular-nums">Balance {rupees(w.balance_tokens)}</div>
                      <div className="text-[14px] font-semibold text-muted-foreground">
                        Topped up {rupees(w.topped_up_tokens)} · Spent {rupees(w.spent_tokens)}
                      </div>
                      <div className="text-[14px] font-semibold text-muted-foreground">{w.last_activity_at ? `Last activity ${istDateTime(w.last_activity_at)}` : 'No activity'}</div>
                    </div>
                    <ChevronDown aria-hidden className={cn('h-5 w-5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} />
                  </button>
                  {mounted(w.uid) && (
                    <Expander open={isOpen} id={`wallet-panel-m-${w.uid}`}>
                      <div className="border-t border-border/40 bg-background/60"><WalletPanel uid={w.uid} onChange={patch} /></div>
                    </Expander>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {list.phase === 'ready' && list.items.length > 0 && <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />}
      {list.phase === 'ready' && list.items.length > 0 && (
        <p className="flex items-start gap-1.5 text-[13px] font-semibold text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Balances in this list come from the wallet statement and can lag by a few seconds. Open a row for the live balance.
        </p>
      )}
    </div>
  );
}

/* ── the panel under a row ─────────────────────────────────────────────── */

function WalletPanel({ uid, onChange }: { uid: string; onChange: (uid: string, p: Partial<WalletItem>) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setError(null); setMissing(false);
    try {
      setD(await adminCall<Detail>(`/api/admin/v2/wallets/${encodeURIComponent(uid)}`));
    } catch (e) {
      if (errCode(e) === 'not_found') { setMissing(true); return; }
      captureException(e, { where: 'admin2_wallet_panel', uid });
      setError(errMessage(e, 'Could not load this wallet.'));
    }
  }, [uid]);
  useEffect(() => { void load(); }, [load]);

  if (missing) return <div className="p-4"><Empty title="Wallet not found" body="This account may have been deleted." /></div>;
  if (error) return <div className="p-4"><ErrorBox message={error} onRetry={load} /></div>;
  if (!d) {
    return (
      <div className="flex items-center gap-2 p-6 text-[14px] font-semibold text-muted-foreground" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading live balance…
      </div>
    );
  }
  const l = d.live;
  const label = who({ name: d.profile.name, email: d.profile.email, uid });

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-dash text-[19px] font-bold leading-tight text-foreground">{label}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-muted-foreground">ID</span>
            <CopyValue value={uid} label="user ID" className="text-[13px]" />
            <Badge variant="outline" className="whitespace-nowrap">Live balance, read just now</Badge>
          </div>
        </div>
        <Button asChild variant="outline" className="min-h-11">
          <a href={d.profile.profile_url}><ExternalLink /> Open user profile</a>
        </Button>
      </div>

      <section aria-label="Live balance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Balance" tone="accent" value={rupees(l.balance_tokens)} hint="Paid money they can spend" />
        <Tile label="Spendable now" value={rupees(l.spendable_tokens)} hint="Balance plus free and bonus" />
        <Tile label="Free + bonus" value={rupees(l.free_tokens)} hint="Promotional, not withdrawable" />
        <Tile label="On hold" tone={l.held_tokens ? 'gold' : undefined} value={rupees(l.held_tokens)} hint="Earnings still maturing" />
      </section>

      <AdjustForm uid={uid} label={label} balance={l.balance_tokens} onDone={(next) => { onChange(uid, { balance_tokens: next }); void load(); }} />

      <section aria-label="Statement" className="rounded-xl border border-border/60 bg-card p-4">
        <h3 className="mb-2 font-dash text-[16px] font-bold text-foreground">Statement (latest {d.statement.length})</h3>
        {d.statement.length === 0 ? <p className="text-[14px] font-semibold text-muted-foreground">Nothing on the statement yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th className={TH}>When</th><th className={TH}>What</th><th className={`${TH} text-right`}>Amount</th><th className={`${TH} text-right`}>Balance after</th>
                </tr>
              </thead>
              <tbody>
                {d.statement.map((s) => (
                  <tr key={s.id} className="border-t border-border/40">
                    <td className={`${TD} whitespace-nowrap text-[14px] text-muted-foreground`}>{istDateTime(s.created_at)}</td>
                    <td className={TD}>
                      <div>{typeLabel(s.type)}</div>
                      {(s.context || s.app_name) && <div className="text-[13px] font-semibold text-muted-foreground">{s.context ?? s.app_name}</div>}
                    </td>
                    <td className={cn(`${TD} text-right font-extrabold tabular-nums`, s.amount_tokens > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground')}>
                      {s.amount_tokens > 0 ? '+' : ''}{rupees(s.amount_tokens)}
                    </td>
                    <td className={`${TD} text-right tabular-nums text-muted-foreground`}>{s.balance_after_tokens != null ? rupees(s.balance_after_tokens) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ── add money / deduct ─────────────────────────────────────────────────── */

function newKey(): string {
  try { return `w-${crypto.randomUUID()}`; } catch { return `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function AdjustForm({ uid, label, balance, onDone }: { uid: string; label: string; balance: number; onDone: (nextBalance: number) => void }) {
  const [mode, setMode] = useState<'add' | 'deduct'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per attempt: a retry after a network blip re-sends the SAME key, so it can never apply twice.
  const keyRef = useRef<string>(newKey());

  const n = /^\d{1,6}$/.test(amount.trim()) ? Number(amount.trim()) : NaN;
  const amountErr = amount.trim() === '' ? null
    : !Number.isInteger(n) || n <= 0 ? 'Enter a whole number of rupees, like 500.'
    : n > MAX_TOKENS ? `One change can be at most ${rupees(MAX_TOKENS)}.`
    : mode === 'deduct' && n > balance ? `They only have ${rupees(balance)}. A deduction can't go below zero.`
    : null;
  const reasonOk = reason.trim().length >= 5;
  const ready = Number.isInteger(n) && n > 0 && !amountErr && reasonOk;
  const signed = mode === 'add' ? n : -n;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await adminCall<{ balance_tokens: number; duplicate: boolean }>(`/api/admin/v2/wallets/${encodeURIComponent(uid)}/adjust`, {
        method: 'POST', body: { amount_tokens: signed, reason: reason.trim() }, headers: { 'Idempotency-Key': keyRef.current },
      });
      toast.success(`${mode === 'add' ? 'Added' : 'Deducted'} ${rupees(n)} ${mode === 'add' ? 'to' : 'from'} ${label}. New balance ${rupees(r.balance_tokens)}.`);
      keyRef.current = newKey();
      setAmount(''); setReason(''); setConfirming(false);
      onDone(r.balance_tokens);
    } catch (e) {
      captureException(e, { where: 'admin2_wallet_adjust', uid });
      toast.error(errMessage(e, 'That didn\'t work. Nothing was changed. Please try again.'));
      if (errCode(e) === 'insufficient_balance') setConfirming(false);
    } finally { setBusy(false); }
  };

  return (
    <section aria-label="Add or deduct money" className="rounded-xl border border-border/60 bg-card p-4">
      <h3 className="mb-3 flex items-center gap-1.5 font-dash text-[16px] font-bold text-foreground"><WalletIcon className="h-4 w-4" /> Change this wallet</h3>
      <div className="grid gap-4 md:grid-cols-[auto_180px_1fr_auto] md:items-end">
        <div role="radiogroup" aria-label="Add or deduct" className="inline-flex overflow-hidden rounded-lg border border-border/70">
          {([['add', 'Add money', Plus], ['deduct', 'Deduct', Minus]] as const).map(([k, text, Icon]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={mode === k}
              onClick={() => setMode(k)}
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 px-4 text-[14px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                mode === k ? 'bg-accent text-accent-foreground' : 'bg-card text-foreground hover:bg-muted',
              )}
            >
              <Icon className="h-4 w-4" />{text}
            </button>
          ))}
        </div>
        <label className="grid gap-1 text-[13px] font-bold text-muted-foreground">
          Amount (₹)
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            placeholder="500"
            aria-invalid={!!amountErr}
            className="h-11 text-[15px] font-semibold"
          />
        </label>
        <label className="grid gap-1 text-[13px] font-bold text-muted-foreground">
          Reason (kept in the audit log, at least 5 characters)
          <Input
            value={reason}
            maxLength={300}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: gateway payment received, top-up did not land"
            className="h-11 text-[15px] font-semibold"
          />
        </label>
        <Button
          className={cn('min-h-11', mode === 'deduct' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
          disabled={!ready || busy}
          onClick={() => setConfirming(true)}
        >
          {mode === 'add' ? <Plus /> : <Minus />} {mode === 'add' ? 'Add money' : 'Deduct'}
        </Button>
      </div>
      {amountErr && <p role="alert" className="mt-2 text-[14px] font-semibold text-destructive">{amountErr}</p>}

      <AlertDialog open={confirming} onOpenChange={(o) => { if (!busy) setConfirming(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{mode === 'add' ? `Add ${rupees(n)} to ${label}?` : `Deduct ${rupees(n)} from ${label}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Balance now {rupees(balance)}, after this {rupees(balance + (Number.isInteger(signed) ? signed : 0))}. This is recorded in the wallet ledger and the admin audit log with your name and the reason: “{reason.trim()}”. It can't be edited afterwards, only corrected with another entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void submit(); }}
              className={cn('min-h-11', mode === 'deduct' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            >
              {busy ? <Loader2 className="animate-spin" /> : mode === 'add' ? <Plus /> : <Minus />} Confirm {mode === 'add' ? 'add' : 'deduct'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
