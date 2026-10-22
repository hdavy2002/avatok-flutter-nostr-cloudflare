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
import { DesiKpi, DesiKpis } from '../desi';
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
      {page !== 'orders' && (
        <DesiKpis className="sh-kpis-desi">
          <DesiKpi tone="plum" label="Orders today" value={kpis ? kpis.orders_today : '—'} sub={kpis ? `${diff < 0 ? '−' : '+'}${Math.abs(diff)} vs yesterday` : ' '} alert={!!kpis && diff < 0} />
          <DesiKpi tone="rani" label="Revenue (30 days)" value={kpis ? inr(kpis.revenue_30d_rupees) : '—'} sub={kpis ? `${kpis.orders_30d} orders` : ' '} />
          <DesiKpi tone="gold" label="To ship" value={kpis ? kpis.to_ship : '—'} sub={kpis ? `${kpis.stale_48h} older than 48h` : ' '} />
          <DesiKpi tone="lav" label="To send to Printrove" value={kpis ? kpis.to_print : '—'} sub="paid, not placed yet" />
        </DesiKpis>
      )}

      {page === 'orders' && <OrdersPanel kpis={kpis} onChanged={() => void refreshKpis()} />}
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
