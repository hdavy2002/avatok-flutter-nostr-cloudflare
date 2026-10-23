/* MerchGstPanel — [HF-MERCH-GST-1] Month GST for influencer merch: GST collected, Printrove input credit, net payable, per-order table, CSV.
 * We (the platform) are the seller, so every fan price has GST inside it (the order's frozen category rate: clothing 5%, other categories as set in admin) and Printrove's GST is claimed back.
 * Worker: GET /api/admin/merch/gst-report?month=YYYY-MM[&format=csv]. Months are IST. Cancelled / refunded orders are listed but not added to the totals. */
import { useCallback, useEffect, useState } from 'react';
import { adminBlob, saveBlob } from '../adminApi';
import { Banner, adminCall, click, dateIST, fail, money } from './merchKit';

interface GstTotals { orders: number; cancelledOrders: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; gstCollectedPaise: number; totalPaise: number; inputGstPaise: number; netPayablePaise: number }
interface GstRow {
  orderId: string; orderNo: string; date: number; invoiceNo: string | null; buyerState: string; buyerStateCode: string | null; taxablePaise: number; cgstPaise: number; sgstPaise: number;
  igstPaise: number; totalPaise: number; inputGstPaise: number; rateBps: number; hsn: string; cancelled: boolean;
}
interface GstByRate { rateBps: number; orders: number; taxablePaise: number; gstPaise: number; inputGstPaise: number }
interface GstRes { month: string; gstinConfigured: boolean; supplierStateCode: string | null; gstRateBps: number; hsn: string; totals: GstTotals; byRate: GstByRate[]; orders: GstRow[] }

export default function MerchGstPanel({ month }: { month: string }) {
  const [data, setData] = useState<GstRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    setError(null);
    try { setData(await adminCall<GstRes>('/api/admin/merch/gst-report', { query: { month } })); } catch (e) { setError(fail('merch_gst_load', e, { month })); setData(null); }
  }, [month]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const csv = async () => {
    click('merch_gst_csv_clicked', { month });
    setBusy(true); setError(null);
    try { const r = await adminBlob(`/api/admin/merch/gst-report?month=${encodeURIComponent(month)}&format=csv`); saveBlob(r.blob, r.filename ?? `merch-gst-${month}.csv`); }
    catch (e) { setError(fail('merch_gst_csv', e, { month })); }
    setBusy(false);
  };
  const t = data?.totals;
  return (
    <section aria-label="GST">
      <h2 className="mx-h">GST for {month}</h2>
      {error && <Banner tone="error">{error}</Banner>}
      {!data && !error && <p className="mx-empty" role="status">Loading GST…</p>}
      {data && !data.gstinConfigured && <Banner tone="warn">Our GSTIN is not saved yet, so fans are getting receipts, not tax invoices. The split below is still worked out so nothing is lost.</Banner>}
      {t && (
        <>
          <div className="mx-tiles">
            <div className="mx-tile"><b>GST collected from fans</b><span>{money(t.gstCollectedPaise)}</span></div>
            <div className="mx-tile"><b>Printrove GST claimed back</b><span>{money(t.inputGstPaise)}</span></div>
            <div className="mx-tile"><b>Net GST to pay</b><span>{money(t.netPayablePaise)}</span></div>
          </div>
          <p className="hfa-note">{t.orders} sale{t.orders === 1 ? '' : 's'} · taxable {money(t.taxablePaise)} · CGST {money(t.cgstPaise)} · SGST {money(t.sgstPaise)} · IGST {money(t.igstPaise)} · total {money(t.totalPaise)}{t.cancelledOrders ? ` · ${t.cancelledOrders} cancelled order${t.cancelledOrders === 1 ? '' : 's'} not counted (issue a credit note by hand if an invoice went out)` : ''}</p>
          {data && data.byRate.length > 0 && (
            <p className="hfa-note">By GST rate: {data.byRate.map((g) => `${g.rateBps / 100}% — ${g.orders} sale${g.orders === 1 ? '' : 's'}, taxable ${money(g.taxablePaise)}, GST ${money(g.gstPaise)}, Printrove credit ${money(g.inputGstPaise)}`).join(' · ')}</p>
          )}
          <div className="mx-acts">
            <button type="button" className="hfa-btn gold" disabled={busy} onClick={() => void csv()}>{busy ? 'Preparing…' : 'Download GST CSV'}</button>
          </div>
          {data && data.orders.length > 0 && (
            <div className="mx-scroll"><table className="mx-table">
              <thead><tr><th>Date</th><th>Invoice</th><th>Order</th><th>Buyer state</th><th>GST / HSN</th><th className="n">Taxable</th><th className="n">CGST</th><th className="n">SGST</th><th className="n">IGST</th><th className="n">Total</th><th className="n">Printrove GST</th></tr></thead>
              <tbody>{data.orders.map((r) => (
                <tr key={r.orderId} style={r.cancelled ? { opacity: 0.55 } : undefined}>
                  <td>{dateIST(r.date)}</td><td>{r.invoiceNo ?? '—'}</td><td>{r.orderNo}{r.cancelled ? ' (cancelled)' : ''}</td><td>{r.buyerState || '—'}{r.buyerStateCode ? ` (${r.buyerStateCode})` : ''}</td><td>{r.rateBps / 100}% · {r.hsn || 'HSN to confirm'}</td>
                  <td className="n">{money(r.taxablePaise)}</td><td className="n">{money(r.cgstPaise)}</td><td className="n">{money(r.sgstPaise)}</td><td className="n">{money(r.igstPaise)}</td>
                  <td className="n">{money(r.totalPaise)}</td><td className="n">{money(r.inputGstPaise)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {data && data.orders.length === 0 && <p className="mx-empty">No paid merch orders this month.</p>}
        </>
      )}
    </section>
  );
}
