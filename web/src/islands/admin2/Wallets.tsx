/* Wallets — [AUMFE-WALLET-ADMIN-1] Everyone with a wallet: balance, topped up, spent, last activity.
 * GET  /api/admin/v2/wallets?q&filter&sort&from&to&cursor
 * GET  /api/admin/v2/wallets/:uid                   live balance (from the wallet itself) + statement
 * POST /api/admin/v2/wallets/:uid/adjust            {amount_tokens, reason}  + Idempotency-Key header
 * THE UNIT IS A TOKEN AND 1 TOKEN = ₹1, so amounts on the wire are tokens and shown as ₹.
 * The list is a mirror of the wallet statement (it can lag a few seconds); the panel under a row
 * always shows the live balance. A wallet card opens that panel in a side sheet (URL ?wallet=<uid>). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Info, Loader2, Minus, Plus, Wallet as WalletIcon } from 'lucide-react';
import { captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../components/ui/sheet';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage, errCode } from './adminApi';
import { DesiAvatar, DesiCard, DesiChip, DesiEmpty, DesiKpi, DesiKpis, Hibiscus, Marigold } from './desi';
import {
  CopyValue, DateField, Empty, ErrorBox, FilterBar, ListSkeleton, LoadMore, SearchBox,
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
  const sheetUid = open ?? closing;

  return (
    <div className="hf-admin-operations hfa-stack">
      {totals && (
        <div className="hfa-row-wide">
          <DesiCard tone="plum" corner="yellow" title="Kul jeb mein" note={`${totals.wallets} wallet${totals.wallets === 1 ? '' : 's'}, money held for customers`}>
            <span aria-hidden className="pointer-events-none absolute -bottom-5 left-[-14px] z-0 opacity-90"><Hibiscus size={92} /></span>
            <div className="relative z-[1] pl-6 sm:pl-10">
              <div className="font-['Nunito'] font-black leading-none text-[#ffd166] [overflow-wrap:anywhere]" style={{ fontSize: 'clamp(36px, 20px + 3.4vw, 80px)' }}>{rupees(totals.balance_tokens)}</div>
              <div className="mt-3 border-t-2 border-dashed border-white/35 pt-2 text-[length:var(--fs-small,14px)] font-bold text-white/90">Balance in all wallets right now</div>
            </div>
          </DesiCard>
          <DesiKpis>
            <DesiKpi tone="tea" icon={<ArrowDownLeft strokeWidth={2.4} />} label="Topped up" value={rupees(totals.topped_up_tokens)} sub="Money in, all time" />
            <DesiKpi tone="rani" icon={<ArrowUpRight strokeWidth={2.4} />} label="Spent" value={rupees(totals.spent_tokens)} sub="Money out, all time" />
          </DesiKpis>
        </div>
      )}

      <FilterBar
        title="Filter wallets"
        count={count}
        onClear={clear}
        resultLabel={list.phase === 'ready' ? `Show ${list.items.length}${list.cursor ? '+' : ''}` : 'Show'}
        search={<SearchBox value={f.q} onChange={(v) => set({ q: v })} label="Search wallets" placeholder="Name, email, phone or user ID" />}
      >
        <div role="group" aria-label="Filters" className="hfa-pills">
          {FILTERS.map((x) => (
            <button key={x.key} type="button" aria-pressed={on.has(x.key)} onClick={() => flip(x.key)} className="hfa-pill">
              {x.label}
            </button>
          ))}
        </div>
        <DateField id="w-from" label="Active from" value={f.from} onChange={(v) => set({ from: v })} />
        <DateField id="w-to" label="Active to" value={f.to} onChange={(v) => set({ to: v })} />
        <label className="grid gap-1 text-[14px] font-bold text-[var(--a-muted,#6f5b6f)]">
          Sort
          <Select value={f.sort || 'last_activity'} onValueChange={(v) => set({ sort: v === 'last_activity' ? '' : v })}>
            <SelectTrigger className="h-11 w-[190px] rounded-full border-[1.5px] border-[var(--a-line,#f1e3d6)] bg-white font-semibold text-[var(--a-ink,#2b1530)]" aria-label="Sort wallets"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        </label>
      </FilterBar>

      <p className={cn('hfa-note !mt-0', totals && 'sr-only')} aria-live="polite">
        {list.phase === 'loading' ? 'Loading…' : totals
          ? `${totals.wallets} wallet${totals.wallets === 1 ? '' : 's'} · ${rupees(totals.balance_tokens)} held in balances · ${rupees(totals.topped_up_tokens)} topped up · ${rupees(totals.spent_tokens)} spent`
          : ''}
      </p>

      {list.phase === 'loading' ? <ListSkeleton /> : list.phase === 'error' ? <ErrorBox message={list.error ?? 'Could not load wallets.'} onRetry={list.reload} /> :
        list.items.length === 0 ? (
          <Empty
            title={q || count ? 'No wallet matches' : 'No wallets yet'}
            body={q ? 'Check the spelling, or try the full email, the full mobile number or the user ID. Only people who have used their wallet appear here.' : 'People appear here once their wallet has its first top-up or charge.'}
          />
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-[clamp(10px,1vw,16px)] p-0">
            {list.items.map((w) => {
              const full = w.balance_tokens > 0;
              const isOpen = w.uid === open;
              return (
                <li key={w.uid} className="min-w-0">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={isOpen}
                    onClick={() => toggle(w.uid)}
                    className={cn(
                      'relative block w-full overflow-hidden rounded-[24px] border border-[var(--a-line,#f1e3d6)] bg-white p-0 text-left shadow-[var(--a-shadow)] transition-transform hover:-translate-y-0.5 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--a-rani,#d81b72)]',
                      isOpen && 'ring-4 ring-[var(--a-rani,#d81b72)]',
                    )}
                  >
                    <span
                      className={cn('relative block overflow-hidden px-4 pb-4 pt-4', full ? 'text-white' : 'text-[var(--a-plum,#4a1747)]')}
                      style={{ background: full ? 'radial-gradient(90% 120% at 100% 0%, rgba(245,158,11,.5), transparent 55%), linear-gradient(140deg,#4a1747,#7a2470 60%,#b0216f)' : 'repeating-linear-gradient(135deg,#fff6ee 0 14px,#fdebd8 14px 28px)' }}
                    >
                      <span aria-hidden className="pointer-events-none absolute -right-4 -top-5 opacity-95"><Marigold size={70} tone={full ? 1 : 0} /></span>
                      <span className="relative z-[1] flex items-center gap-3 pr-12">
                        <DesiAvatar name={w.name} seed={w.uid} size={46} />
                        <span className="min-w-0">
                          <b className="block font-['Nunito'] [overflow-wrap:anywhere]">{w.name ?? 'No name'}</b>
                          <span className="block truncate text-[14px] font-semibold opacity-90" title={w.email ?? undefined}>{w.email ?? '—'}</span>
                          {w.phone_masked && <span className="block text-[14px] font-semibold tabular-nums opacity-90">{w.phone_masked}</span>}
                        </span>
                      </span>
                      <span className="relative z-[1] mt-3 block text-[14px] font-bold opacity-90">Balance</span>
                      <span className={cn("relative z-[1] block font-['Nunito'] font-black leading-none tabular-nums [overflow-wrap:anywhere]", full && 'text-[#ffd166]')} style={{ fontSize: 'clamp(30px, 22px + 1.4vw, 46px)' }}>{rupees(w.balance_tokens)}</span>
                    </span>
                    <span className="grid grid-cols-2 border-b border-dashed border-[var(--a-line,#f1e3d6)]">
                      <span className="block bg-[var(--a-teatint,#e3f5f6)] px-4 py-2.5">
                        <span className="block text-[14px] font-bold text-[var(--a-peacock,#0e7c86)]">Topped up</span>
                        <span className="block font-['Nunito'] font-black tabular-nums text-[var(--a-ink,#2b1530)]">{rupees(w.topped_up_tokens)}</span>
                      </span>
                      <span className="block bg-[var(--a-blush,#ffe6ef)] px-4 py-2.5">
                        <span className="block text-[14px] font-bold text-[var(--a-rani,#d81b72)]">Spent</span>
                        <span className="block font-['Nunito'] font-black tabular-nums text-[var(--a-ink,#2b1530)]">{rupees(w.spent_tokens)}</span>
                      </span>
                    </span>
                    <span className="block px-4 py-2.5 text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]">{w.last_activity_at ? `Last activity ${istDateTime(w.last_activity_at)}` : 'No activity'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      {list.phase === 'ready' && list.items.length > 0 && <LoadMore show={!!list.cursor} busy={list.more} onClick={list.loadMore} shown={list.items.length} />}
      {list.phase === 'ready' && list.items.length > 0 && (
        <p className="hfa-note flex items-start gap-1.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          Balances in this list come from the wallet statement and can lag by a few seconds. Open a card for the live balance.
        </p>
      )}

      <Sheet open={!!open} onOpenChange={(o) => { if (!o && open) toggle(open); }}>
        <SheetContent className="hf-admin-operations !max-w-[min(100vw,56rem)] !bg-[var(--a-cream,#fffaf3)] !p-0 sm:!max-w-[min(100vw,56rem)]">
          <SheetTitle className="sr-only">Wallet details</SheetTitle>
          <SheetDescription className="sr-only">Live balance, statement and the add or deduct money form for this wallet.</SheetDescription>
          {sheetUid && (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-dashed border-[var(--a-line,#f1e3d6)] bg-[linear-gradient(100deg,#fff1d6,#ffe6ef)] px-4 py-3 pr-16">
                <span className="hfa-eyebrow">Wallet details</span>
                <button type="button" className="hfa-btn ghost" onClick={() => open && toggle(open)}>Close</button>
              </div>
              <WalletPanel key={sheetUid} uid={sheetUid} onChange={patch} />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── the panel for one wallet ──────────────────────────────────────────── */

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
      <div className="flex items-center gap-2 p-6 text-[14px] font-semibold text-[var(--a-muted,#6f5b6f)]" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading live balance…
      </div>
    );
  }
  const l = d.live;
  const label = who({ name: d.profile.name, email: d.profile.email, uid });

  return (
    <div className="hfa-stack p-4 sm:p-5">
      <DesiCard tone="plum" corner="yellow">
        <div className="flex flex-wrap items-center justify-between gap-3 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <DesiAvatar name={d.profile.name ?? d.profile.email} seed={uid} size={60} />
            <div className="min-w-0">
              <div className="font-['Nunito'] text-[length:var(--fs-h2,20px)] font-black leading-tight [overflow-wrap:anywhere]">{label}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold opacity-85">ID</span>
                <CopyValue value={uid} label="user ID" className="text-[14px]" />
                <DesiChip tone="gold" className="whitespace-nowrap">Live balance, read just now</DesiChip>
              </div>
            </div>
          </div>
          <a href={d.profile.profile_url} className="hfa-btn ghost no-underline"><ExternalLink className="h-4 w-4" /> Open user profile</a>
        </div>
      </DesiCard>

      <section aria-label="Live balance">
        <DesiKpis>
          <DesiKpi tone="tea" icon={<WalletIcon strokeWidth={2.2} />} label="Balance" value={rupees(l.balance_tokens)} sub="Paid money they can spend" />
          <DesiKpi tone="plum" icon={<ArrowDownLeft strokeWidth={2.2} />} label="Spendable now" value={rupees(l.spendable_tokens)} sub="Balance plus free and bonus" />
          <DesiKpi tone="lav" icon={<Plus strokeWidth={2.2} />} label="Free + bonus" value={rupees(l.free_tokens)} sub="Promotional, not withdrawable" />
          <DesiKpi tone="gold" icon={<Info strokeWidth={2.2} />} label="On hold" value={rupees(l.held_tokens)} sub="Earnings still maturing" />
        </DesiKpis>
      </section>

      <AdjustForm uid={uid} label={label} balance={l.balance_tokens} onDone={(next) => { onChange(uid, { balance_tokens: next }); void load(); }} />

      <DesiCard title={`Statement (latest ${d.statement.length})`} tone="cream" corner="marigold">
        {d.statement.length === 0 ? <DesiEmpty text="Nothing on the statement yet." /> : (
          <div className="hfa-scroll">
            <table className="hfa-table min-w-[560px]">
              <thead>
                <tr>
                  <th>When</th><th>What</th><th className="text-right">Amount</th><th className="text-right">Balance after</th>
                </tr>
              </thead>
              <tbody>
                {d.statement.map((s) => (
                  <tr key={s.id} style={{ boxShadow: `inset 5px 0 0 ${s.amount_tokens > 0 ? '#0e7c86' : '#d81b72'}` }}>
                    <td className="whitespace-nowrap pl-4 text-[var(--a-muted,#6f5b6f)]">{istDateTime(s.created_at)}</td>
                    <td>
                      <div className="font-bold">{typeLabel(s.type)}</div>
                      {(s.context || s.app_name) && <div className="hfa-note">{s.context ?? s.app_name}</div>}
                    </td>
                    <td className="text-right font-['Nunito'] font-black tabular-nums" style={{ color: s.amount_tokens > 0 ? '#0e7c86' : '#d81b72' }}>
                      {s.amount_tokens > 0 ? '+' : ''}{rupees(s.amount_tokens)}
                    </td>
                    <td className="text-right tabular-nums text-[var(--a-muted,#6f5b6f)]">{s.balance_after_tokens != null ? rupees(s.balance_after_tokens) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DesiCard>
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
    <DesiCard title="Change this wallet" tone="gold" pattern="stripes" note="Careful: every change is written to the wallet ledger and the audit log.">
      <div className="grid gap-4 md:grid-cols-[auto_180px_1fr_auto] md:items-end">
        <div role="radiogroup" aria-label="Add or deduct" className="hfa-pills">
          {([['add', 'Add money', Plus], ['deduct', 'Deduct', Minus]] as const).map(([k, text, Icon]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={mode === k}
              onClick={() => setMode(k)}
              className={cn('hfa-pill inline-flex items-center gap-1.5', mode === k && 'on')}
            >
              <Icon className="h-4 w-4" />{text}
            </button>
          ))}
        </div>
        <label className="grid gap-1 text-[14px] font-bold text-[var(--a-ink,#2b1530)]">
          Amount (₹)
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            placeholder="500"
            aria-invalid={!!amountErr}
            className="h-11 rounded-full border-[1.5px] border-[#e9c98d] bg-white px-4 text-[15px] font-semibold"
          />
        </label>
        <label className="grid gap-1 text-[14px] font-bold text-[var(--a-ink,#2b1530)]">
          Reason (kept in the audit log, at least 5 characters)
          <Input
            value={reason}
            maxLength={300}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: gateway payment received, top-up did not land"
            className="h-11 rounded-full border-[1.5px] border-[#e9c98d] bg-white px-4 text-[15px] font-semibold"
          />
        </label>
        <button
          type="button"
          className={cn('hfa-btn', mode === 'add' ? 'tea' : 'rani')}
          disabled={!ready || busy}
          onClick={() => setConfirming(true)}
        >
          {mode === 'add' ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />} {mode === 'add' ? 'Add money' : 'Deduct'}
        </button>
      </div>
      {amountErr && <p role="alert" className="mt-2 text-[14px] font-bold text-[var(--a-bad,#c0262d)]">{amountErr}</p>}

      <AlertDialog open={confirming} onOpenChange={(o) => { if (!busy) setConfirming(o); }}>
        <AlertDialogContent className={cn('hf-admin-operations rounded-[28px] border-0 border-t-[8px] bg-[#fffaf3]', mode === 'add' ? 'border-t-[#0e7c86]' : 'border-t-[#d81b72]')}>
          <AlertDialogHeader>
            <AlertDialogTitle>{mode === 'add' ? `Add ${rupees(n)} to ${label}?` : `Deduct ${rupees(n)} from ${label}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Balance now {rupees(balance)}, after this {rupees(balance + (Number.isInteger(signed) ? signed : 0))}. This is recorded in the wallet ledger and the admin audit log with your name and the reason: “{reason.trim()}”. It can't be edited afterwards, only corrected with another entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-11 rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void submit(); }}
              className={cn('min-h-11 rounded-full', mode === 'deduct' ? 'bg-[#d81b72] text-white hover:bg-[#b3135c]' : 'bg-[#0e7c86] text-white hover:bg-[#0a5c63]')}
            >
              {busy ? <Loader2 className="animate-spin" /> : mode === 'add' ? <Plus /> : <Minus />} Confirm {mode === 'add' ? 'add' : 'deduct'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DesiCard>
  );
}
