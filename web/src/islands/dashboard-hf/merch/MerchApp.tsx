/* [HF-MERCH-CREATOR-WEB-1] The "Merch" screen of the influencer dashboard (/dashboard/merch): summary strip, Products, Orders and the new-product wizard.
 * Worker: /api/hf/merch/* (routes/hf_merch.ts). Shown only to live hosts and only while /api/config hfMerchEnabled is true. */
import { useCallback, useEffect, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { Failed, Ic, PageHead, Sticker } from '../v3/ui';
import './merch.css';
import OrdersTab from './OrdersTab';
import ProductsTab from './ProductsTab';
import Wizard from './Wizard';
import ShareMyPage from '../share/ShareMyPage'; // [HF-SHARE-WEB-1]
import { getCatalog, getSummary, merchConfig, rupees, type CatalogInfo, type Summary } from './api';

type Tab = 'products' | 'orders';

export default function MerchApp() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') === 'orders' ? 'orders' : 'products'));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sumFailed, setSumFailed] = useState(false);
  const [wizard, setWizard] = useState<CatalogInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [minMarkup, setMinMarkup] = useState(10);
  const [shareBps, setShareBps] = useState(4000);
  const [key, setKey] = useState(0);

  useEffect(() => { void merchConfig().then(c => setMinMarkup(c.minMarkupRupees)); }, []);
  const loadSummary = useCallback(() => {
    void getSummary().then(r => {
      if (r.ok) { setSummary(r.data); setSumFailed(false); }
      else { setSumFailed(true); if (r.status !== 401) captureException(new Error(`merch_summary_${r.status}_${r.code}`), { area: 'hf_merch_creator', part: 'summary' }); }
    });
  }, []);
  useEffect(loadSummary, [loadSummary]);

  async function openWizard() {
    if (opening) return;
    setOpening(true); setOpenErr(null);
    const r = await getCatalog();
    setOpening(false);
    if (r.ok) { setShareBps(r.data.platformShareBps); setMinMarkup(r.data.minMarkupRupees); setWizard(r.data); }
    else { setOpenErr(r.message || 'The shirt list is not available right now. Please try again in a little while.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_catalog_${r.status}_${r.code}`), { area: 'hf_merch_creator' }); }
  }
  // Share of the markup for the edit dialog even before the wizard is opened.
  useEffect(() => { void getCatalog().then(r => { if (r.ok) setShareBps(r.data.platformShareBps); }); }, []);

  const s = summary;
  return <>
    <PageHead eyebrow="Merch" title="Your T-shirt shop" sub="Put your art on a shirt, set your price, and your fans buy it from your page. We print and ship it, you earn on every sale." art={<Sticker name="swag" w={104} rot={6} />} />
    <ShareMyPage variant="row" />
    {sumFailed && <Failed onRetry={loadSummary} text="We could not load your numbers." />}
    <section className="mc-strip" aria-label="Summary">
      <div className="mc-stat"><span className="small muted">Products</span><span className="num">{s ? s.products.live : '—'} live</span><span className="small muted">{s ? `${s.products.pending} waiting for review` : ''}</span></div>
      <div className="mc-stat"><span className="small muted">New orders</span><span className="num">{s ? s.orders.new : '—'}</span><span className="small muted">{s ? `${s.orders.processing} processing · ${s.orders.shipped} shipped` : ''}</span></div>
      <div className="mc-stat"><span className="small muted">Earnings coming</span><span className="num">{s ? rupees(s.earnings.pendingPaise) : '—'}</span><span className="small muted">Delivered orders unlock after the hold</span></div>
      <div className="mc-stat"><span className="small muted">Ready to withdraw</span><span className="num">{s ? rupees(s.earnings.availablePaise) : '—'}</span><a className="h3-link small" href="/dashboard/host/earnings">Earnings & withdrawals →</a></div>
    </section>

    {wizard ? <Wizard info={wizard} minMarkup={minMarkup} onClose={() => setWizard(null)} onPublished={() => { setWizard(null); setTab('products'); setKey(k => k + 1); loadSummary(); }} /> :
      <section className="h3-card">
        <div className="top">
          <div className="h3-tabs" style={{ marginBottom: 0 }} role="tablist">{([['products', 'Products'], ['orders', 'Orders']] as [Tab, string][]).map(([k, l]) =>
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'orders' && s && s.orders.new ? ` (${s.orders.new})` : ''}</button>)}</div>
          <button type="button" className="h3-btn rani mc-big" disabled={opening} onClick={() => void openWizard()}><Ic name="plus" className="" />{opening ? 'Opening…' : 'New product'}</button>
        </div>
        {openErr && <p className="mc-err" role="alert" style={{ marginBottom: 10 }}>{openErr}</p>}
        {tab === 'products'
          ? <ProductsTab key={key} shareBps={shareBps} minMarkup={minMarkup} onNew={() => void openWizard()} onChanged={loadSummary} />
          : <OrdersTab counts={s ? { new: s.orders.new, processing: s.orders.processing, shipped: s.orders.shipped, delivered: s.orders.delivered } : {}} />}
      </section>}
  </>;
}
