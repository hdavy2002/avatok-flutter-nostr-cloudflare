/* [HF-DASH-V3-1] Close my account (rulebook HF-PAY-14: pay out first, then delete). Same server flow as before, new look:
 * a checklist of what is settled, then "type CLOSE" to confirm. Worker: GET/POST/DELETE /api/hf/account/exit, POST /api/account/delete. */
import { useEffect, useState, type ReactNode } from 'react';
import { formatPaise } from '../../../lib/money';
import { capture, captureException, currentDistinctUid } from '../../../lib/analytics';
import { fetchExit, startExit, cancelExit, deleteAccountNow, walletExitMessage, walletExitCode, ApiError, PAYOUT_HREF, type ExitInfo } from '../../../lib/hfWalletExitApi';
import { putPrefs, getPrefs } from './data';
import { Card, Failed, PageHead, Skel, Sticker, useToast } from './ui';

const dateIN = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const PAY: Record<string, string> = { requested: 'Waiting for approval', approved: 'Approved, being paid', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled' };
const REF: Record<string, string> = { requested: 'Waiting for approval', processing: 'Being processed', refunded: 'Done', rejected: 'Not processed', cancelled: 'Cancelled' };

export default function Close() {
  const toast = useToast();
  const [info, setInfo] = useState<ExitInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null); // "Notify me" WhatsApps; null until the account's prefs are read
  const uidProps = () => ({ uid: currentDistinctUid() });
  const load = async () => {
    setFailed(false);
    try { setInfo(await fetchExit()); }
    catch (e) { setFailed(true); capture('hf_dash3_close_load_failed', { ...uidProps(), status: e instanceof ApiError ? e.status : 0 }); captureException(e, { area: 'hf_close', step: 'load', ...uidProps() }); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { void getPrefs().then(r => { if (r.ok) setNotifyOn(r.data.notifyWhatsapp !== false); }); }, []);
  const m = (n: number) => formatPaise(Math.round(n * 100));
  const ex = info?.exit && ['waiting_hold', 'waiting_payouts', 'ready'].includes(info.exit.status) ? info.exit : null;
  const scheduled = info?.deletion?.scheduledAt ?? null;
  // The server decides (it only says "exit" when there is real money to settle), so a sub-rupee leftover never strands the person on this page.
  const hasMoney = !!info && (info.decision === 'exit' || info.refund != null || info.payout != null);
  const tk = info?.tokens ?? null;
  // The wallet balance as the Wallet page shows it (after GST). Older worker answers carry it as paidBalance.
  const walletPaise = tk ? tk.walletPaise : Math.round((info?.paidBalance ?? 0) * 100);
  const payoutPaise = tk ? tk.walletPayoutPaise : walletPaise;
  const setupMissing = !!tk && tk.walletPayoutPaise > 0 && !tk.payoutReady; // needs the UPI ID / one-time ID check first
  const sure = typed.trim().toUpperCase() === 'CLOSE';
  const go = async () => {
    if (!info || !sure || busy) return;
    setBusy(true); setErr('');
    try {
      if (info.decision === 'exit' && hasMoney) await startExit(agree);
      else await deleteAccountNow();
      capture('hf_dash3_close_started', { ...uidProps(), with_money: hasMoney, wallet_paise: walletPaise, wallet_payout_paise: payoutPaise, forfeit: agree });
      await load();
    } catch (e) {
      const b = (e instanceof ApiError && e.body && typeof e.body === 'object' ? e.body : {}) as { error?: string };
      capture('hf_dash3_close_failed', { ...uidProps(), error: walletExitCode(e) || (e instanceof ApiError ? `http_${e.status}` : 'network'), status: e instanceof ApiError ? e.status : 0, with_money: hasMoney });
      if (!(e instanceof ApiError)) captureException(e, { area: 'hf_close', step: 'start', ...uidProps() });
      if (b.error === 'nothing_to_settle' || (e instanceof ApiError && e.status === 409)) await load();
      else if (b.error === 'active_call') setErr('You are on a call right now. Please finish the call and try again.');
      else setErr(walletExitMessage(e));
    }
    setBusy(false);
  };
  const item = (done: boolean, title: string, body: string, act?: ReactNode) => <div className={`h3-step${done ? ' done' : ' cur'}`} style={{ cursor: 'default' }}>
    <div className="n">{done ? '✓' : '!'}</div><div style={{ flex: 1 }}><b>{title}</b><div className="small muted">{body}</div>{act && <div style={{ marginTop: 8 }}>{act}</div>}</div></div>;

  return <>
    <PageHead eyebrow="Close my account" title="Itni jaldi? 🥺" sub="Sab moh maya hai — but we’ll miss you. Here’s what happens before your account is closed." art={<Sticker name="mohmaya" w={110} rot={5} />} />
    {failed ? <Failed onRetry={() => void load()} /> : !info ? <Skel h={300} /> : scheduled && !ex ? <Card title="Your account is scheduled to close" note="">
      <p>Your money has been settled. Your account and personal details will be deleted after {dateIN(scheduled)}. Sign in again before then to cancel.</p></Card>
    : ex ? <Card title="We are paying out your money first" note="Your account is deleted automatically once everything below is paid">
      {ex.status === 'waiting_hold' && <p className="small" style={{ marginBottom: 10 }}>Some earnings ({m(info.held)}) are in the 7-day hold{info.heldReleaseAt ? ` until ${dateIN(info.heldReleaseAt)}` : ''}.</p>}
      <div className="h3-break">
        {info.refund && <div><span>Refund of unused top-ups (started before this change)</span><b>{m(info.refund.amount)} · {REF[info.refund.status] ?? info.refund.status}</b></div>}
        {info.payout && <div><span>Final payout to your UPI</span><b>{m(info.payout.amount)} · {PAY[info.payout.status] ?? info.payout.status}</b></div>}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>While your account is closing you can’t make calls, go online or add money.</p>
      <button type="button" className="h3-btn ghost" style={{ marginTop: 12 }} disabled={busy} onClick={async () => { setBusy(true); try { await cancelExit(); toast('Closing cancelled. Your account stays open 🌼'); await load(); } catch (e) { setErr(walletExitMessage(e)); } setBusy(false); }}>Cancel and keep my account</button>
      {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
    </Card>
    : <section className="h3-row c21">
      <Card title="Before you go" note="We settle your money first, then delete">
        <div className="h3-steps">
          {item(payoutPaise <= 0, `Wallet balance: ${formatPaise(walletPaise)}`,
            payoutPaise > 0
              ? `Your wallet balance of ${formatPaise(payoutPaise)} is paid out to your UPI after a one-time ID and UPI check. It is not sent back to your card or UPI you paid from. Test credits are simply removed.`
              : 'Nothing is left to pay out. Test credits are simply removed.',
            walletPaise > 0 ? <a className="h3-btn sm ghost" href="/dashboard/wallet">See wallet</a> : undefined)}
          {setupMissing && item(false, tk && !tk.upiOk ? 'Add your UPI ID first' : 'Finish the one-time ID check first',
            tk && !tk.upiOk ? 'Add your UPI ID in the app (Me, then Payout) and finish the one-time ID check. Then come back here and close your account.' : 'We check your ID once, before your first payout. Then come back here and close your account.',
            <a className="h3-btn sm ghost" href={tk && !tk.upiOk && (info.withdrawable > 0 || info.held > 0) ? PAYOUT_HREF : '/hosts/onboarding?step=aadhaar'}>{tk && !tk.upiOk && (info.withdrawable > 0 || info.held > 0) ? 'Go to Payout' : 'Do the ID check'}</a>)}
          {tk?.debtBlocked && item(false, 'There is an open balance on your account', 'Please write to us from Support and we will settle it with you before you close.', <a className="h3-btn sm ghost" href="/dashboard/support">Go to Support</a>)}
          {(info.withdrawable > 0 || info.held > 0) && item(false, `Influencer earnings: ${m(info.withdrawable + info.held)}`, `Paid out to your UPI or bank, together with your wallet balance${info.held > 0 ? `; ${m(info.held)} waits for the 7-day hold` : ''}.`, !info.bankOk && !tk?.payoutReady ? <a className="h3-btn sm ghost" href="/dashboard/host/earnings">Add a verified bank</a> : undefined)}
          {item(true, 'What gets deleted', 'Your profile, My Fraands, call history and preferences, after a 30-day waiting period. Some payment and safety records are kept only as long as the law requires.')}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>See <a href="/data-deletion">how deletion works</a>.</p>
      </Card>
      <Card title="Confirm" note="This can’t be undone after the waiting period" tone={1}>
        <div className="h3-confirm" style={{ display: 'grid', gap: 12 }}>
          {info.forfeitRupees > 0 && <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ width: 20, height: 20, marginTop: 3 }} /><span className="small">I understand that {m(info.forfeitRupees)} cannot be paid out and will be lost.</span></label>}
          <label className="f">Type CLOSE to confirm<input value={typed} onChange={e => setTyped(e.target.value)} placeholder="CLOSE" autoCapitalize="characters" /></label>
          {err && <p className="small" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
          <button type="button" className="h3-btn danger" disabled={!sure || busy || setupMissing || !!tk?.debtBlocked || (info.forfeitRupees > 0 && !agree)} onClick={go}>{busy ? 'Working…' : hasMoney ? 'Pay out my money and close my account' : 'Close my account'}</button>
          <div style={{ padding: 14, borderRadius: 16, background: 'var(--goldtint)' }}><b>Bas thoda break chahiye?</b><p className="small muted">Pause the “Notify me” WhatsApps instead — your wallet and fraands stay safe.</p>
            <button type="button" className="h3-btn sm gold" style={{ marginTop: 8 }} disabled={notifyOn === null || busy} onClick={async () => {
              const turnOn = notifyOn === false;
              const r = await putPrefs({ notifyWhatsapp: turnOn }); // only the "Notify me" WhatsApps; appointment reminders are not touched
              if (r.ok) setNotifyOn(turnOn);
              else captureException(new Error('close_prefs_failed'), { area: 'hf_close', step: 'prefs', ...uidProps() });
              capture('hf_dash3_close_notify_toggled', { ...uidProps(), notify_whatsapp: r.ok ? turnOn : notifyOn, ok: r.ok });
              toast(r.ok ? (turnOn ? 'Notifications are back on 🌼' : 'Notifications paused. Aram karo 🌼') : 'We could not change that. Please try again.');
            }}>{notifyOn === false ? 'Resume notifications' : 'Pause notifications'}</button></div>
        </div>
      </Card>
    </section>}
  </>;
}
