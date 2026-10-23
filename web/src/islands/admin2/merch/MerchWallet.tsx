/* MerchWallet — [HF-MERCH-ADMIN-1] Platform wallet for influencer merch: month totals, by influencer, every ledger row, CSV.
 * Worker: GET /api/admin/merch/platform-wallet?month=YYYY-MM[&format=csv]. Months are IST. */
import { useCallback, useEffect, useState } from 'react';
import { adminBlob, saveBlob } from '../adminApi';
import { Banner, adminCall, click, dateIST, fail, money, usePageView } from './merchKit';
import MerchGstPanel from './MerchGstPanel';

/** gstPaise = net GST (collected − Printrove credit, plus old-style estimates on old orders) [HF-MERCH-GST-1]. */
interface Totals { sharePaise: number; cashfeePaise: number; gstPaise: number; outputGstPaise: number; inputGstPaise: number; netPaise: number; printroveOwedPaise: number; refundsPaise: number }
interface Res {
  month: string; totals: Totals;
  bySeller: Array<Totals & { sellerUid: string | null; slug: string | null; displayName: string | null }>;
  rows: Array<{ id: string | number; kind: string; amountPaise: number; orderId: string | null; sellerUid: string | null; note: string | null; createdAt: number }>;
}
const KIND: Record<string, string> = {
  merch_share: 'Platform share', printrove_cost: 'Owed to Printrove', cashfree_fee: 'Cashfree fee (est.)', gst: 'GST (old estimate)',
  gst_output: 'GST collected from the fan', gst_input: 'Printrove GST claimed back',
  refund_share: 'Share given back', refund_printrove_cost: 'Printrove cost reversed', refund_cashfree_fee: 'Cashfree fee reversed', refund_gst: 'GST reversed',
  refund_gst_output: 'GST collected, reversed', refund_gst_input: 'Printrove GST claim, reversed', refund_after_hold: 'Influencer earning absorbed',
};
const nowMonth = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 7);

export default function MerchWallet() {
  usePageView('wallet');
  const [month, setMonth] = useState(nowMonth());
  const [data, setData] = useState<Res | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    setError(null);
    try { setData(await adminCall<Res>('/api/admin/merch/platform-wallet', { query: { month } })); } catch (e) { setError(fail('merch_wallet_load', e, { month })); setData(null); }
  }, [month]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const csv = async () => {
    click('merch_wallet_csv_clicked', { month });
    setBusy(true); setError(null);
    try { const r = await adminBlob(`/api/admin/merch/platform-wallet?month=${encodeURIComponent(month)}&format=csv`); saveBlob(r.blob, r.filename ?? `merch-platform-${month}.csv`); }
    catch (e) { setError(fail('merch_wallet_csv', e, { month })); }
    setBusy(false);
  };
  const t = data?.totals;
  return (
    <div className="hfa-stack">
      <div className="mx-acts">
        <label style={{ fontWeight: 800 }}>Month <input className="mx-in" style={{ width: 'auto' }} type="month" value={month} max={nowMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <button type="button" className="hfa-btn ghost" onClick={() => void load()}>Refresh</button>
        <button type="button" className="hfa-btn gold" disabled={busy || !data} onClick={() => void csv()}>{busy ? 'Preparing…' : 'Download CSV'}</button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {!data && !error && <p className="mx-empty" role="status">Loading…</p>}
      {t && (
        <>
          <div className="mx-tiles">
            <div className="mx-tile"><b>Platform share</b><span>{money(t.sharePaise)}</span></div>
            <div className="mx-tile"><b>Cashfree fees (est.)</b><span>{money(t.cashfeePaise)}</span></div>
            <div className="mx-tile"><b>GST collected</b><span>{money(t.outputGstPaise)}</span></div>
            <div className="mx-tile"><b>Printrove GST claimed back</b><span>{money(t.inputGstPaise)}</span></div>
            <div className="mx-tile"><b>Net GST to pay</b><span>{money(t.gstPaise)}</span></div>
            <div className="mx-tile"><b>Net after fees</b><span>{money(t.netPaise)}</span></div>
            <div className="mx-tile"><b>Printrove is owed</b><span>{money(t.printroveOwedPaise)}</span></div>
            <div className="mx-tile"><b>Refunds taken back</b><span>{money(t.refundsPaise)}</span></div>
          </div>
          <MerchGstPanel month={month} />
          <section>
            <h2 className="mx-h">By influencer</h2>
            {data.bySeller.length === 0 ? <p className="mx-empty">No merch activity this month.</p> : (
              <div className="mx-scroll"><table className="mx-table">
                <thead><tr><th>Influencer</th><th className="n">Share</th><th className="n">Cashfree</th><th className="n">Net GST</th><th className="n">Net</th><th className="n">Printrove</th><th className="n">Refunds</th></tr></thead>
                <tbody>{data.bySeller.map((s) => (
                  <tr key={s.sellerUid ?? 'none'}><td>{s.displayName ?? s.slug ?? s.sellerUid ?? '—'}</td><td className="n">{money(s.sharePaise)}</td><td className="n">{money(s.cashfeePaise)}</td><td className="n">{money(s.gstPaise)}</td><td className="n">{money(s.netPaise)}</td><td className="n">{money(s.printroveOwedPaise)}</td><td className="n">{money(s.refundsPaise)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section>
            <h2 className="mx-h">Every entry ({data.rows.length})</h2>
            {data.rows.length === 0 ? <p className="mx-empty">No entries.</p> : (
              <div className="mx-scroll"><table className="mx-table">
                <thead><tr><th>When (IST)</th><th>What</th><th className="n">Amount</th><th>Order</th><th>Note</th></tr></thead>
                <tbody>{data.rows.map((r) => (
                  <tr key={r.id}><td>{dateIST(r.createdAt)}</td><td>{KIND[r.kind] ?? r.kind}</td><td className="n">{money(r.amountPaise)}</td>
                    <td>{r.orderId ? r.orderId.slice(-8) : '—'}</td><td>{r.note ?? ''}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
