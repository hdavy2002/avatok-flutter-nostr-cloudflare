/* [HF-WALLET-1] /wallet: Paid balance (real money) and Test credits (spend-only, never withdrawable), plus recent history.
 * Worker: GET /api/hf/wallet. [HF-TOPUP-1] TopupPanel (add money) mounts below the balance. */
import { useEffect, useState } from 'react';
import TokensPanel from './TokensPanel'; // [HF-APP-3] replaces TopupPanel (kept in the repo, dark behind its flags)
import RefundPanel from './RefundPanel'; // [HF-WALLET-EXIT-1]
import ReceiptsPanel from './ReceiptsPanel'; // [HF-WALLET-LIMITS-1]
import SessionBridge from '../calls/SessionBridge';
import { isAppMode } from '../../lib/nativeBridge';
import { fetchWallet, inr, looksSignedOut, relDate, signInUrl, type WalletInfo } from '../../lib/hfCallsApi';
import '../../styles/hf-calls.css';

const signed = (n: number): string => `${n < 0 ? '-' : '+'}${inr(Math.abs(n))}`;

export default function HfWallet() {
  const [phase, setPhase] = useState<'boot' | 'signedout' | 'error' | 'ready'>('boot');
  const [w, setW] = useState<WalletInfo | null>(null);
  const [rcptKey] = useState(0); // [HF-WALLET-LIMITS-1] reload key for receipts (was bumped by the web top-up, now unused: [HF-APP-3])

  useEffect(() => {
    if (looksSignedOut()) { setPhase('signedout'); return; }
    let live = true;
    (async () => {
      const r = await fetchWallet();
      if (!live) return;
      if (r.ok) { setW(r.data); setPhase('ready'); }
      else setPhase(r.status === 401 ? 'signedout' : 'error');
    })();
    return () => { live = false; };
  }, []);

  // [HF-APP-3] App mode only: remember whether this person is a host (the tab bar then shows Host instead of Calls)
  // and scroll to a #hash section such as the Calls tab's #hfw-hist once the page has rendered.
  useEffect(() => {
    if (phase !== 'ready' || !isAppMode()) return;
    try {
      if (w?.host) localStorage.setItem('hf_is_host', '1'); else localStorage.removeItem('hf_is_host');
      document.documentElement.classList.toggle('hf-host', !!w?.host);
    } catch { /* storage blocked: tab bar keeps Calls */ }
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [phase, w]);

  if (phase === 'boot') return <main className="hfc-page"><p role="status">Loading your wallet…</p></main>;
  if (phase === 'signedout') {
    return <main className="hfc-page"><h1>Wallet</h1><p>Please sign in to see your wallet.</p><a className="hfc-btn hfc-primary" href={signInUrl('/wallet')}>Sign in</a></main>;
  }
  if (phase === 'error' || !w) {
    return <main className="hfc-page"><h1>Wallet</h1><p>We could not load your wallet. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></main>;
  }

  return (
    <main className="hfc-page">
      <SessionBridge on />
      <h1>Wallet</h1>
      <section className="hfc-card" aria-labelledby="hfw-bal">
        <h2 id="hfw-bal">Balance</h2>
        <div className="hfc-stats">
          <div className="hfc-stat"><strong>{inr(w.paidBalance)}</strong><span>Paid balance</span></div>
          <div className="hfc-stat"><strong>{inr(w.testBalance)}</strong><span>Test credits: spend only, can’t be withdrawn</span></div>
        </div>
        <p className="hfc-sub" style={{ margin: 0 }}>You can spend {inr(w.spendable)} on calls. Test credits are used first.</p>
        {w.limits && (
          <p className="hfc-sub" style={{ margin: 0 }}>
            Today: {inr(w.limits.spentToday)} of {inr(w.limits.daily)} used · This month: {inr(w.limits.spentThisMonth)} of {inr(w.limits.monthly)} used. Limits count real money only, and today’s resets at midnight.
          </p>
        )}
      </section>

      <TokensPanel />
      <ReceiptsPanel reloadKey={rcptKey} />

      <RefundPanel onChanged={() => { fetchWallet().then(r => { if (r.ok) setW(r.data); }); }} />

      {w.host && (
        <section className="hfc-card" aria-labelledby="hfw-earn">
          <h2 id="hfw-earn">Host earnings</h2>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{inr(w.host.heldRupees)}</strong><span>held (releases after 7 days)</span></div>
            <div className="hfc-stat"><strong>{inr(w.host.availableRupees)}</strong><span>available</span></div>
            <div className="hfc-stat"><strong>{inr(w.host.testEarningsRupees)}</strong><span>from test credits, not withdrawable</span></div>
          </div>
          <p className="hfc-sub" style={{ margin: 0 }}>Lifetime paid earnings: {inr(w.host.lifetimePaidEarnings)}</p>
        </section>
      )}

      <section className="hfc-card" aria-labelledby="hfw-hist">
        <h2 id="hfw-hist">History</h2>
        {w.history.length === 0 ? <p>Nothing here yet. Calls and credits will show up here.</p> : (
          <ul className="hfc-calls">
            {w.history.map((h, i) => (
              <li key={`${h.at}-${h.callId ?? i}`}><strong>{h.label}</strong><span>{signed(h.rupees)}</span><small>{relDate(h.at)}</small></li>
            ))}
          </ul>
        )}
      </section>
      <p className="hfc-sub"><a href="/account/close">Close my account</a></p>
    </main>
  );
}
