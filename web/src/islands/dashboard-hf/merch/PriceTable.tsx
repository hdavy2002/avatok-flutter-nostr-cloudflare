/* [HF-MERCH-PRICE-LABELS-1] One per-size price table for the influencer screens (studio step 4 and the edit-markup dialog).
 * Printing (incl. GST) + Shipping = Base (rounded up to a whole rupee); Fan pays = Base + markup, all-in. Money is integer paise. */
import { fanPaysPaise, inclGst, rupees, youEarnPaise } from './api';

export interface PriceRow { size: string; printingPaise: number; shippingPaise: number; basePaise: number; maxMarkupRupees?: number }

export function PriceTable({ rows, markup, okMarkup, shareBps, loading = false, label = 'Price per size', gstBps }: {
  rows: PriceRow[]; markup: number; okMarkup: boolean; shareBps: number; loading?: boolean; label?: string; gstBps?: number;
}) {
  const earn = youEarnPaise(markup, shareBps);
  return <div className="mc-scroll" tabIndex={0} role="region" aria-label={label}>
    <table className="mc-sizes mc-sizes-wide"><thead><tr>
      <th>Size</th><th>Printing (incl. GST)</th><th>Shipping</th><th>Base</th><th>Your markup</th><th>Fan pays ({inclGst(gstBps)} &amp; delivery)</th><th>You earn (royalty)</th>
    </tr></thead><tbody>
      {rows.map(r => <tr key={r.size}>
        <td>{r.size}</td>
        <td>{loading ? '…' : rupees(r.printingPaise)}</td>
        <td>{loading ? '…' : rupees(r.shippingPaise)}</td>
        <td>{loading ? '…' : rupees(r.basePaise)}</td>
        <td>{okMarkup ? rupees(markup * 100) : '—'}</td>
        <td><b>{okMarkup && !loading ? rupees(fanPaysPaise(r.basePaise, markup)) : '—'}</b></td>
        <td className="mc-earn">{okMarkup ? rupees(earn) : '—'}</td>
      </tr>)}
    </tbody></table>
  </div>;
}

/** Footnote under the table. The share and hold days come from the values the screen already reads. */
export function PriceNote({ shareBps, holdDays }: { shareBps: number; holdDays: number }) {
  return <p className="small muted">Base = printing (incl. GST) + delivery. Fans pay one all-in price: base + your markup, including GST and free delivery. Your design royalty is {Math.round((10_000 - shareBps) / 100)}% of your markup, withdrawable {holdDays} days after delivery.</p>;
}
