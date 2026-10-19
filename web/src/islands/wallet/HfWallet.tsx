/* [HF-WALLET-1] /wallet: Paid balance (real money) and Test credits (spend-only, never withdrawable), plus recent history.
 * Worker: GET /api/hf/wallet. [HF-TOPUP-1] TopupPanel (add money) mounts below the balance. */
import { PageShell, useEmbedded, useIntoDashboard } from '../../components/account/dashboardEmbed';
import { useEffect, useState } from 'react';
import TokensPanel from './TokensPanel'; // [HF-APP-3] replaces TopupPanel (kept in the repo, dark behind its flags)
import TopupPanel from './TopupPanel'; // [HF-CASHFREE-TOPUP-1] website top-up through Cashfree, when live
import { fetchTopupConfig } from '../../lib/hfTopupApi';
import RefundPanel from './RefundPanel'; // [HF-WALLET-EXIT-1]
import ReceiptsPanel from './ReceiptsPanel'; // [HF-WALLET-LIMITS-1]
import SessionBridge from '../calls/SessionBridge';
import { isAppMode } from '../../lib/nativeBridge';
import { fetchWallet, hostPaise, inr, inr2, looksSignedOut, relDate, signInUrl, type WalletInfo } from '../../lib/hfCallsApi';
import { formatPaise, topupKeptLabel } from '../../lib/money';
import RateCard from '../calls/RateCard';
import '../../styles/hf-calls.css';

const signed = (n: number): string => `${n < 0 ? '-' : '+'}${inr(Math.abs(n))}`;

export default function HfWallet() {
  const [phase, setPhase] = useState<'boot' | 'signedout' | 'error' | 'ready'>('boot');
  const [w, setW] = useState<WalletInfo | null>(null);
  const embedded = useEmbedded();
  useIntoDashboard(typeof location !== 'undefined' && location.hash === '#hfw-hist' ? '/dashboard/calls#' : '/dashboard/wallet');
  const [rcptKey, setRcptKey] = useState(0); // [HF-WALLET-LIMITS-1] reload key for receipts, bumped after a web top-up
  // [HF-CASHFREE-TOPUP-1] On the plain website, a live gateway (hfTopup.enabled) shows the Add money card; inside the Android app the
  // Google Play panel stays (Play policy: in-app digital top-ups go through Play Billing).
  const [webTopup, setWebTopup] = useState(false);
  useEffect(() => { if (!isAppMode()) fetchTopupConfig().then(c => setWebTopup(c.enabled)).catch(() => undefined); }, []);

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

  if (phase === 'boot') return <PageShell className="hfc-page"><p role="status">Loading your wallet…</p></PageShell>;
  if (phase === 'signedout') {
    return <PageShell className="hfc-page"><h1>Wallet</h1><p>Please sign in to see your wallet.</p><a className="hfc-btn hfc-primary" href={signInUrl('/dashboard/wallet')}>Sign in</a></PageShell>;
  }
  if (phase === 'error' || !w) {
    return <PageShell className="hfc-page"><h1>Wallet</h1><p>We could not load your wallet. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></PageShell>;
  }

  const rupees = w.mode === 'rupees' && !!w.wallet; // [HF-STD-PLAN-1] plain rupees, no tokens
  const tokenMode = w.mode === 'tokens';
  const hm = tokenMode ? inr2 : inr; // hosts see rupees; token mode shows the paise too (Rs 10.80 a minute)
  const hp = w.host ? hostPaise(w.host) : null;
  const spentIds = new Set(w.history.filter(h => h.kind === 'call_spent' && h.callId).map(h => h.callId));
  return (
    <PageShell className="hfc-page">
      <SessionBridge on={!embedded} />
      <h1>Wallet</h1>
      <section className="hfc-card" aria-labelledby="hfw-bal">
        <h2 id="hfw-bal">Balance</h2>
        {rupees && w.wallet ? (
          <>
            <div className="hfc-stats">
              <div className="hfc-stat"><strong>{formatPaise(w.wallet.availablePaise)}</strong><span>available to spend</span></div>
              {w.wallet.reservedPaise > 0 && <div className="hfc-stat"><strong>{formatPaise(w.wallet.reservedPaise)}</strong><span>reserved during your call</span></div>}
              {w.wallet.testPaise > 0 && <div className="hfc-stat"><strong>{formatPaise(w.wallet.testPaise)}</strong><span>Test credits (can’t be withdrawn)</span></div>}
            </div>
            {w.wallet.debtOpen && (
              <p className="hfc-note hfc-warn" role="status">
                You owe {formatPaise(w.wallet.debtPaise)} after a refund. It is cleared from the next money you add. Please clear the amount owed before calling.
              </p>
            )}
          </>
        ) : tokenMode && w.tokens ? (
          <>
            <div className="hfc-stats">
              <div className="hfc-stat"><strong>₹{w.tokens.balance}</strong><span>in your wallet</span></div>
            </div>
            {Number(w.tokens.testTokens) > 0 && <p className="hfc-sub" style={{ margin: 0 }}>₹{w.tokens.testTokens} of this is test credit: spend only, can’t be withdrawn.</p>}
            {w.tokens.debt.open && (
              <p className="hfc-note hfc-warn" role="status">
                You owe {inr2(w.tokens.debt.valuePaise / 100)} after a refund. It is cleared from the next money you add. Please clear the amount owed before calling.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="hfc-stats">
              <div className="hfc-stat"><strong>{inr(w.paidBalance)}</strong><span>Paid balance</span></div>
              <div className="hfc-stat"><strong>{inr(w.testBalance)}</strong><span>Test credits: spend only, can’t be withdrawn</span></div>
            </div>
            <p className="hfc-sub" style={{ margin: 0 }}>You can spend {inr(w.spendable)} on calls. Test credits are used first.</p>
          </>
        )}
      </section>

      {rupees && <RateCard surface="wallet" tiers={w.plan?.tiers} />}
      {webTopup ? <TopupPanel onPaid={() => { fetchWallet().then(r => { if (r.ok) setW(r.data); }); setRcptKey(k => k + 1); }} /> : <TokensPanel />}
      <ReceiptsPanel reloadKey={rcptKey} />

      <RefundPanel onChanged={() => { fetchWallet().then(r => { if (r.ok) setW(r.data); }); }} />

      {w.host && rupees && hp && (
        <section className="hfc-card" aria-labelledby="hfw-earn">
          <h2 id="hfw-earn">Influencer earnings</h2>
          <p className="hfc-sub" style={{ margin: 0 }}>We keep ₹2 a minute plus 40% of the rate above ₹2. You keep the rest.</p>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{formatPaise(hp.pending)}</strong><span>pending (releases after 7 days)</span></div>
            <div className="hfc-stat"><strong>{formatPaise(hp.available)}</strong><span>available to withdraw</span></div>
            <div className="hfc-stat"><strong>{formatPaise(hp.total)}</strong><span>total earned</span></div>
            {hp.test > 0 && <div className="hfc-stat"><strong>{formatPaise(hp.test)}</strong><span>from test credits, not withdrawable</span></div>}
          </div>
          {(hp.openPayout > 0 || hp.paidOut > 0) && <p className="hfc-sub" style={{ margin: 0 }}>Withdrawals: {formatPaise(hp.openPayout)} in progress · {formatPaise(hp.paidOut)} paid out</p>}
          {w.host.perCall && w.host.perCall.length > 0 && (
            <ul className="hfc-calls">
              {w.host.perCall.map(p => (
                <li key={p.callId}><strong>Call earnings{p.testPaise > 0 ? ' (includes test credits, not withdrawable)' : ''}</strong><span>{formatPaise(p.earnedPaise)}</span><small>{relDate(p.at)}</small></li>
              ))}
            </ul>
          )}
          {w.host.payouts && w.host.payouts.length > 0 && (
            <ul className="hfc-calls">
              {w.host.payouts.map(p => (
                <li key={p.id}><strong>Withdrawal · {p.status}</strong><span>{formatPaise(p.amountPaise)}</span><small>{relDate(p.paidAt ?? p.createdAt)}</small></li>
              ))}
            </ul>
          )}
        </section>
      )}
      {w.host && !rupees && (
        <section className="hfc-card" aria-labelledby="hfw-earn">
          <h2 id="hfw-earn">Influencer earnings</h2>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{hm(w.host.heldRupees ?? 0)}</strong><span>held (releases after 7 days)</span></div>
            <div className="hfc-stat"><strong>{hm(w.host.availableRupees ?? 0)}</strong><span>available</span></div>
            <div className="hfc-stat"><strong>{hm(w.host.testEarningsRupees ?? 0)}</strong><span>from test credits, not withdrawable</span></div>
          </div>
          <p className="hfc-sub" style={{ margin: 0 }}>Lifetime paid earnings: {hm(w.host.lifetimePaidEarnings ?? 0)}</p>
          {tokenMode && w.host.perCall && w.host.perCall.length > 0 && (
            <ul className="hfc-calls">
              {w.host.perCall.map(p => (
                <li key={p.callId}><strong>Call earnings{p.testPaise > 0 ? ' (includes test credits, not withdrawable)' : ''}</strong><span>{inr2(p.earnedPaise / 100)}</span><small>{relDate(p.at)}</small></li>
              ))}
            </ul>
          )}
          {tokenMode && w.host.payouts && w.host.payouts.length > 0 && (
            <ul className="hfc-calls">
              {w.host.payouts.map(p => (
                <li key={p.id}><strong>Withdrawal · {p.status}</strong><span>{inr2(p.amountPaise / 100)}</span><small>{relDate(p.paidAt ?? p.createdAt)}</small></li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="hfc-card" aria-labelledby="hfw-hist">
        <h2 id="hfw-hist">History</h2>
        {w.history.length === 0 ? <p>Nothing here yet. Calls and credits will show up here.</p> : (
          <ul className="hfc-calls">
            {w.history.map((h, i) => rupees && h.amountPaise !== undefined ? (
              <li key={`${h.at}-${h.callId ?? i}`} id={h.kind === 'call_spent' && h.callId ? `hfw-call-${h.callId}` : undefined}>
                <strong>{h.kind === 'call_refund' ? 'Call charge corrected' : h.label}</strong>
                <span>{h.amount ?? formatPaise(h.amountPaise)}</span>
                <small>
                  {relDate(h.at)}
                  {h.purchase && <> · Paid {formatPaise(h.purchase.paidPaise)} · {topupKeptLabel(h.purchase.paidPaise, h.purchase.gstPaise, h.purchase.walletPaise)} · Added {formatPaise(h.purchase.walletPaise)}</>}
                  {h.kind === 'call_refund' && h.callId && (spentIds.has(h.callId) ? <> · <a href={`#hfw-call-${h.callId}`}>See the call</a></> : <> · {h.label}</>)}
                </small>
              </li>
            ) : (
              <li key={`${h.at}-${h.callId ?? i}`}><strong>{h.label}</strong><span>{h.tokens !== undefined ? h.tokens : signed(h.rupees ?? 0)}</span><small>{relDate(h.at)}</small></li>
            ))}
          </ul>
        )}
      </section>
      {!embedded && <p className="hfc-sub"><a href="/account/close">Close my account</a></p>}
    </PageShell>
  );
}
