/* WalletPanel — AvaCoins balance + ledger (app: Wallet).
 *   • GET /api/wallet/balance       → { balance }
 *   • GET /api/wallet/transactions  → { transactions: Tx[] }
 *   • POST /api/wallet/topup        → Stripe checkout url (we redirect)
 * All MASTER §4 endpoints. Read-only display + a top-up redirect.
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import type { WalletBalance } from '../checkout/types';

interface Tx {
  id?: string;
  amount?: number;
  kind?: string;
  type?: string;
  reason?: string | null;
  created_at?: number;
  ts?: number;
}

function fmtWhen(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms < 1e12 ? ms * 1000 : ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        const r = await request<{ transactions: Tx[] }>('/api/wallet/transactions', { auth: token });
        setTxs(r.transactions ?? []);
      } catch {
        setTxs([]);
      }
    })();
  }, [token]);

  async function topUp() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await request<{ url?: string; checkout_url?: string }>('/api/wallet/topup', {
        method: 'POST',
        auth: token,
        body: { amount: 1000 },
      });
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
            <span className="font-mono font-bold uppercase text-[12px] tracking-[0.08em] text-ink">Balance</span>
            <div className="font-mono font-bold text-[26px] text-ink">
              {balance != null ? `${balance.toLocaleString()}` : '—'}{' '}
              <span className="text-[14px]">AvaCoins</span>
            </div>
          </div>
          <Button variant="lime" label="Top up" loading={busy} onClick={topUp} />
        </div>
      </Card>

      {error && <p className="font-body font-bold text-[14px] text-coral">⚠ {error}</p>}

      <section>
        <h2 className="mb-3 font-display font-semibold text-[20px] text-ink">Recent activity</h2>
        {!txs ? (
          <div className="flex items-center gap-3 p-4"><Spinner size={20} /></div>
        ) : txs.length ? (
          <div className="flex flex-col gap-2">
            {txs.slice(0, 30).map((t, i) => {
              const amt = Number(t.amount ?? 0);
              const pos = amt >= 0;
              return (
                <div key={t.id ?? i} className="flex items-center justify-between rounded-zineField border-zine border-ink bg-card px-4 py-3 shadow-zine-xs">
                  <div className="min-w-0">
                    <div className="truncate font-body font-extrabold text-[14px] text-ink">{t.reason || t.kind || t.type || 'Transaction'}</div>
                    <div className="font-mono text-[11px] text-inkMute">{fmtWhen(t.created_at ?? t.ts)}</div>
                  </div>
                  <span className={`font-mono font-bold text-[15px] ${pos ? 'text-mintInk' : 'text-coral'}`}>
                    {pos ? '+' : ''}{amt.toLocaleString()}
                  </span>
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
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default WalletPanel;
