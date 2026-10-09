/* [HF-WALLET-EXIT-1] /account/close: pay-out-first account closure. Shows what happens to the user's money, starts the exit
 * (refund of unused top-ups + final host payout), tracks progress, and closes the account once everything is settled.
 * Worker: GET/POST/DELETE /api/hf/account/exit, POST /api/account/delete (no-money case). Rulebook HF-PAY-14. */
import { useEffect, useState } from 'react';
import SessionBridge from '../calls/SessionBridge';
import { inr, looksSignedOut, signInUrl } from '../../lib/hfCallsApi';
import { fetchExit, startExit, cancelExit, deleteAccountNow, walletExitMessage, ApiError, type ExitInfo } from '../../lib/hfWalletExitApi';

const dateIN = (ms: number | null | undefined): string => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const PAY: Record<string, string> = { requested: 'Waiting for approval', approved: 'Approved, being paid', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled' };
const REF: Record<string, string> = { requested: 'Waiting for approval', processing: 'Being sent back', refunded: 'Sent back', rejected: 'Not processed', cancelled: 'Cancelled' };

export default function AccountClose() {
  const [phase, setPhase] = useState<'boot' | 'signedout' | 'error' | 'ready'>('boot');
  const [info, setInfo] = useState<ExitInfo | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [closedAt, setClosedAt] = useState<number | null>(null);

  async function load() {
    try { setInfo(await fetchExit()); setPhase('ready'); }
    catch (e) { setPhase(e instanceof ApiError && e.status === 401 ? 'signedout' : 'error'); }
  }
  useEffect(() => {
    if (looksSignedOut()) { setPhase('signedout'); return; }
    void load();
  }, []);

  async function begin() {
    setBusy(true); setMsg(null);
    try { await startExit(agree); await load(); }
    catch (e) {
      const b = (e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body : {}) as { error?: string };
      if (b.error === 'nothing_to_settle') await load();
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

  if (phase === 'boot') return <main className="hfc-page"><p role="status">Loading…</p></main>;
  if (phase === 'signedout') return <main className="hfc-page"><h1>Close my account</h1><p>Please sign in to close your account.</p><a className="hfc-btn hfc-primary" href={signInUrl('/account/close')}>Sign in</a></main>;
  if (phase === 'error' || !info) {
    return <main className="hfc-page"><h1>Close my account</h1><p>We could not load your account. Please check your internet and try again.</p><button type="button" className="hfc-btn hfc-primary" onClick={() => window.location.reload()}>Try again</button></main>;
  }

  const ex = info.exit && ['waiting_hold', 'waiting_payouts', 'ready'].includes(info.exit.status) ? info.exit : null;
  const hasMoney = info.paidBalance > 0 || info.refund != null || info.payout != null;
  const scheduled = info.deletion?.scheduledAt ?? closedAt;

  return (
    <main className="hfc-page">
      <SessionBridge on />
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
            <p className="hfc-note">Some of your earnings ({inr(info.held)}) are still in the 7-day hold{info.heldReleaseAt ? `, which ends on ${dateIN(info.heldReleaseAt)}` : ''}. After that we create your final withdrawal.</p>
          )}
          <p className="hfc-sub" style={{ margin: 0 }}>While your account is closing you can’t make calls, go online as a host or add money.</p>
          {info.refund && (
            <div className="hfc-stat" style={{ textAlign: 'left' }}>
              <strong>{inr(info.refund.amount)}</strong>
              <span>Refund of unused top-ups to the payment you used: {REF[info.refund.status] ?? info.refund.status}{info.refund.reason ? ` (${info.refund.reason})` : ''}</span>
            </div>
          )}
          {info.payout && (
            <div className="hfc-stat" style={{ textAlign: 'left' }}>
              <strong>{inr(info.payout.amount)}</strong>
              <span>Final withdrawal of your earnings to your bank: {PAY[info.payout.status] ?? info.payout.status}{info.payout.reason ? ` (${info.payout.reason})` : ''}{info.payout.utr ? `, reference ${info.payout.utr}` : ''}</span>
            </div>
          )}
          <button type="button" className="hfc-btn" disabled={busy} onClick={() => void stop()}>Cancel and keep my account</button>
          <p className="hfc-sub" style={{ margin: 0 }}>You can cancel until your money has been approved for payment.</p>
        </section>
      )}

      {!ex && !scheduled && info.decision === 'exit' && hasMoney && (
        <section className="hfc-card" aria-labelledby="hfx-sum">
          <h2 id="hfx-sum">Your money comes first</h2>
          <p style={{ margin: 0 }}>You have money in your wallet, so we pay it out before deleting your account. Your account is deleted once it is paid. This can take a few days because people approve each payment.</p>
          <div className="hfc-stats">
            <div className="hfc-stat"><strong>{inr(info.refundable + info.manualRefund)}</strong><span>unused top-ups, refunded to the original payment</span></div>
            <div className="hfc-stat"><strong>{inr(info.withdrawable)}</strong><span>earnings, withdrawn to your bank</span></div>
            <div className="hfc-stat"><strong>{inr(info.held)}</strong><span>earnings in the 7-day hold{info.heldReleaseAt ? `, until ${dateIN(info.heldReleaseAt)}` : ''}</span></div>
          </div>
          {info.held > 0 && <p className="hfc-note">Held earnings are paid after the hold ends, so closing will wait until then.</p>}
          {info.manualRefund > 0 && <p className="hfc-sub" style={{ margin: 0 }}>{inr(info.manualRefund)} is old enough that the payment provider may not take it back. In that case our team pays it to you by bank transfer.</p>}
          {!info.bankOk && (info.withdrawable > 0 || info.held > 0) && (
            <p className="hfc-note">To receive your earnings you need a verified bank account (<a href="/hosts/dashboard">add it on your host dashboard</a>). If you would rather not, you can give up those earnings below.</p>
          )}
          {info.forfeitRupees > 0 && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 4, width: 20, height: 20 }} />
              <span>I understand that {inr(info.forfeitRupees)} cannot be paid out and will be lost when my account is deleted.</span>
            </label>
          )}
          {(info.testCredits > 0 || info.testEarnings > 0) && <p className="hfc-sub" style={{ margin: 0 }}>Test credits ({inr(info.testCredits)}) and earnings from test credits ({inr(info.testEarnings)}) are not real money and are simply removed.</p>}
          <button type="button" className="hfc-btn hfc-primary" disabled={busy || (info.forfeitRupees > 0 && !agree)} onClick={() => void begin()}>
            {busy ? 'Working…' : 'Pay out my money and close my account'}
          </button>
        </section>
      )}

      {!ex && !scheduled && (info.decision === 'delete' || !hasMoney) && (
        <section className="hfc-card" aria-labelledby="hfx-now">
          <h2 id="hfx-now">You have no money to settle</h2>
          <p style={{ margin: 0 }}>Your account and personal details will be deleted after a 30-day waiting period. You can change your mind by signing in again before it ends.{info.testCredits > 0 ? ` Your test credits (${inr(info.testCredits)}) are not real money and will be removed.` : ''}</p>
          <button type="button" className="hfc-btn hfc-primary" disabled={busy} onClick={() => void closeNow()}>{busy ? 'Working…' : 'Close my account'}</button>
        </section>
      )}

      {msg && <p role="status" className={msg.kind === 'err' ? 'hfc-err' : 'hfc-note'}>{msg.text}</p>}
      <p className="hfc-sub">See <a href="/data-deletion">how deletion works</a> and what we keep.</p>
    </main>
  );
}
