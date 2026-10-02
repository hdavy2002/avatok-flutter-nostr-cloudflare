/* Wallet — [AUMFE-WALLET-WEB-1 2026-10-02] Dashboard 2 customer wallet (ADMIN-PREVIEW ONLY).
 * 1 token = ₹1 — everything is shown as rupees (never $ or "coin"). Until a payment
 * gateway is approved only previewers (usePreview().preview) see this page; everyone
 * else is sent to /dashboard/billing exactly as before.
 *
 * Worker reads (Bearer via meApi, no Clerk provider here — DashNav owns it):
 *   GET /api/wallet/balance   -> { balance, held, free, bonus, spendable, ... } (tokens)
 *   GET /api/wallet/statement?direction=in|out&limit=&cursor=
 *        -> { entries: [{ id, ts(ms), label, tokens(signed), balance_after?, status, ... }], cursor|null }
 * Telemetry: wallet_page_viewed {balance_tokens}, wallet_statement_filtered {filter}.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Loader2, RefreshCw, WalletCards } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { usePreview } from '../../lib/preview';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Shimmer } from './Shimmer';
import { errMessage, isAbort, istDateTime, meApi } from './accountApi';

interface BalanceResp { balance?: number; spendable?: number; held?: number }
interface Entry {
  id: string;
  ts: number;
  label: string;
  tokens: number; // signed
  balance_after?: number;
  status?: 'completed' | 'pending' | 'refunded';
}
interface StatementResp { entries: Entry[]; cursor: string | null }

type Filter = 'all' | 'in' | 'out';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in', label: 'Added' },
  { key: 'out', label: 'Spent' },
];
const PAGE = 30;

/** Tokens -> "₹1,250" (1 token = ₹1). */
const rupees = (tokens: number) => `₹${Math.abs(Math.round(tokens)).toLocaleString('en-IN')}`;
const signed = (tokens: number) => `${tokens < 0 ? '−' : '+'}${rupees(tokens)}`;

function PreviewRibbon() {
  return (
    <div className="flex justify-start">
      <span className="inline-flex min-h-[32px] items-center rounded-full bg-foreground px-3.5 text-[13px] font-bold text-background">
        Admin preview · hidden from customers
      </span>
    </div>
  );
}

function WalletView() {
  const [balance, setBalance] = useState<number | null>(null);
  const [balErr, setBalErr] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreErr, setMoreErr] = useState('');
  const abort = useRef<AbortController | null>(null);
  const viewed = useRef(false);

  const loadBalance = useCallback(async () => {
    setBalErr('');
    try {
      const r = await meApi<BalanceResp>('/api/wallet/balance');
      const tokens = Number(r.spendable ?? r.balance ?? 0);
      setBalance(tokens);
      if (!viewed.current) { viewed.current = true; capture('wallet_page_viewed', { balance_tokens: tokens }); }
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'dash2_wallet_balance' });
      setBalErr(errMessage(e, 'We could not load your balance.'));
    }
  }, []);

  const loadFirst = useCallback(async (f: Filter) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase('loading');
    setMoreErr('');
    try {
      const r = await meApi<StatementResp>('/api/wallet/statement', {
        query: { limit: PAGE, direction: f === 'all' ? undefined : f }, signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      setEntries(r.entries ?? []);
      setCursor(r.cursor ?? null);
      setPhase('ready');
    } catch (e) {
      if (isAbort(e) || ac.signal.aborted) return;
      captureException(e, { where: 'dash2_wallet_statement' });
      setError(errMessage(e, 'We could not load your wallet activity.'));
      setPhase('error');
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    setMoreErr('');
    try {
      const r = await meApi<StatementResp>('/api/wallet/statement', {
        query: { limit: PAGE, direction: filter === 'all' ? undefined : filter, cursor },
      });
      setEntries((cur) => {
        const seen = new Set(cur.map((x) => x.id));
        return [...cur, ...(r.entries ?? []).filter((x) => !seen.has(x.id))];
      });
      setCursor(r.cursor ?? null);
    } catch (e) {
      if (isAbort(e)) return;
      captureException(e, { where: 'dash2_wallet_more' });
      setMoreErr(errMessage(e));
    } finally {
      setMoreBusy(false);
    }
  }, [cursor, moreBusy, filter]);

  useEffect(() => { void loadBalance(); }, [loadBalance]);
  useEffect(() => { void loadFirst(filter); }, [filter, loadFirst]);
  useEffect(() => () => abort.current?.abort(), []);

  const pick = (f: Filter) => {
    if (f === filter) return;
    capture('wallet_statement_filtered', { filter: f });
    setFilter(f);
  };

  return (
    <div className="space-y-5 font-dashbody">
      <PreviewRibbon />

      {/* Balance */}
      <section className="dash-surface relative overflow-hidden px-5 py-6 sm:px-8 sm:py-8" aria-label="Wallet balance">
        <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-grand-gold via-grand-red/60 to-grand-teal" />
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">Wallet balance</div>
            {balance == null && !balErr ? (
              <Shimmer className="mt-2 h-12 w-40" />
            ) : balErr ? (
              <div className="mt-2 flex items-center gap-3 text-[14px] font-semibold text-primary">
                <AlertCircle className="h-5 w-5" />{balErr}
                <Button size="sm" variant="outline" onClick={() => void loadBalance()}><RefreshCw /> Try again</Button>
              </div>
            ) : (
              <div className="mt-1 font-dash text-[44px] font-bold leading-none tabular-nums text-grand-teal sm:text-[56px]">
                {rupees(balance ?? 0)}
              </div>
            )}
            <p className="mt-2 text-[14px] font-semibold text-muted-foreground">1 token = ₹1</p>
          </div>
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <Button variant="accent" disabled className="min-h-[44px] w-full sm:w-auto">Add money</Button>
            <span className="text-[13px] font-semibold text-muted-foreground">Coming soon</span>
          </div>
        </div>
      </section>

      {/* Filters */}
      <div role="group" aria-label="Filter activity" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => pick(f.key)}
              className={cn(
                'inline-flex min-h-[44px] min-w-[72px] items-center justify-center rounded-full border px-5 text-[15px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on ? 'border-accent bg-accent text-accent-foreground' : 'border-border/70 bg-card text-foreground hover:bg-muted',
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div aria-live="polite" className="sr-only">
        {phase === 'ready' ? `${entries.length}${cursor ? ' or more' : ''} wallet entries` : phase === 'loading' ? 'Loading wallet activity' : ''}
      </div>

      {phase === 'loading' && (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading wallet activity">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="dash-surface flex items-center gap-4 px-4 py-4 sm:px-5">
              <Shimmer className="h-11 w-11 rounded-xl" />
              <div className="flex-1 space-y-2"><Shimmer className="h-4 w-3/5" /><Shimmer className="h-3 w-2/5" /></div>
              <Shimmer className="h-5 w-16" />
            </li>
          ))}
        </ul>
      )}

      {phase === 'error' && (
        <div role="alert" className="dash-surface flex flex-col items-center px-6 py-10 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><AlertCircle className="h-7 w-7" /></span>
          <h2 className="font-dash text-[17px] font-bold text-foreground">We couldn’t load your wallet activity</h2>
          <p className="mt-2 max-w-sm text-[14px] font-semibold text-muted-foreground">{error}</p>
          <Button className="mt-5 min-h-[44px]" variant="outline" onClick={() => void loadFirst(filter)}><RefreshCw /> Try again</Button>
        </div>
      )}

      {phase === 'ready' && entries.length === 0 && (
        <div className="dash-surface flex flex-col items-center px-6 py-12 text-center">
          <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><WalletCards className="h-7 w-7" /></span>
          <h2 className="font-dash text-[18px] font-bold text-grand-teal">No wallet activity yet.</h2>
        </div>
      )}

      {phase === 'ready' && entries.length > 0 && (
        <>
          <ul className="space-y-3">
            {entries.map((e) => {
              const credit = e.tokens > 0;
              return (
                <li key={e.id} className="dash-surface flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5 sm:py-4">
                  <span aria-hidden className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', credit ? 'bg-accent/15 text-accent' : 'bg-secondary text-secondary-foreground')}>
                    {credit ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-dash text-[15px] font-bold leading-snug text-foreground sm:text-[16px]">{e.label}</span>
                    <span className="mt-1 block text-[13px] font-semibold text-muted-foreground">
                      {istDateTime(e.ts)}{e.status === 'pending' ? ' · Pending' : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={cn('font-dash text-[16px] font-bold tabular-nums sm:text-[17px]', credit ? 'text-accent' : 'text-foreground')}>{signed(e.tokens)}</span>
                    {e.balance_after != null && (
                      <span className="text-[13px] font-semibold tabular-nums text-muted-foreground">Balance {rupees(e.balance_after)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {cursor && (
            <div className="flex flex-col items-center gap-2 pt-1">
              {moreErr && <p className="text-[13px] font-semibold text-primary">{moreErr}</p>}
              <Button variant="outline" className="min-h-[44px]" onClick={() => void loadMore()} disabled={moreBusy}>
                {moreBusy ? <Loader2 className="animate-spin" /> : moreErr ? <RefreshCw /> : null}
                {moreBusy ? 'Loading…' : moreErr ? 'Try again' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Wallet() {
  const { loading, preview } = usePreview();
  useEffect(() => {
    // Not a previewer: same behaviour as before this page existed — go to Billing.
    if (!loading && !preview) location.replace(`/dashboard/billing${location.search}`);
  }, [loading, preview]);

  if (loading || !preview) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading">
        <Shimmer className="h-32 w-full rounded-2xl" />
        <Shimmer className="h-16 w-full rounded-2xl" />
      </div>
    );
  }
  return <WalletView />;
}
