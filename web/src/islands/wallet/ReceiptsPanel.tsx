/* [HF-WALLET-LIMITS-1] "Receipts" card on /wallet: every paid top-up has a numbered receipt; once GST invoicing is on, monthly tax invoices appear here too.
 * "View / print" opens the printable page in a new tab. */
import { useEffect, useState } from 'react';
import { inr } from '../../lib/hfCallsApi';
import { fetchReceipts, openReceipt, type ReceiptItem } from '../../lib/hfReceiptsApi';

const day = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

export default function ReceiptsPanel({ reloadKey = 0 }: { reloadKey?: number }) {
  const [items, setItems] = useState<ReceiptItem[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchReceipts().then(r => { if (live) setItems(r.ok ? r.data.receipts : []); });
    return () => { live = false; };
  }, [reloadKey]);

  if (items === null || items.length === 0) return null; // nothing to show until the first paid top-up

  const view = async (id: string) => {
    setMsg(null); setBusy(id);
    const ok = await openReceipt(id);
    setBusy(null);
    if (!ok) setMsg('We could not open the receipt. Please allow pop-ups for this site and try again.');
  };

  return (
    <section className="hfc-card" aria-labelledby="hfw-rcpt">
      <h2 id="hfw-rcpt">Receipts</h2>
      <ul className="hfc-calls">
        {items.map(r => (
          <li key={r.id}>
            <strong>{r.number}</strong>
            <span>{inr(r.amountRupees)}</span>
            <small>{r.kind === 'tax_invoice' ? 'Tax invoice' : r.source === 'play_purchase' ? 'Purchase record, paid via Google Play' : 'Payment receipt'} · {day(r.issuedAt)}</small>
            <button type="button" className="hfc-btn" style={{ minHeight: 44 }} disabled={busy === r.id} onClick={() => view(r.id)}>{busy === r.id ? 'Opening…' : 'View / print'}</button>
          </li>
        ))}
      </ul>
      {msg && <p role="status" className="hfc-err" style={{ margin: 0 }}>{msg}</p>}
    </section>
  );
}
