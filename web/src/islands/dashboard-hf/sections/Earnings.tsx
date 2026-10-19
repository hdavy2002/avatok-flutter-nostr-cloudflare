/* [HF-DASH-SHELL-2] Host earnings + withdrawals screen (moved off the Overview, where it rendered below the footer).
 * Worker: GET /api/hosts/me/calls (today), GET /api/hf/wallet (host block), WithdrawPanel (/api/hosts/me/payouts). */
import { useCallback, useEffect, useRef, useState } from 'react';
import WithdrawPanel from '../../calls/WithdrawPanel';
import { fetchWallet, hfCall, hostPaise, relDate, type WalletInfo } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { parseCalls, type Today } from '../hostActivity';

export default function Earnings({ account }: { account: DashboardAccount }) {
  const [today, setToday] = useState<Today | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const run = ++generation.current;
    const current = () => run === generation.current;
    setError('');
    try {
      const [calls, w] = await Promise.all([hfCall<unknown>('GET', '/api/hosts/me/calls'), fetchWallet()]);
      if (!current()) return;
      if (calls.ok) setToday(parseCalls(calls.data).today);
      if (w.ok) setWallet(w.data);
      if (!calls.ok || !w.ok) setError('Some of your earnings could not be loaded. Please try again.');
    } catch { if (current()) setError('We could not reach the server. Please try again.'); }
  }, []);
  useEffect(() => { void load(); return () => { ++generation.current; }; }, [load, account.uid]);
  const session = generation.current;
  const hp = wallet?.host ? hostPaise(wallet.host) : null;
  return <div className="hfd-section">
    <header className="hfd-section-head"><h1>Earnings</h1><p>What you earned from calls, what you can withdraw, and your withdrawal requests.</p></header>
    {error && <p className="hfc-err" role="alert">{error} <button type="button" className="hfb-text-button" onClick={() => void load()}>Retry</button></p>}
    <div className="hfd-finances">
      <section className="hfc-card"><h2>Today’s earnings</h2><div className="hfc-stats"><div className="hfc-stat"><strong>{today ? formatPaise(Math.round(today.earned * 100)) : '—'}</strong><span>earned today</span></div><div className="hfc-stat"><strong>{today?.minutes ?? '—'}</strong><span>connected minutes</span></div></div></section>
      {wallet?.host && hp && <section className="hfc-card" aria-labelledby="hfc-earn">
        <h2 id="hfc-earn">Your earnings</h2>
        <p className="hfc-sub" style={{ margin: 0 }}>{wallet.mode === 'rupees' ? 'We keep ₹2 a minute plus 40% of the rate above ₹2. You keep the rest.' : 'Your earnings use the rate agreed for each call.'}</p>
        <div className="hfc-stats">
          <div className="hfc-stat"><strong>{formatPaise(hp.pending)}</strong><span>pending (releases after 7 days)</span></div>
          <div className="hfc-stat"><strong>{formatPaise(hp.available)}</strong><span>available to withdraw</span></div>
          <div className="hfc-stat"><strong>{formatPaise(hp.total)}</strong><span>total earned</span></div>
          {hp.test > 0 && <div className="hfc-stat"><strong>{formatPaise(hp.test)}</strong><span>from test credits, not withdrawable</span></div>}
        </div>
        {(hp.openPayout > 0 || hp.paidOut > 0) && <p className="hfc-sub" style={{ margin: 0 }}>Withdrawals: {formatPaise(hp.openPayout)} in progress · {formatPaise(hp.paidOut)} paid out</p>}
        {wallet.host.payouts && wallet.host.payouts.length > 0 && <ul className="hfc-calls">{wallet.host.payouts.map(p => <li key={p.id}><strong>Withdrawal · {p.status}</strong><span>{formatPaise(p.amountPaise)}</span><small>{relDate(p.paidAt ?? p.createdAt)}</small></li>)}</ul>}
        <p className="hfc-sub" style={{ margin: 0 }}><a href="/dashboard/wallet">See wallet and history</a></p>
      </section>}
      <WithdrawPanel key={`${account.uid}:${session}`} isCurrent={() => session === generation.current} onChanged={() => void load()} />
    </div>
  </div>;
}
