/* WalletPanel — Tokens balance + ledger (app: Wallet).
 *   • GET /api/wallet/balance       → { balance }
 *   • GET /api/wallet/statement     → { entries } — human-labelled rows
 *   • GET /api/wallet/activity?id=  → { activity } — the tap-to-expand detail
 *   • POST /api/wallet/topup        → Stripe checkout url (we redirect)
 * All MASTER §4 endpoints. Read-only display + a top-up redirect.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { isReviewerMode } from '../../lib/reviewer';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import type { WalletBalance } from '../checkout/types';
import { capture, withTrace } from '../../lib/analytics';

/**
 * [UI-MOTION-1 2026-09-10] "number-pop-in" (transitions.dev, `.t-*` classes
 * in src/styles/motion.css) on the Tokens balance — replays whenever the
 * balance actually changes (not on every render while it holds steady).
 * `tabular-nums` + `data-tabular` opt this figure OUT of the dashboard's
 * all-Comfortaa scope (Dashboard.astro): Comfortaa has no tabular figures,
 * so a balance column set in it would visibly jitter as digits update.
 */
function AnimatedBalance({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current !== null && prev.current !== text) {
      const el = ref.current;
      if (el) {
        el.classList.remove('is-animating');
        void el.offsetWidth; // force reflow so the animation can replay
        el.classList.add('is-animating');
      }
    }
    prev.current = text;
  }, [text]);
  const chars = text.split('');
  return (
    <span ref={ref} className="t-digit-group tabular-nums" data-tabular>
      {chars.map((ch, i) => (
        <span
          key={i}
          className="t-digit"
          data-stagger={i === chars.length - 2 ? '1' : i === chars.length - 1 ? '2' : undefined}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

interface Tx {
  id?: string;
  /** Signed tokens (+in / -out). */
  tokens?: number;
  amount?: number;
  type?: string;
  direction?: string;
  label?: string;
  type_label?: string;
  status?: string;
  ts?: number;
  created_at?: number;
}

/** [WALLET-ACTIVITY-DETAIL-1] The server's full story for one row. */
interface Activity {
  id: string;
  ts: number;
  tokens: number;
  type: string;
  status: string;
  balance_after: number | null;
  activity: string;
  title: string;
  reason: string | null;
  listing: { id: string; title: string | null; kind: string | null; url: string | null; starts_at: number | null; timezone: string | null } | null;
  counterparty: { role: 'creator' | 'buyer'; name: string | null; handle: string | null; url: string | null } | null;
  order_id: string | null;
  reference: string | null;
  refunded_to: string | null;
}

function fmtWhen(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms < 1e12 ? ms * 1000 : ms);
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
}

/** "11 Sept 2026, 7:50 AM IST" — India is the only market, so IST, not the browser's zone. */
function fmtFull(ms?: number | null, timeZone?: string | null): string {
  if (!ms) return '';
  const d = new Date(ms < 1e12 ? ms * 1000 : ms);
  const zone = timeZone || 'Asia/Kolkata';
  const text = d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone });
  return `${text} ${zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta' ? 'IST' : zone}`;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-inkMute/30 py-2 first:border-t-0">
      <span className="shrink-0 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-inkMute">{label}</span>
      <span className="min-w-0 text-right font-body font-bold text-[14px] text-ink break-words">{children}</span>
    </div>
  );
}

/** The slide-out under a row. Fetched on first open, then kept. */
function ActivityDetail({ row, detail, failed }: { row: Tx; detail: Activity | null; failed: boolean }) {
  if (!detail && !failed) {
    return <div className="flex items-center gap-2 px-4 py-3"><Spinner size={16} /><span className="font-body font-bold text-[13px] text-inkSoft">Loading details…</span></div>;
  }
  const tokens = Number(detail?.tokens ?? row.tokens ?? row.amount ?? 0);
  return (
    <div className="px-4 pb-3 pt-1">
      {detail?.reason && <p className="mb-2 font-body font-bold text-[14px] text-inkSoft">{detail.reason}</p>}
      <DetailRow label="Activity">{detail?.activity ?? row.type_label ?? row.label ?? row.type}</DetailRow>
      {detail?.listing && (
        <DetailRow label={detail.listing.kind === 'live_event' ? 'Show' : 'Listing'}>
          {detail.listing.url ? <a className="underline" href={detail.listing.url}>{detail.listing.title ?? 'View listing'}</a> : (detail.listing.title ?? '—')}
        </DetailRow>
      )}
      {detail?.listing?.starts_at && <DetailRow label="Scheduled for">{fmtFull(detail.listing.starts_at, detail.listing.timezone)}</DetailRow>}
      {detail?.counterparty?.name && (
        <DetailRow label={detail.counterparty.role === 'creator' ? 'Creator' : 'Buyer'}>
          {detail.counterparty.url ? <a className="underline" href={detail.counterparty.url}>{detail.counterparty.name}</a> : detail.counterparty.name}
          {detail.counterparty.handle ? <span className="text-inkMute"> @{detail.counterparty.handle}</span> : null}
        </DetailRow>
      )}
      <DetailRow label="Date & time">{fmtFull(detail?.ts ?? row.ts ?? row.created_at)}</DetailRow>
      <DetailRow label="Amount">{tokens >= 0 ? '+' : ''}{tokens.toLocaleString()} tokens (₹{Math.abs(tokens).toLocaleString('en-IN')})</DetailRow>
      {detail?.refunded_to && <DetailRow label="Refunded to">{detail.refunded_to}</DetailRow>}
      {detail?.status && <DetailRow label="Status">{detail.status[0].toUpperCase() + detail.status.slice(1)}</DetailRow>}
      {detail?.balance_after != null && <DetailRow label="Balance after">{detail.balance_after.toLocaleString()} tokens</DetailRow>}
      {(detail?.order_id || detail?.reference) && <DetailRow label="Reference"><span className="font-mono text-[12px]">{detail?.order_id ?? detail?.reference}</span></DetailRow>}
      {failed && <p className="pt-2 font-body font-bold text-[13px] text-coral">Couldn’t load the full details. Try again in a moment.</p>}
    </div>
  );
}

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  // [WALLET-ACTIVITY-DETAIL-1] One row open at a time; details cached per id.
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Activity | 'failed'>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewer, setReviewer] = useState(false);
  useEffect(() => { setReviewer(isReviewerMode()); }, []);
  useEffect(() => { capture('wallet_view', {}); }, []);

  useEffect(() => {
    void (async () => {
      setToken(await getActiveToken());
      setChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const r = await request<WalletBalance>('/api/wallet/balance', { auth: token });
        setBalance(Math.trunc(Number(r.balance ?? 0)));
      } catch {
        setBalance(null);
      }
    })();
    void (async () => {
      try {
        const r = await request<{ entries: Tx[] }>('/api/wallet/statement', { auth: token, query: { limit: 50 } });
        setTxs(r.entries ?? []);
      } catch {
        setTxs([]);
      }
    })();
  }, [token]);

  async function toggle(row: Tx) {
    const id = row.id;
    if (!id) return;
    const opening = openId !== id;
    setOpenId(opening ? id : null);
    if (!opening || details[id]) return;
    capture('wallet_activity_opened', { type: row.type ?? null, direction: row.direction ?? null });
    try {
      const r = await request<{ activity: Activity }>('/api/wallet/activity', { auth: token, query: { id } });
      setDetails((d) => ({ ...d, [id]: r.activity }));
    } catch {
      setDetails((d) => ({ ...d, [id]: 'failed' }));
    }
  }

  async function topUp() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await withTrace(() => request<{ url?: string; checkout_url?: string }>('/api/wallet/topup', {
        method: 'POST',
        auth: token,
        body: { amount: 1000 },
      }));
      const url = r.url || r.checkout_url;
      if (url) location.href = url;
      else setError('Top-up is not available right now.');
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not start top-up.');
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return <div className="flex items-center gap-3 p-6"><Spinner size={22} /></div>;

  return (
    <div className="flex flex-col gap-5">
      <Card fillClassName="bg-mint" shadow="sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono font-bold uppercase text-[14px] tracking-[0.08em] text-ink">Balance</span>
            <div className="font-mono font-bold text-[26px] text-ink">
              <AnimatedBalance text={balance != null ? balance.toLocaleString() : '—'} />{' '}
              <span className="text-[14px]">Tokens</span>
            </div>
          </div>
          {/* [REVIEWER-ONBOARD-1] Reviewer accounts are browse-only: no money
              affordance. Server-side, money-in is off for EVERYONE right now
              (billingEnabled=false, Stripe test keys) — this only removes the
              button, it is not the guarantee. */}
          {!reviewer && <Button variant="lime" label="Top up" loading={busy} onClick={topUp} />}
        </div>
      </Card>

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      <section>
        <h2 className="mb-3 font-display font-semibold text-[20px] text-ink">Recent activity</h2>
        {!txs ? (
          <div className="flex items-center gap-3 p-4"><Spinner size={20} /></div>
        ) : txs.length ? (
          <div className="flex flex-col gap-2">
            {txs.slice(0, 50).map((t, i) => {
              const amt = Number(t.tokens ?? t.amount ?? 0);
              const pos = amt >= 0;
              const id = t.id ?? String(i);
              const open = openId === id;
              const cached = details[id];
              return (
                <div key={id} className="overflow-hidden rounded-zineField border-zine border-ink bg-card shadow-zine-xs">
                  <button
                    type="button"
                    onClick={() => toggle(t)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-body font-extrabold text-[14px] text-ink">{t.label || t.type_label || t.type || 'Transaction'}</div>
                      <div className="font-mono text-[13px] text-inkMute font-bold">{fmtWhen(t.ts ?? t.created_at)}</div>
                    </div>
                    <span className="flex items-center gap-2">
                      <span className={`font-mono font-bold text-[15px] ${pos ? 'text-mintInk' : 'text-coral'}`}>
                        {pos ? '+' : ''}{amt.toLocaleString()}
                      </span>
                      <span aria-hidden="true" className={`inline-block font-mono text-[13px] text-inkMute transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
                    </span>
                  </button>
                  {/* Slide-out: grid-rows 0fr→1fr animates height without measuring. */}
                  <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="min-h-0 overflow-hidden">
                      {open && (
                        <div className="border-t-zine border-ink bg-paper">
                          <ActivityDetail row={t} detail={cached && cached !== 'failed' ? cached : null} failed={cached === 'failed'} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Card fillClassName="bg-paper2">
            <p className="font-body font-bold text-[15px] text-inkSoft">No transactions yet.</p>
          </Card>
        )}
      </section>
    </div>
  );
}

export function WalletPanel() {
  return (
    
      <Inner />
    
  );
}

export default WalletPanel;
