/* [HF-DASH-SHELL-2] Host earnings + withdrawals screen (moved off the Overview, where it rendered below the footer).
 * Worker: GET /api/hosts/me/calls (today), GET /api/hf/wallet (host block), the shared Withdraw card (/api/hf/payouts, same as Wallet and the app). */
import { useCallback, useEffect, useRef, useState } from 'react';
import Withdraw from '../../wallet/Withdraw'; // [HF-WITHDRAW-1] same Withdraw card as the Wallet page
import PayoutDetails, { PAYOUT_DETAILS_ID } from '../../wallet/PayoutDetails'; // [HF-PAYOUT-CARD]
import { fetchWallet, hfCall, hostPaise, relDate, type WalletInfo } from '../../../lib/hfCallsApi';
import { formatPaise } from '../../../lib/money';
import type { DashboardAccount } from '../../../components/account/DashboardNav';
import { parseCalls, type Today } from '../hostActivity';
import { getSummary, merchEnabled, type Summary } from '../merch/api'; // [HF-MERCH-QA-1] merch royalty card

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
      <MerchRoyalty uid={account.uid} />
      <section className="hfc-card" id="withdraw" aria-labelledby="hfc-wd"><h2 id="hfc-wd">Withdraw</h2><Withdraw key={account.uid} where="earnings" skin="hfc" next="/dashboard/host/earnings" onChanged={() => void load()} detailsHref={`#${PAYOUT_DETAILS_ID}`} /></section>
      {/* [HF-PAYOUT-CARD] Add / change the UPI ID, name check and ID check. Replaces /hosts/onboarding?step=payout. */}
      <section className="hfc-card" id={PAYOUT_DETAILS_ID} aria-labelledby="hfc-pd"><h2 id="hfc-pd">Payout details</h2><PayoutDetails key={account.uid} where="earnings" skin="hfc" next="/dashboard/host/earnings" /></section>
    </div>
  </div>;
}

/** [HF-MERCH-QA-1] Design royalty from merch sales, from the same summary the Merch screen uses. Hidden when merch is off or the numbers cannot be loaded. */
function MerchRoyalty({ uid }: { uid: string }) {
  const [earn, setEarn] = useState<Summary['earnings'] | null>(null);
  useEffect(() => {
    let live = true;
    setEarn(null);
    void (async () => {
      try {
        if (!(await merchEnabled())) return;
        const r = await getSummary();
        if (live && r.ok && r.data?.earnings) setEarn(r.data.earnings);
      } catch { /* hidden on failure */ }
    })();
    return () => { live = false; };
  }, [uid]);
  if (!earn) return null;
  return <section className="hfc-card" aria-labelledby="hfc-merch">
    <h2 id="hfc-merch">Merch design royalty</h2>
    <p className="hfc-sub" style={{ margin: 0 }}>What you earn when fans buy your merch. It is on hold until the order is delivered and the hold time ends.</p>
    <div className="hfc-stats">
      <div className="hfc-stat"><strong>{formatPaise(earn.pendingPaise)}</strong><span>on hold</span></div>
      <div className="hfc-stat"><strong>{formatPaise(earn.availablePaise)}</strong><span>ready to withdraw</span></div>
    </div>
    <p className="hfc-sub" style={{ margin: 0 }}><a href="/dashboard/merch">Go to my merch</a></p>
  </section>;
}
