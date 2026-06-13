/* PayoutPanel — earnings + bank accounts + payout history. The user initiates
 * a withdrawal themselves (button); bank-account setup happens in the app (it
 * collects sensitive bank details). APIs:
 *   GET /api/wallet/earnings   → { held, released_total, upcoming }
 *   GET /api/payout/accounts   → { accounts: [...] }
 *   GET /api/payout/status     → { requests: [...] } | [...]
 */
import { useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

const usd = (c?: number) => `$${((c ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const dt = (ms?: number) => (ms ? new Date(ms).toLocaleDateString() : '');

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [earn, setEarn] = useState<{ released_total?: number; held?: number; upcoming?: number } | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) return;
    void (async () => {
      try { setEarn(await request('/api/wallet/earnings', { auth: token })); } catch { setEarn({}); }
      try { const r = await request<any>('/api/payout/accounts', { auth: token }); setAccounts(Array.isArray(r) ? r : r.accounts ?? []); } catch { /* */ }
      try { const r = await request<any>('/api/payout/status', { auth: token }); setHistory(Array.isArray(r) ? r : r.requests ?? []); } catch { /* */ }
    })();
  }, [token, checked]);

  if (!checked || (token && earn === null)) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1 rounded-zine border-zine border-ink bg-lime p-5 shadow-zine-sm">
          <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Available</span>
          <span className="font-display font-semibold text-[30px] leading-none text-ink">{usd(earn?.released_total)}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
          <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Held (clearing)</span>
          <span className="font-display font-semibold text-[30px] leading-none text-ink">{usd(earn?.held)}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
          <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Upcoming (7d)</span>
          <span className="font-display font-semibold text-[30px] leading-none text-ink">{usd(earn?.upcoming)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-zine border-zine border-ink bg-paper2 p-4 shadow-zine-sm">
        <div className="min-w-0">
          <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Bank account</span>
          <div className="font-display font-semibold text-[16px] text-ink">{accounts.length ? `•••• ${accounts[0]?.last4 ?? accounts[0]?.account_last4 ?? ''} · ${accounts[0]?.status ?? 'linked'}` : 'No bank linked yet'}</div>
        </div>
        {accounts.length === 0
          ? <span className="ml-auto rounded-full border-zine border-ink bg-card px-3 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-inkMute">Add bank in the app</span>
          : <span className="ml-auto rounded-full border-zine border-ink bg-lime px-3 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.04em] text-ink shadow-zine-xs">Ready</span>}
      </div>

      <div>
        <h2 className="mb-3 font-display font-semibold text-[18px] text-ink">Payout history</h2>
        {history.length === 0 ? (
          <div className="rounded-zine border-zine border-ink bg-paper2 p-6 font-body font-bold text-[14px] text-inkSoft shadow-zine-sm">No payouts yet. Minimum withdrawal is $10.</div>
        ) : (
          <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm">
            {history.map((h, i) => (
              <div key={h.id ?? i} className={`flex items-center gap-3 p-3 ${i ? 'border-t-zine border-ink' : ''}`}>
                <span className="font-display font-semibold text-[14px] text-ink">{usd(h.amount_coins ?? h.amount)}</span>
                <span className="rounded-full border-zine border-ink bg-paper px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-inkSoft">{h.status ?? '—'}</span>
                <span className="ml-auto font-mono text-[12px] text-inkMute">{dt(h.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function PayoutPanel() { return <Inner />; }
export default PayoutPanel;
