/* ShopAdmin — [SAATHUM-SHOP-ADMIN-1 2026-10-01] One island for all six /admin/shop screens.
 * The Admin2 layout supplies the heading ("Shop" + subtitle) and the red "+ Add product" button
 * (ShopLayout.astro → fires `shop-admin:add-product`); this component renders the four KPI tiles
 * on every page and then the page's panel, exactly as the approved mockup ("Admin: Shop").
 * Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §4.4, §4.5, §5.5. No Clerk provider here:
 * AdminNav owns it, all calls go through adminApi() (see shopApi.ts). */
import { useCallback, useEffect, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { announceToPrint, getKpis, inr, type Kpis } from './shopApi';
import OrdersPanel from './OrdersPanel';
import ProductsPanel from './ProductsPanel';
import CollectionsPanel from './CollectionsPanel';
import PromotePanel from './PromotePanel';
import CouponsPanel from './CouponsPanel';
import SettingsPanel from './SettingsPanel';
import ProductModal from './ProductModal';
import './shopAdmin.css';

export type ShopPage = 'orders' | 'products' | 'collections' | 'promote' | 'coupons' | 'settings';

export default function ShopAdmin({ page }: { page: ShopPage }) {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [rev, setRev] = useState(0); // bumps when a product is saved from the header modal
  const [addOpen, setAddOpen] = useState(false);

  const refreshKpis = useCallback(async () => {
    try {
      const k = await getKpis();
      setKpis(k);
      announceToPrint(k.to_print);
    } catch (e) {
      captureException(e, { where: 'admin2_shop_kpis' });
    }
  }, []);

  useEffect(() => { void refreshKpis(); }, [refreshKpis]);

  useEffect(() => {
    const open = () => setAddOpen(true);
    window.addEventListener('shop-admin:add-product', open);
    return () => window.removeEventListener('shop-admin:add-product', open);
  }, []);

  const diff = kpis ? kpis.orders_today - kpis.orders_yesterday : 0;

  return (
    <div className="shop-admin" data-shop-page={page}>
      {page === 'orders' ? (
        /* [AUMFE-POD-FULFIL-1] Orders mockup tiles (Specs/studio-mockup/Orders.dc.html). */
        <div className="sh-kpis">
          <div className="sh-kpi"><small>Paid, ready to send</small><b>{kpis ? kpis.to_print : '—'}</b><em style={{ color: '#6b4a00' }}>bank confirmed</em></div>
          <div className="sh-kpi"><small>Waiting for bank</small><b>{kpis ? (kpis.waiting_bank ?? 0) : '—'}</b><em style={{ color: '#6b4a2b' }}>customer says paid</em></div>
          <div className="sh-kpi"><small>At Printrove</small><b>{kpis ? (kpis.at_printer ?? kpis.to_ship) : '—'}</b><em style={{ color: '#6b4a2b' }}>printing or packed</em></div>
          <div className="sh-kpi"><small>Shipped this week</small><b>{kpis ? (kpis.shipped_7d ?? 0) : '—'}</b><em>tracking sent</em></div>
        </div>
      ) : (
      <div className="sh-kpis">
        <div className="sh-kpi"><small>Orders today</small><b>{kpis ? kpis.orders_today : '—'}</b>
          <em style={diff < 0 ? { color: '#9b1c14' } : undefined}>{kpis ? `${diff < 0 ? '−' : '+'}${Math.abs(diff)} vs yesterday` : ' '}</em></div>
        <div className="sh-kpi"><small>Revenue (30 days)</small><b>{kpis ? inr(kpis.revenue_30d_rupees) : '—'}</b><em>{kpis ? `${kpis.orders_30d} orders` : ' '}</em></div>
        <div className="sh-kpi"><small>To ship</small><b>{kpis ? kpis.to_ship : '—'}</b><em style={{ color: '#9b1c14' }}>{kpis ? `${kpis.stale_48h} older than 48h` : ' '}</em></div>
        <div className="sh-kpi"><small>To send to Printrove</small><b>{kpis ? kpis.to_print : '—'}</b><em style={{ color: '#7a5a00' }}>paid, not placed yet</em></div>
      </div>
      )}

      {page === 'orders' && <OrdersPanel onChanged={() => void refreshKpis()} />}
      {page === 'products' && <ProductsPanel rev={rev} />}
      {page === 'collections' && <CollectionsPanel />}
      {page === 'promote' && <PromotePanel />}
      {page === 'coupons' && <CouponsPanel />}
      {page === 'settings' && <SettingsPanel />}

      <ProductModal
        open={addOpen}
        product={null}
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); setRev((n) => n + 1); }}
      />
    </div>
  );
}
