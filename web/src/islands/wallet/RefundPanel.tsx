/* [HF-WALLET-EXIT-1] "Request a refund" card on /wallet. [HF-WIRE-16] Refunds land in the WALLET only (HF-REEL-35); money leaves by Withdraw to UPI.
 * While card refunds are off the worker answers {enabled:false, walletOnly:true}: show a short note with a Withdraw link instead of a form.
 * Hidden completely (renders nothing) when the worker is unreachable. */
import { useEffect, useState } from 'react';
import { relDate } from '../../lib/hfCallsApi';
import { formatPaise } from '../../lib/money';

// [HF-STD-PLAN-1] Amounts here are rupees (maybe fractional): always two decimals, Indian grouping.
const money = (n: number) => formatPaise(Math.round(n * 100));
import { fetchRefunds, requestRefund, cancelRefund, walletExitMessage, walletExitCode, PAYOUT_HREF, type RefundInfo } from '../../lib/hfWalletExitApi';

const LABEL: Record<string, string> = { requested: 'Waiting for approval', processing: 'Being sent back', refunded: 'Sent back', rejected: 'Not processed', cancelled: 'Cancelled' };

export default function RefundPanel({ onChanged }: { onChanged?: () => void }) {
  const [info, setInfo] = useState<RefundInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = () => fetchRefunds().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { void load(); }, []);

  if (!info) return null;
  if (!info.enabled) {
    if (!info.walletOnly) return null;
    return (
      <section className="hfc-card" aria-labelledby="hfr-h">
        <h2 id="hfr-h">Refunds and withdrawals</h2>
        <p className="hfc-sub" style={{ margin: 0 }}>Every refund goes to your wallet, never back to your card or UPI. To take money out, use Withdraw: it pays to your UPI after a one-time ID and UPI check. Test credits cannot be withdrawn.</p>
        <a className="hfc-btn hfc-primary" href={PAYOUT_HREF}>Go to Withdraw</a>
      </section>
    );
  }
  const refundable = info.refundable ?? 0;
  const open = info.requests.some(r => r.status === 'requested' || r.status === 'processing');

  async function ask() {
    setBusy(true); setMsg(null);
    try { const r = await requestRefund(); setMsg({ kind: 'ok', text: `Refund of ${money(r.amount)} requested. It will be credited to your wallet once a person approves it.` }); await load(); onChanged?.(); }
    catch (e) { setMsg({ kind: 'err', text: walletExitMessage(e) }); if (walletExitCode(e) === 'refund_to_wallet_only') await load(); }
    setBusy(false);
  }
  async function cancel(id: string) {
    setBusy(true); setMsg(null);
    try { await cancelRefund(id); await load(); onChanged?.(); }
    catch (e) { setMsg({ kind: 'err', text: walletExitMessage(e) }); }
    setBusy(false);
  }

  return (
    <section className="hfc-card" aria-labelledby="hfr-h">
      <h2 id="hfr-h">Request a refund</h2>
      <div className="hfc-stats" style={{ gridTemplateColumns: '1fr' }}>
        <div className="hfc-stat"><strong>{money(refundable)}</strong><span>can be refunded now</span></div>
      </div>
      <p className="hfc-sub" style={{ margin: 0 }}>
        Unused money you added is credited to your wallet, never to your card or UPI, after a person approves it. Only the part you have not used can be refunded. Money already used on calls and test credits cannot be refunded. To take money out, use the Withdraw button.
      </p>
      <button type="button" className="hfc-btn hfc-primary" disabled={busy || refundable <= 0 || open} onClick={() => void ask()}>
        {busy ? 'Working…' : refundable > 0 ? `Request ${money(refundable)} back` : 'Nothing to refund'}
      </button>
      {open && <p className="hfc-sub" style={{ margin: 0 }}>You already have a refund in progress.</p>}
      {msg && <p role="status" className={msg.kind === 'err' ? 'hfc-err' : 'hfc-note'} style={{ margin: 0 }}>{msg.text}</p>}
      {info.requests.length > 0 && (
        <ul className="hfc-calls">
          {info.requests.map(r => (
            <li key={r.id}>
              <strong>{money(r.amount)} · {LABEL[r.status] ?? r.status}</strong>
              <span>{r.status === 'rejected' && r.reason ? r.reason : r.status === 'refunded' && r.utr ? `Reference ${r.utr}` : ''}</span>
              <small>{relDate(r.createdAt)}</small>
              {r.status === 'requested' && !r.exit && <button type="button" className="hfc-btn" disabled={busy} onClick={() => void cancel(r.id)}>Cancel</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
