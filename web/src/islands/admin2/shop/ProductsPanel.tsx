/* ProductsPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/products — the mockup's "Products"
 * panel: status tabs, table (Product / Collection / Price / Sizes / Promoted on / Status / Actions)
 * with Edit · Promote · Delete (archives for 30 days) and Restore on archived rows, plus the
 * mockup's Delete and Promote modals. API (spec §4.4): GET products?status=, DELETE products/:id,
 * POST products/:id/restore, PUT products/:id/promote {slots,badge}. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Modal, Thumb } from './ShopUI';
import ProductModal from './ProductModal';
import {
  SLOTS, archiveProduct, errMessage, inr, listProducts, promoteProduct, restoreProduct, setProductFlags, slotShort,
  type AdminProduct, type Badge, type ProductStatus,
} from './shopApi';

const TABS: { f: 'all' | ProductStatus; label: string }[] = [
  { f: 'all', label: 'All' }, { f: 'live', label: 'Live' }, { f: 'draft', label: 'Draft' }, { f: 'hidden', label: 'Hidden' }, { f: 'archived', label: 'Archived' },
];
const CHIP: Record<ProductStatus, { cls: string; label: string }> = {
  live: { cls: 'st-delivered', label: 'Live' }, draft: { cls: 'st-pending', label: 'Draft' },
  hidden: { cls: 'st-packed', label: 'Hidden' }, archived: { cls: 'st-cancelled', label: 'Archived' },
};

export default function ProductsPanel({ rev }: { rev: number }) {
  const [tab, setTab] = useState<'all' | ProductStatus>('all');
  const [items, setItems] = useState<AdminProduct[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<AdminProduct | null>(null);
  const [del, setDel] = useState<AdminProduct | null>(null);
  const [promo, setPromo] = useState<AdminProduct | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await listProducts(tab);
      setItems(r.items); setCounts(r.counts ?? {});
    } catch (e) {
      captureException(e, { where: 'admin2_shop_products_load' });
      setError(errMessage(e, 'Could not load the products.'));
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { void load(); }, [load, rev]);

  /** [SAATHUM-SHOP-EDITOR-2] One click flips New arrival / Bestseller (these two flags are what the shop home's rows show). */
  async function flip(p: AdminProduct, key: 'is_new' | 'is_bestseller') {
    const next = !p[key];
    setItems((cur) => cur.map((x) => (x.id === p.id ? { ...x, [key]: next } : x)));
    try {
      const r = await setProductFlags(p.id, { [key]: next });
      if (r.warning) { toast.error(r.warning); void load(); return; }
      toast.success(next ? (key === 'is_new' ? 'Added to New arrivals' : 'Marked as Bestseller') : (key === 'is_new' ? 'Removed from New arrivals' : 'No longer a Bestseller'));
    } catch (e) {
      captureException(e, { where: 'admin2_shop_product_flag', key });
      toast.error(errMessage(e, 'Could not change it.'));
      setItems((cur) => cur.map((x) => (x.id === p.id ? { ...x, [key]: !next } : x)));
    }
  }

  async function restore(p: AdminProduct) {
    try { await restoreProduct(p.id); toast.success(`“${p.name}” restored as a draft`); void load(); }
    catch (e) { captureException(e, { where: 'admin2_shop_product_restore' }); toast.error(errMessage(e, 'Could not restore it.')); }
  }

  return (
    <div className="sh-apanel is-on" data-apanel="products">
      <div className="sh-tabs">
        {TABS.map((t) => (
          <button key={t.f} type="button" className={tab === t.f ? 'is-on' : ''} onClick={() => setTab(t.f)}>
            {t.label}{counts[t.f] !== undefined ? ` (${counts[t.f]})` : ''}
          </button>
        ))}
      </div>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : (
        <div className="sh-tbl-wrap">
          <table className="sh-table">
            <thead><tr><th>Product</th><th>Collection</th><th>Price</th><th>Sizes</th><th>Shows in</th><th>Promoted on</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30 }}>Loading…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30 }}>No products here yet. Tap “+ Add product”.</td></tr>
              ) : items.map((p) => {
                const chip = CHIP[p.status] ?? CHIP.live;
                const on = (p.promoted_on ?? []).filter((k) => k !== 'new_arrivals' && k !== 'bestsellers').map(slotShort);
                return (
                  <tr key={p.id}>
                    <td><Thumb url={p.image_url} /><b>{p.name}</b></td>
                    <td>{p.collection?.name ?? '—'}</td>
                    <td><b>{inr(p.price_rupees)}</b>{p.mrp_rupees ? <><br /><small><s>{inr(p.mrp_rupees)}</s></small></> : null}</td>
                    <td><small>{(p.sizes ?? []).join(' · ')}</small></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {p.status === 'archived' ? '—' : (<>
                        <button type="button" className={'sh-flag' + (p.is_new ? ' is-on' : '')} aria-pressed={!!p.is_new} title="Show in New arrivals" onClick={() => void flip(p, 'is_new')}>New arrival</button>{' '}
                        <button type="button" className={'sh-flag' + (p.is_bestseller ? ' is-on' : '')} aria-pressed={!!p.is_bestseller} title="Mark as Bestseller" onClick={() => void flip(p, 'is_bestseller')}>Bestseller</button>
                      </>)}
                    </td>
                    <td style={{ maxWidth: 220 }}><small>{on.join(', ') || '—'}</small></td>
                    <td><span className={`sh-st ${chip.cls}`}>{chip.label}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {p.status === 'archived' ? (
                        <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => void restore(p)}>Restore</button>
                      ) : (<>
                        <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setEdit(p)}>Edit</button>{' '}
                        <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => setPromo(p)}>Promote</button>{' '}
                        <button type="button" className="sh-btn sh-btn--ghost sh-mini" style={{ color: '#b3261e', borderColor: '#b3261e' }} onClick={() => setDel(p)}>Delete</button>
                      </>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ProductModal open={!!edit} product={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />
      <DeleteModal p={del} onClose={() => setDel(null)} onDone={() => { setDel(null); void load(); }} />
      <PromoteModal p={promo} onClose={() => setPromo(null)} onDone={() => { setPromo(null); void load(); }} />
    </div>
  );
}

/* Mockup copy, verbatim. */
function DeleteModal({ p, onClose, onDone }: { p: AdminProduct | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  async function go() {
    setBusy(true);
    try {
      await archiveProduct(p!.id);
      capture('admin2_shop_product_deleted', { product_id: p!.id });
      toast.success('Product deleted (archived for 30 days)');
      onDone();
    } catch (e) {
      captureException(e, { where: 'admin2_shop_product_delete' });
      toast.error(errMessage(e, 'Could not delete it.'));
    } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <h2>Delete “{p.name}”?</h2>
      <p>It disappears from the shop, every card and search. Past orders and receipts keep their copy of the product. You can restore it from Archived for 30 days.</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="sh-btn sh-btn--red" style={{ flex: 1 }} disabled={busy} onClick={() => void go()}>{busy ? 'Deleting…' : 'Delete product'}</button>
      </div>
    </Modal>
  );
}

function PromoteModal({ p, onClose, onDone }: { p: AdminProduct | null; onClose: () => void; onDone: () => void }) {
  const [slots, setSlots] = useState<string[]>([]);
  const [badge, setBadge] = useState<Badge>('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSlots(p?.promoted_on ?? []); setBadge(p?.badge_setting ?? p?.badge ?? ''); }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  async function save() {
    setBusy(true);
    try {
      await promoteProduct(p!.id, slots, badge);
      capture('admin2_shop_product_promoted', { product_id: p!.id, slots: slots.join(','), badge });
      toast.success('Promotion saved');
      onDone();
    } catch (e) {
      captureException(e, { where: 'admin2_shop_product_promote' });
      toast.error(errMessage(e, 'Could not save the promotion.'));
    } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <h2>Promote “{p.name}”</h2>
      <p>Tick every card on the shop where this product should appear.</p>
      <div className="sh-promo-opts">
        {SLOTS.map((s) => (
          <label key={s.key} className="sh-opt">
            <input type="checkbox" checked={slots.includes(s.key)} onChange={(e) => setSlots((cur) => e.target.checked ? [...cur, s.key] : cur.filter((k) => k !== s.key))} />{s.title}
          </label>
        ))}
      </div>
      <div className="sh-form">
        <label>Badge<select value={badge} onChange={(e) => setBadge(e.target.value as Badge)}><option value="">Automatic</option><option value="new">New</option><option value="best">Bestseller</option><option value="sale">Sale</option></select></label>
        <label>Show until<input value="Always" disabled readOnly /></label>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="sh-btn sh-btn--teal" style={{ flex: 1 }} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
