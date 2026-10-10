/* [HF-WALLET-EXIT-1] "Request a refund" card on /wallet: unused top-up money goes back to the ORIGINAL payment after a person approves it.
 * Hidden completely (renders nothing) while hfRefundsEnabled is off or the worker is unreachable. */
import { useEffect, useState } from 'react';
import { inr, relDate } from '../../lib/hfCallsApi';

// Token mode amounts are fractional rupees (paise), so show them with two decimals when needed.
const inr2 = (n: number) => (Number.isInteger(n) ? inr(n) : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
import { fetchRefunds, requestRefund, cancelRefund, walletExitMessage, type RefundInfo } from '../../lib/hfWalletExitApi';

const LABEL: Record<string, string> = { requested: 'Waiting for approval', processing: 'Being sent back', refunded: 'Sent back', rejected: 'Not processed', cancelled: 'Cancelled' };

export default function RefundPanel({ onChanged }: { onChanged?: () => void }) {
  const [info, setInfo] = useState<RefundInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = () => fetchRefunds().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { void load(); }, []);

  if (!info || !info.enabled) return null;
  const tokens = info.mode === 'tokens';
  const money = tokens ? inr2 : inr;
  const refundable = info.refundable ?? 0;
  const open = info.requests.some(r => r.status === 'requested' || r.status === 'processing');

  async function ask() {
    setBusy(true); setMsg(null);
    try { const r = await requestRefund(); setMsg({ kind: 'ok', text: `Refund of ${money(r.amount)} requested. ${tokens ? 'We will send it back through Google Play once a person approves it.' : 'We will send it back to the payment you used.'}` }); await load(); onChanged?.(); }
    catch (e) { setMsg({ kind: 'err', text: walletExitMessage(e) }); }
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
        {tokens
          ? `Unused tokens you bought go back through Google Play, after a person approves it. Each purchase can be refunded for ${info.windowDays ?? 180} days after you bought it, and only the tokens you have not used. Tokens already used on calls and test credits cannot be refunded. Host earnings are withdrawn from the host dashboard instead.`
          : `Unused money you added goes back to the payment you used, after a person approves it. Each top-up can be refunded for ${info.windowDays ?? 180} days after you paid, and only the part you have not spent. Money already spent on calls and test credits cannot be refunded. Host earnings are withdrawn from the host dashboard instead.`}
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
