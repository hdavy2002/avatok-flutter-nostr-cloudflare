/* [HF-WALLET-EXIT-1] /account/close: pay-out-first account closure. [HF-WIRE-16] Wallet money is withdrawn to UPI via the Withdraw button BEFORE closing (never refunded
 * to a card); a leftover below the smallest withdrawal can be given up. Shows what happens to the user's money, starts the exit
 * (final host withdrawal), tracks progress, and closes the account once everything is settled.
 * Worker: GET/POST/DELETE /api/hf/account/exit, POST /api/account/delete (no-money case). Rulebook HF-PAY-14. */
import { PageShell, useEmbedded, useIntoDashboard } from '../../components/account/dashboardEmbed';
import { useEffect, useState } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';
import UpiSetup from './UpiSetup'; // [HF-CLOSE-UPI-1]
import { fetchExit, startExit, cancelExit, deleteAccountNow, walletExitMessage, walletExitCode, PAYOUT_HREF, ApiError, type ExitInfo } from '../../lib/hfWalletExitApi';

const dateIN = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const PAY: Record<string, string> = { requested: 'Waiting for approval', approved: 'Approved, being paid', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled' };
const REF: Record<string, string> = { requested: 'Waiting for approval', processing: 'Being sent back', refunded: 'Sent back', rejected: 'Not processed', cancelled: 'Cancelled' };

export default function AccountClose() {
  const embedded = useEmbedded();
  useIntoDashboard('/dashboard/close');
  const [phase, setPhase] = useState<'boot' | 'signedout' | 'error' | 'ready'>('boot');
  const [info, setInfo] = useState<ExitInfo | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [withdrawFirst, setWithdrawFirst] = useState(false); // [HF-WIRE-16] server answered 409 withdraw_first
  const [smallLeft, setSmallLeft] = useState(0); // [HF-WIRE-16] server answered 409 forfeit_required for a wallet leftover (rupees)

  async function load() {
    try { setInfo(await fetchExit()); setPhase('ready'); }
    catch (e) { setPhase(e instanceof ApiError && e.status === 401 ? 'signedout' : 'error'); }
  }
  useEffect(() => {
    if (looksSignedOut()) { setPhase('signedout'); return; }
    void load();
  }, []);

  async function begin() {
    setBusy(true); setMsg(null); setWithdrawFirst(false);
    try { await startExit(agree); await load(); }
    catch (e) {
      const b = (e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body : {}) as { error?: string; message?: string };
      if (b.error === 'nothing_to_settle') await load();
      else if (b.error === 'withdraw_first') { setWithdrawFirst(true); setMsg({ kind: 'err', text: walletExitMessage(e) }); }
      else if (b.error === 'forfeit_required') {
        const r = (e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { forfeitRupees?: unknown }).forfeitRupees : 0);
        if (typeof r === 'number' && r > 0) setSmallLeft(r);
        setMsg({ kind: 'err', text: walletExitMessage(e) });
      }
      else if (b.error === 'active_call') setMsg({ kind: 'err', text: 'You are on a call right now. Please finish the call and try again.' });
      else setMsg({ kind: 'err', text: walletExitMessage(e) });
    }
    setBusy(false);
  }
  async function stop() {
    setBusy(true); setMsg(null);
    try { await cancelExit(); await load(); setMsg({ kind: 'ok', text: 'Your account closure was cancelled. Your account stays open.' }); }
    catch (e) { setMsg({ kind: 'err', text: walletExitMessage(e) }); }
    setBusy(false);
  }
  async function closeNow() {
    setBusy(true); setMsg(null);
    try { const r = await deleteAccountNow(); setClosedAt(r.grace_ends_at ?? null); await load(); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) await load(); // money appeared meanwhile: show the exit summary instead
      else setMsg({ kind: 'err', text: walletExitMessage(e) });
    }
    setBusy(false);
  }

  if (phase === 'boot') return <PageShell className="hfc-page"><p role="status">Loading…</p></PageShell>;
  if (phase === 'signedout') return <PageShell className="hfc-page"><h1>Close my account</h1><p>Please sign in to close your account.</p><a className="hfc-btn hfc-primary" href={signInUrl('/dashboard/close')}>Sign in</a></PageShell>;
  if (phase === 'error' || !info) {
    return <PageShell className="hfc-page"><h1>Close my account</h1><p>We could not load your account. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></PageShell>;
  }

  const ex = info.exit && ['waiting_hold', 'waiting_payouts', 'ready'].includes(info.exit.status) ? info.exit : null;
  const hasMoney = info.paidBalance > 0 || info.refund != null || info.payout != null;
  const m = (n: number) => formatPaise(Math.round(n * 100)); // [HF-STD-PLAN-1] rupees, two decimals
  const scheduled = info.deletion?.scheduledAt ?? closedAt;
  const giveUpRupees = info.forfeitRupees + smallLeft; // earnings that cannot be paid + a wallet leftover below the smallest withdrawal
  // [HF-FIX-CLOSE-ACCOUNT-1] the wallet balance exactly as the Wallet page shows it (after GST)
  const walletMoney = info.tokens ? info.tokens.walletPaise / 100 : info.refundable + info.manualRefund;
  const restPaise = info.tokens?.roundingPaise ?? 0; // [HF-CLOSE-UPI-1] paise under Re 1: not paid out
  const payoutPaise = info.tokens?.walletPayoutPaise ?? 0;
  const releaseOn = dateIN(info.heldReleaseAt);

  return (
    <PageShell className="hfc-page">
      <SessionBridge on={!embedded} />
      <h1>Close my account</h1>

      {scheduled && !ex && (
        <section className="hfc-card" aria-labelledby="hfx-done">
          <h2 id="hfx-done">Your account is scheduled to close</h2>
          <p style={{ margin: 0 }}>Your money has been settled. Your account and personal details will be deleted after {dateIN(scheduled)}. If you sign in again before then, you can cancel the deletion.</p>
        </section>
      )}

      {ex && (
        <section className="hfc-card" aria-labelledby="hfx-prog">
          <h2 id="hfx-prog">We are paying out your money first</h2>
          <p className="hfc-sub" style={{ margin: 0 }}>Your account will be deleted automatically as soon as everything below is paid. Nothing else is needed from you.</p>
          {ex.status === 'waiting_hold' && (
            <p className="hfc-note" role="status"><strong>Why it is waiting:</strong> {m(info.held)} of your earnings are still in the 7-day hold{releaseOn ? `, which ends on ${releaseOn}` : ''}. After that we make ONE withdrawal to your UPI{payoutPaise > 0 ? `, and your wallet money (${formatPaise(payoutPaise)}) is paid together with it` : ''}. You don’t need to do anything.</p>
          )}
          <p className="hfc-sub" style={{ margin: 0 }}>While your account is closing you can’t make calls, go online as an influencer or add money.</p>
          {info.refund && (
            <div className="hfc-stat" style={{ textAlign: 'left' }}>
              <strong>{m(info.refund.amount)}</strong>
              <span>Refund (started before this change): {REF[info.refund.status] ?? info.refund.status}{info.refund.reason ? ` (${info.refund.reason})` : ''}</span>
            </div>
          )}
          {info.payout && (
            <div className="hfc-stat" style={{ textAlign: 'left' }}>
              <strong>{m(info.payout.amount)}</strong>
              <span>Final withdrawal to your UPI or bank: {PAY[info.payout.status] ?? info.payout.status}{info.payout.reason ? ` (${info.payout.reason})` : ''}{info.payout.utr ? `, reference ${info.payout.utr}` : ''}</span>
            </div>
          )}
          <button type="button" className="hfc-btn" disabled={busy} onClick={() => void stop()}>Cancel and keep my account</button>
          <p className="hfc-sub" style={{ margin: 0 }}>You can cancel until your money has been approved for payment.</p>
        </section>
      )}

      {!ex && !scheduled && info.decision === 'exit' && hasMoney && (
        <section className="hfc-card" aria-labelledby="hfx-sum">
          <h2 id="hfx-sum">Your money comes first</h2>
          <p style={{ margin: 0 }}>You have money in your account, so it is settled before your account is deleted. Your wallet balance is paid out to your UPI after a one-time ID and UPI check (never back to the card or UPI you paid from). Earnings are paid out together with it. Your account is deleted once everything is paid.</p>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{info.tokens ? formatPaise(payoutPaise) : m(walletMoney)}</strong><span>{info.tokens ? 'you will receive from your wallet (whole rupees), paid to your UPI' : 'wallet balance, paid out to your UPI'}</span></div>
            <div className="hfc-stat"><strong>{m(info.withdrawable)}</strong><span>earnings, paid out to your UPI or bank</span></div>
            <div className="hfc-stat"><strong>{m(info.held)}</strong><span>earnings in the 7-day hold{info.heldReleaseAt ? `, until ${dateIN(info.heldReleaseAt)}` : ''}</span></div>
          </div>
          {restPaise > 0 && <p className="hfc-sub" style={{ margin: 0 }}>The {formatPaise(restPaise)} left over is below ₹1, so it cannot be paid out. It is removed with your account.</p>}
          {info.held > 0 && <p className="hfc-note">Held earnings are paid after the hold ends{releaseOn ? `, on ${releaseOn}` : ''}, so closing will wait until then. Your wallet money is paid together with them, and we message you on WhatsApp when it starts.</p>}
          {info.tokens && info.tokens.walletPayoutPaise > 0 && !info.tokens.payoutReady && (
            <div className="hfc-note" role="status"><strong>Set up your withdrawal first.</strong> Your wallet money is paid to your own UPI ID, after a one-time ID check. Do both here, then close your account.
              <UpiSetup where="close" skin="hfc" next="/dashboard/close" onSaved={() => void load()} /></div>
          )}
          {!info.tokens && walletMoney > 0 && (
            <p className="hfc-note" role="status">{withdrawFirst ? 'Withdraw your wallet money first, then come back here to close your account. ' : ''}<a className="hfc-btn" href={PAYOUT_HREF}>Go to Withdraw</a> If what is left is under ₹1 (too small to pay out), you can choose to give it up below.</p>
          )}
          {!info.bankOk && (info.withdrawable > 0 || info.held > 0) && (
            <p className="hfc-note">To receive your earnings you need a verified bank account (<a href="/dashboard/host/earnings">add it on your Earnings page</a>). If you would rather not, you can give up those earnings below.</p>
          )}
          {giveUpRupees > 0 && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 4, width: 20, height: 20 }} />
              <span>I understand that {m(giveUpRupees)} cannot be paid out and will be lost when my account is deleted.</span>
            </label>
          )}
          {(info.testCredits > 0 || info.testEarnings > 0) && <p className="hfc-sub" style={{ margin: 0 }}>Test credits ({m(info.testCredits)}) and earnings from test credits ({m(info.testEarnings)}) are not real money and are simply removed.</p>}
          <button type="button" className="hfc-btn hfc-primary" disabled={busy || !!(info.tokens && ((info.tokens.walletPayoutPaise > 0 && !info.tokens.payoutReady) || info.tokens.debtBlocked)) || (giveUpRupees > 0 && !agree)} onClick={() => void begin()}>
            {busy ? 'Working…' : 'Close my account'}
          </button>
        </section>
      )}

      {!ex && !scheduled && (info.decision === 'delete' || !hasMoney) && (
        <section className="hfc-card" aria-labelledby="hfx-now">
          <h2 id="hfx-now">You have no money to settle</h2>
          <p style={{ margin: 0 }}>Your account and personal details will be deleted after a 30-day waiting period. You can change your mind by signing in again before it ends.{info.testCredits > 0 ? ` Your test credits (${m(info.testCredits)}) are not real money and will be removed.` : ''}</p>
          <button type="button" className="hfc-btn hfc-primary" disabled={busy} onClick={() => void closeNow()}>{busy ? 'Working…' : 'Close my account'}</button>
        </section>
      )}

      {msg && <p role="status" className={msg.kind === 'err' ? 'hfc-err' : 'hfc-note'}>{msg.text}</p>}
      <p className="hfc-sub">See <a href="/data-deletion">how deletion works</a> and what we keep.</p>
    </PageShell>
  );
}
