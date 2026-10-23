/* [HF-PAYOUT-1] Host withdrawals, shown inside HostDashboard. Worker: GET/POST /api/hosts/me/payouts, POST /api/hosts/me/payouts/:id/cancel.
 * Withdrawals: you ask, we pay your UPI ID and show the bank reference (UTR) here. Whole rupees. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/apiClient';
import { relDate } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';

/** [HF-STD-PLAN-1] rupees with paise (an earning of ₹2.98 must not read as ₹3). */
const inr = (n: number): string => formatPaise(Math.round(n * 100));

interface Req { id: string; amount: number; status: 'requested' | 'approved' | 'paid' | 'rejected' | 'cancelled'; utr: string | null; reason: string | null; createdAt: number; paidAt: number | null }
interface Info {
  enabled: boolean; minRupees: number; maxPerWeek: number; holdDays: number; hostStatus: string | null;
  kycOk: boolean; bankOk: boolean; bank: { accountLast4: string | null; ifsc: string | null } | null;
  withdrawable: number; held: number; testEarnings: number; requests: Req[];
}

const STATUS_TEXT: Record<Req['status'], string> = {
  requested: 'Waiting for our check', approved: 'Approved, payment on its way', paid: 'Paid', rejected: 'Not paid', cancelled: 'Cancelled',
};
const ERRORS: Record<string, string> = {
  below_minimum: 'That is below the smallest withdrawal set for now.',
  insufficient_withdrawable: 'That is more than you can withdraw right now.',
  weekly_limit: 'You have made the most requests allowed this week. Please try again later.',
  kyc_required: 'Please finish your identity check first.',
  bank_required: 'Please add and verify your bank account first.',
  not_live: 'Only live influencers can withdraw.',
  invalid_amount: 'Enter a whole number of rupees.',
};

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>, isCurrent?: () => boolean): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }> {
  try {
    const { getActiveTokenWaited } = await import('../../lib/clerk');
    const auth = await getActiveTokenWaited(6000);
    if (isCurrent && !isCurrent()) return { ok: false, code: 'stale_session', message: '' };
    if (!auth) return { ok: false, code: 'no_session', message: 'Please sign in again.' };
    return { ok: true, data: await request<T>(path, { method, auth, body, headers, timeoutMs: 20_000 }) };
  } catch (e) {
    if (e instanceof ApiError) {
      const b = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
      return { ok: false, code: e.error, message: typeof b.message === 'string' ? b.message : '' };
    }
    return { ok: false, code: 'network', message: 'We could not reach the server. Check your internet and try again.' };
  }
}

export default function WithdrawPanel({ onChanged, isCurrent }: { onChanged?: () => void; isCurrent?: () => boolean }) {
  const mounted = useRef(true);
  const currentSession = useRef(isCurrent);
  currentSession.current = isCurrent;
  const current = useCallback(() => mounted.current && (currentSession.current?.() ?? true), []);
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  // One key per attempt; kept until the request settles so a double tap or a retry cannot create two requests.
  const attemptKey = useRef<{ amount: string; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!current()) return;
    const r = await api<Info>('GET', '/api/hosts/me/payouts', undefined, undefined, current);
    if (!current()) return;
    if (r.ok) { setInfo(r.data); setFailed(false); } else setFailed(true);
  }, [current]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);

  if (failed && !info) {
    return <section className="hfc-card" aria-labelledby="hfc-wd"><h2 id="hfc-wd">Withdraw</h2><p>We could not load this right now.</p><button type="button" className="hfc-btn" onClick={() => void load()}>Try again</button></section>;
  }
  if (!info) return null;

  const n = Number(amount);
  const minR = Math.max(1, info.minRupees); // [HF-WIRE-18] HF-REEL-38: the server minimum is 0 = no minimum; an amount must still be at least ₹1
  const validAmount = Number.isInteger(n) && n >= minR && n <= info.withdrawable;
  const blocker =
    !info.enabled ? 'Withdrawals open soon.'
      : info.hostStatus !== 'live' ? 'Only live influencers can withdraw.'
        : !info.kycOk || !info.bankOk ? 'Finish your identity check and bank details to withdraw.'
          : info.withdrawable < minR ? (info.minRupees > 0 ? `You can withdraw once you have at least ${inr(info.minRupees)} available.` : 'You have nothing ready to withdraw yet.')
            : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current() || busy || blocker || !validAmount) return;
    setBusy(true); setMsg(null);
    if (!attemptKey.current || attemptKey.current.amount !== amount) attemptKey.current = { amount, key: crypto.randomUUID() };
    const r = await api<{ ok: true }>('POST', '/api/hosts/me/payouts', { amount: n }, { 'Idempotency-Key': attemptKey.current.key }, current);
    if (!current()) return;
    setBusy(false);
    if (r.ok) {
      attemptKey.current = null; setAmount('');
      setMsg({ tone: 'ok', text: `Request sent for ${inr(n)}. We will pay your bank account and send you the payment reference.` });
      await load(); if (current()) onChanged?.();
    } else {
      if (r.code !== 'network') attemptKey.current = null;
      setMsg({ tone: 'err', text: ERRORS[r.code] ?? (r.message || 'We could not send that. Please try again.') });
      await load();
    }
  };

  const cancel = async (id: string) => {
    if (!current() || busy) return;
    setBusy(true); setMsg(null);
    const r = await api<{ ok: true }>('POST', `/api/hosts/me/payouts/${encodeURIComponent(id)}/cancel`, undefined, undefined, current);
    if (!current()) return;
    setBusy(false);
    if (!r.ok) setMsg({ tone: 'err', text: r.message || 'We could not cancel that.' });
    await load(); if (current()) onChanged?.();
  };

  return (
    <section className="hfc-card" aria-labelledby="hfc-wd">
      <h2 id="hfc-wd">Withdraw your earnings</h2>
      <div className="hfc-stats">
        <div className="hfc-stat"><strong>{inr(info.withdrawable)}</strong><span>you can withdraw now</span></div>
        <div className="hfc-stat"><strong>{inr(info.held)}</strong><span>held for {info.holdDays} days</span></div>
        <div className="hfc-stat"><strong>{inr(info.testEarnings)}</strong><span>from test credits. Test earnings can’t be withdrawn.</span></div>
      </div>
      {info.bank ? (
        <p className="hfc-sub" style={{ margin: '8px 0' }}>Paid to your bank account ending {info.bank.accountLast4}{info.bank.ifsc ? ` (${info.bank.ifsc})` : ''}.</p>
      ) : info.enabled ? (
        <p className="hfc-sub" style={{ margin: '8px 0' }}><a href="/hosts/onboarding?step=payout">Add your bank account</a> to withdraw.</p>
      ) : null}
      {blocker && <p className="hfc-sub" role="status" style={{ margin: '8px 0' }}>{blocker}{!info.enabled ? '' : (!info.kycOk || !info.bankOk) ? <> <a href="/hosts/onboarding?step=payout">Continue</a></> : ''}</p>}
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: '.9rem' }}>
          Amount in rupees{info.minRupees > 0 ? ` (at least ${inr(info.minRupees)})` : ' (no minimum)'}
          <input inputMode="numeric" autoComplete="off" value={amount} disabled={!!blocker || busy} onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 7))}
            style={{ minHeight: 44, padding: '8px 10px', fontSize: 16, borderRadius: 10, border: '1px solid #c8afd1', width: 180 }} />
        </label>
        <button type="submit" className="hfc-btn hfc-primary" disabled={!!blocker || busy || !validAmount}>{busy ? 'Sending…' : 'Request withdrawal'}</button>
        {!blocker && info.withdrawable >= minR && <button type="button" className="hfc-btn" disabled={busy} onClick={() => setAmount(String(info.withdrawable))}>All {inr(info.withdrawable)}</button>}
      </form>
      {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={msg.tone === 'err' ? 'hfc-err' : 'hfc-sub'} style={{ margin: '8px 0' }}>{msg.text}</p>}
      <p className="hfc-sub" style={{ margin: '8px 0', color: '#785979', fontSize: '.875rem' }}>
        Earnings can be withdrawn {info.holdDays} days after the call. We pay it to your UPI or bank and send you the payment reference. You can ask for up to {info.maxPerWeek} withdrawals a week.
      </p>
      {info.requests.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', margin: '12px 0 6px' }}>Your requests</h3>
          <ul className="hfc-calls">
            {info.requests.map((r) => (
              <li key={r.id}>
                <strong>{inr(r.amount)}</strong>
                <span>{STATUS_TEXT[r.status]}{r.status === 'paid' && r.utr ? ` · Bank reference ${r.utr}` : ''}{r.status === 'rejected' && r.reason ? ` · ${r.reason}` : ''}</span>
                <small>{relDate(r.paidAt ?? r.createdAt)}</small>
                {r.status === 'requested' && <button type="button" className="hfc-btn" disabled={busy} onClick={() => void cancel(r.id)}>Cancel</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
