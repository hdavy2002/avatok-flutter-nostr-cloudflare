/* [HF-WITHDRAW-1] Withdraw on the website, for EVERYONE (fans and influencers; rulebook HF-REEL-36 / HF-REEL-38): one component used on
 * Wallet and on Earnings. Worker (the same endpoints the app uses): GET /api/hf/payouts/summary (what is ready, UPI, ID check),
 * GET /api/hosts/me/payouts (the person's requests with raw statuses), POST /api/hf/payouts {amountPaise} + Idempotency-Key,
 * POST /api/hosts/me/payouts/:id/cancel (only while "requested"). Whole rupees, no fee, no minimum unless the server says so.
 * Wallet money = the person's own paid top-ups (test credits never); an influencer's matured earnings are added to the same pot.
 * Money is set aside the moment the request is made, a person checks it, then it is paid to the person's own UPI and the bank
 * reference (UTR) is shown here. Reject or cancel puts the money back. Telemetry: hf_withdraw_started / _submitted / _failed / _cancelled. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { capture, captureException, currentDistinctUid } from '../../lib/analytics';
import {
  ApiError, cancelWithdrawal, fetchPayoutSummary, fetchWithdrawals, maskUpi, requestWithdrawal, withdrawErrorMessage,
  type PayoutSummary, type WithdrawalList, type WithdrawalRequest,
} from '../../lib/hfPayoutApi';
import { formatPaise } from '../../lib/money';
import UpiSetup from './UpiSetup';

interface Props {
  /** Which button/field classes to use: the dashboard (h3) or the older account pages (hfc). */
  skin: 'h3' | 'hfc';
  /** Where the ID check sends the person back to (a path under /dashboard). */
  next: string;
  /** Where this sits, for telemetry. */
  where: 'wallet' | 'earnings';
  /** The wallet shows an open debt after a refund; withdrawals are paused until it is cleared. */
  debtOpen?: boolean;
  /** Called after a request is made or cancelled, so the page can re-read its own balance. */
  onChanged?: () => void;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const STATUS_TEXT: Record<WithdrawalRequest['status'], string> = {
  requested: 'Waiting for our check', approved: 'Approved, payment on its way', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled',
};
const day = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export default function Withdraw({ skin, next, where, debtOpen, onChanged }: Props) {
  const [sum, setSum] = useState<PayoutSummary | null>(null);
  const [list, setList] = useState<WithdrawalList | null>(null);
  const [failed, setFailed] = useState(false);
  const [soon, setSoon] = useState(false);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [busy, setBusy] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // One key per attempt; kept until the request gets a definite answer so a double tap or a retry cannot create two requests.
  const attempt = useRef<{ amount: number; key: string } | null>(null);
  const edited = useRef(false);
  const uid = () => ({ uid: currentDistinctUid(), where });

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [s, l] = await Promise.all([fetchPayoutSummary(), fetchWithdrawals().catch(() => null)]);
      setSum(s); setList(l); setSoon(false);
      if (!edited.current) setAmount(String(Math.floor(Math.max(0, s.readyPaise) / 100)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setSoon(true); return; }
      setFailed(true);
      capture('hf_withdraw_load_failed', { ...uid(), status: e instanceof ApiError ? e.status : 0 });
      if (!(e instanceof ApiError)) captureException(e, { area: 'hf_withdraw', step: 'load', ...uid() });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const primary = skin === 'h3' ? 'h3-btn rani' : 'hfc-btn hfc-primary';
  const plain = skin === 'h3' ? 'h3-btn ghost' : 'hfc-btn';
  const small = skin === 'h3' ? 'h3-btn sm ghost' : 'hfc-btn';
  const fieldCls = skin === 'h3' ? 'f' : undefined;

  if (soon) return <p className="small muted">Withdrawals open soon.</p>;
  if (failed) return <div><p className="small" role="alert" style={{ color: 'var(--bad, #b3261e)' }}>We could not load your withdrawal details.</p><button type="button" className={small} onClick={() => void load()}>Try again</button></div>;
  if (!sum) return <p className="small muted" role="status">Loading…</p>;

  const readyRupees = Math.floor(Math.max(0, sum.readyPaise) / 100);
  const minRupees = Math.max(1, Math.ceil(Math.max(0, sum.minPaise) / 100)); // HF-REEL-38: no minimum on the server = 0, but an amount is at least ₹1
  const n = Number(amount);
  const validAmount = Number.isInteger(n) && n >= minRupees && n <= readyRupees;
  const requests = list?.requests ?? [];
  const now = Date.now();
  const maxPerWeek = list?.maxPerWeek ?? 2;
  const recent = requests.filter(r => (r.status === 'requested' || r.status === 'approved' || r.status === 'paid') && r.createdAt > now - WEEK_MS);
  const weekFull = recent.length >= maxPerWeek;
  const nextSlot = weekFull ? Math.min(...recent.map(r => r.createdAt)) + WEEK_MS : 0;
  const paidBefore = sum.history ? sum.history.some(h => h.status === 'paid') : requests.some(r => r.status === 'paid');
  const needUpi = !sum.upi;
  const needKyc = sum.kycStatus !== 'verified' && !paidBefore;
  const setupNeeded = needUpi || needKyc;
  const blocker =
    debtOpen ? 'You owe money after a refund, so withdrawals are paused. It is cleared from the next money you add.'
      : weekFull ? `You have used all ${maxPerWeek} withdrawal requests allowed in 7 days. You can ask again from ${day(nextSlot)}.`
        : readyRupees < minRupees ? (sum.minPaise > 0 ? `You can withdraw once you have at least ${formatPaise(minRupees * 100)} ready.` : 'You have nothing ready to withdraw yet.')
          : null;
  const canAsk = !setupNeeded && !blocker;

  function review() {
    if (!canAsk || !validAmount || busy) return;
    setMsg(null); setStep('confirm');
    capture('hf_withdraw_started', { ...uid(), amount_rupees: n });
  }

  async function submit() {
    if (!canAsk || !validAmount || busy) return;
    setBusy(true); setMsg(null);
    if (!attempt.current || attempt.current.amount !== n) attempt.current = { amount: n, key: crypto.randomUUID() };
    try {
      await requestWithdrawal(n, attempt.current.key);
      attempt.current = null; edited.current = false; setStep('form');
      capture('hf_withdraw_submitted', { ...uid(), amount_rupees: n });
      setMsg({ kind: 'ok', text: `Request sent for ${formatPaise(n * 100)}. A person will check it, then we pay it to your UPI ID and show the payment reference here.` });
      await load(); onChanged?.();
    } catch (e) {
      const code = e instanceof ApiError && e.body && typeof e.body === 'object' ? String((e.body as { error?: unknown }).error ?? '') : '';
      // A definite answer from the server (a 4xx) ends the attempt; a timeout or network error keeps the key so a retry is safe.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) attempt.current = null;
      capture('hf_withdraw_failed', { ...uid(), amount_rupees: n, error: code || (e instanceof ApiError ? `http_${e.status}` : 'network'), status: e instanceof ApiError ? e.status : 0 });
      if (!(e instanceof ApiError)) captureException(e, { area: 'hf_withdraw', step: 'submit', ...uid() });
      setStep('form'); setMsg({ kind: 'err', text: withdrawErrorMessage(e) });
      await load();
    }
    setBusy(false);
  }

  async function cancel(id: string) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      await cancelWithdrawal(id);
      capture('hf_withdraw_cancelled', { ...uid() });
      setMsg({ kind: 'ok', text: 'Request cancelled. The money is back in your balance.' });
      await load(); onChanged?.();
    } catch (e) {
      capture('hf_withdraw_failed', { ...uid(), step: 'cancel', error: e instanceof ApiError ? (e.error || `http_${e.status}`) : 'network', status: e instanceof ApiError ? e.status : 0 });
      setMsg({ kind: 'err', text: withdrawErrorMessage(e) });
      await load();
    }
    setBusy(false);
  }

  const onHold = Math.max(0, sum.onHoldPaise);
  return <div style={{ display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <div><div className="small muted">You can withdraw now</div><div className="num" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{formatPaise(readyRupees * 100)}</div></div>
      {onHold > 0 && <div><div className="small muted">Influencer earnings in the 7-day hold</div><div className="num" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{formatPaise(onHold)}</div></div>}
    </div>
    <p className="small muted">Whole rupees only, and we take no fee. Test credits can be spent on calls but cannot be withdrawn.</p>

    {setupNeeded && <div style={{ display: 'grid', gap: 8 }}>
      <p className="small" role="status"><b>Before your first withdrawal:</b> add your own UPI ID{needKyc ? ' and do the one-time ID check' : ''}.</p>
      <UpiSetup where="wallet" skin={skin} next={next} onSaved={() => { void load(); onChanged?.(); }} />
    </div>}

    {!setupNeeded && sum.upi && <p className="small">Goes to your UPI ID <b>{maskUpi(sum.upi.vpa)}</b> only. <button type="button" className={small} style={{ marginLeft: 6 }} onClick={() => setShowSetup(v => !v)}>{showSetup ? 'Hide' : 'Change UPI ID'}</button></p>}
    {!setupNeeded && showSetup && <UpiSetup where="wallet" skin={skin} next={next} onSaved={() => { void load(); onChanged?.(); setShowSetup(false); }} />}

    {blocker && !setupNeeded && <p className="small" role="status" style={{ fontWeight: 700 }}>{blocker}</p>}

    {canAsk && step === 'form' && <form onSubmit={e => { e.preventDefault(); review(); }} style={{ display: 'grid', gap: 8 }}>
      <label className={fieldCls}>How much do you want to withdraw? (₹{minRupees} – ₹{readyRupees})
        <input inputMode="numeric" autoComplete="off" value={amount} disabled={busy} aria-label="Amount in rupees"
          onChange={e => { edited.current = true; setAmount(e.target.value.replace(/\D/g, '').slice(0, 7)); }} />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className={primary} disabled={!validAmount || busy}>{validAmount ? `Withdraw ${formatPaise(n * 100)}` : `Enter ₹${minRupees} – ₹${readyRupees}`}</button>
        <button type="button" className={plain} disabled={busy} onClick={() => { edited.current = true; setAmount(String(readyRupees)); }}>All {formatPaise(readyRupees * 100)}</button>
      </div>
      <p className="small muted">You can make up to {maxPerWeek} withdrawal requests in 7 days.</p>
    </form>}

    {canAsk && step === 'confirm' && sum.upi && <div role="group" aria-label="Confirm withdrawal" style={{ display: 'grid', gap: 8, padding: 14, borderRadius: 16, border: '1px solid var(--line, #e3d6c6)' }}>
      <b>Please check before you confirm</b>
      <div>You receive: <b>{formatPaise(n * 100)}</b> (no fee)</div>
      <div>Sent to: <b>{maskUpi(sum.upi.vpa)}</b></div>
      <div className="small muted">When: not instant. This money is set aside from your wallet now. A person checks every request, then pays it to your UPI ID, and you will see the status and the payment reference (UTR) below. You can cancel while it says “Waiting for our check”.</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={primary} disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : `Confirm ${formatPaise(n * 100)}`}</button>
        <button type="button" className={plain} disabled={busy} onClick={() => setStep('form')}>Go back</button>
      </div>
    </div>}

    {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className="small" style={{ color: msg.kind === 'err' ? 'var(--bad, #b3261e)' : 'var(--peacock, #1b6b5f)', fontWeight: 700 }}>{msg.text}</p>}

    {requests.length > 0 && <div>
      <b>Your withdrawal requests</b>
      <ul className={skin === 'hfc' ? 'hfc-calls' : undefined} style={skin === 'h3' ? { listStyle: 'none', padding: 0, margin: '6px 0 0' } : undefined}>
        {requests.slice(0, 12).map(r => <li key={r.id} className={skin === 'h3' ? 'h3-rcpt' : undefined}>
          <div><b>{formatPaise(r.amount * 100)}</b>{r.exit ? ' · account closing' : ''}
            <div className="small muted">{STATUS_TEXT[r.status]}
              {r.status === 'paid' && r.utr ? ` · Payment reference (UTR) ${r.utr}` : ''}
              {r.status === 'rejected' ? ` · ${r.reason || 'We could not pay this request'}. The money is back in your balance.` : ''}
              {' · '}{day(r.paidAt ?? r.createdAt)}</div></div>
          {r.status === 'requested' && !r.exit && <button type="button" className={small} disabled={busy} onClick={() => void cancel(r.id)}>Cancel</button>}
        </li>)}
      </ul>
    </div>}
  </div>;
}
