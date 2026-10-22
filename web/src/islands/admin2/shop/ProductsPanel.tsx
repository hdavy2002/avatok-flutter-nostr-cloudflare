/* ProductsPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/products — the mockup's "Products"
 * panel: status tabs, table (Product / Collection / Price / Sizes / Promoted on / Status / Actions)
 * with Edit · Promote · Delete (archives for 30 days) and Restore on archived rows, plus the
 * mockup's Delete and Promote modals. API (spec §4.4): GET products?status=, DELETE products/:id,
 * POST products/:id/restore, PUT products/:id/promote {slots,badge}. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Modal, Spinner, Thumb } from './ShopUI';
import { DesiCard, DesiChip, DesiEmpty, Hibiscus, Jasmine, Marigold } from '../desi';
import ProductModal from './ProductModal';
import {
  SLOTS, archiveProduct, errMessage, inr, listProducts, promoteProduct, restoreProduct, setProductFlags, slotShort,
  type AdminProduct, type Badge, type ProductStatus,
} from './shopApi';

const TABS: { f: 'all' | ProductStatus; label: string }[] = [
  { f: 'all', label: 'All' }, { f: 'live', label: 'Live' }, { f: 'draft', label: 'Draft' }, { f: 'hidden', label: 'Hidden' }, { f: 'archived', label: 'Archived' },
];
const CHIP: Record<ProductStatus, { tone: 'tea' | 'gold' | 'lav' | 'grey'; label: string }> = {
  live: { tone: 'tea', label: 'Live' }, draft: { tone: 'gold', label: 'Draft' },
  hidden: { tone: 'lav', label: 'Hidden' }, archived: { tone: 'grey', label: 'Archived' },
};
/** Each tile gets its own tint so a gallery reads as a bazaar, not a grid of identical boxes. */
const TINTS = ['rani', 'lav', 'tea', 'gold', 'saffron'] as const;

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
      <div className="sh-toolbar sh-toolbar--gold">
        <div className="hfa-pills" role="group" aria-label="Filter products">
          {TABS.map((t) => (
            <button key={t.f} type="button" className="hfa-pill" aria-pressed={tab === t.f} onClick={() => setTab(t.f)}>
              {t.label}{counts[t.f] !== undefined ? ` (${counts[t.f]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : loading ? (
        <Spinner label="Loading…" />
      ) : items.length === 0 ? (
        <DesiCard tone="gold" corner="marigold"><DesiEmpty text="No products here yet. Tap “+ Add product”." /></DesiCard>
      ) : (
        <div className="sh-gallery">
          {items.map((p, idx) => {
            const chip = CHIP[p.status] ?? CHIP.live;
            const on = (p.promoted_on ?? []).filter((k) => k !== 'new_arrivals' && k !== 'bestsellers').map(slotShort);
            const tint = TINTS[idx % TINTS.length];
            return (
              <article key={p.id} className={`sh-ptile sh-tint-${tint}${p.status === 'archived' ? ' is-archived' : ''}`}>
                <span className="sh-pcorner" aria-hidden="true">{idx % 3 === 0 ? <Marigold size={56} tone={1} /> : idx % 3 === 1 ? <Hibiscus size={44} /> : <Jasmine size={34} />}</span>
                <div className="sh-ptag">
                  <div className="sh-ptag-img"><Thumb url={p.image_url} /></div>
                  <div className="sh-pprice">
                    <b>{inr(p.price_rupees)}</b>
                    {p.mrp_rupees ? <small><s>{inr(p.mrp_rupees)}</s></small> : null}
                  </div>
                </div>
                <div className="sh-pbody">
                  <div className="sh-pchips">
                    <DesiChip tone={chip.tone}>{chip.label}</DesiChip>
                    {p.collection?.name && <DesiChip tone="plum">{p.collection.name}</DesiChip>}
                  </div>
                  <b className="sh-pname">{p.name}</b>
                  {(p.sizes ?? []).length > 0 && <small className="sh-psizes">{(p.sizes ?? []).join(' · ')}</small>}
                  {p.status !== 'archived' && (
                    <div className="sh-pflags">
                      <button type="button" className={'sh-flag' + (p.is_new ? ' is-on' : '')} aria-pressed={!!p.is_new} title="Show in New arrivals" onClick={() => void flip(p, 'is_new')}>New arrival</button>
                      <button type="button" className={'sh-flag' + (p.is_bestseller ? ' is-on' : '')} aria-pressed={!!p.is_bestseller} title="Mark as Bestseller" onClick={() => void flip(p, 'is_bestseller')}>Bestseller</button>
                    </div>
                  )}
                  <small className="sh-ppromo"><span>Promoted on</span> {on.join(', ') || '—'}</small>
                </div>
                <div className="sh-pacts">
                  {p.status === 'archived' ? (
                    <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => void restore(p)}>Restore</button>
                  ) : (<>
                    <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setEdit(p)}>Edit</button>
                    <button type="button" className="sh-btn sh-btn--teal sh-mini" onClick={() => setPromo(p)}>Promote</button>
                    <button type="button" className="sh-btn sh-btn--ghost sh-mini sh-danger" onClick={() => setDel(p)}>Delete</button>
                  </>)}
                </div>
              </article>
            );
          })}
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
      <div className="sh-actions">
        <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="sh-btn sh-btn--red sh-btn--danger" style={{ flex: 1 }} disabled={busy} onClick={() => void go()}>{busy ? 'Deleting…' : 'Delete product'}</button>
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
      <div className="sh-actions sh-actions--spaced">
        <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="sh-btn sh-btn--teal" style={{ flex: 1 }} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
