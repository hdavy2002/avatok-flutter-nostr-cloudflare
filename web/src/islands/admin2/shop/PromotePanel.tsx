/* PromotePanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/promote — the mockup's "Promote to
 * cards": one slot card per shop-home rail (product chips, drag to reorder, "+ Add" picker), plus
 * a card linking to the visual shop-page editor (/admin/shop/editor, SAATHUM-SHOP-EDITOR-1) where the hero and the
 * featured banner now live.
 * API (spec §4.4): GET slots, PUT slots/:slot, GET products?status=live, GET/PUT settings/:key. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Modal, Spinner, Thumb } from './ShopUI';
import {
  SLOTS, errMessage, getSlots, listProducts, putSlot,
  type AdminProduct, type SlotKey,
} from './shopApi';

type SlotMap = Partial<Record<SlotKey, string[]>>;

export default function PromotePanel() {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [slots, setSlots] = useState<SlotMap>({});
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<SlotKey | null>(null);
  const dragRef = useRef<{ slot: SlotKey; i: number } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, s] = await Promise.all([listProducts('live'), getSlots()]);
      setProducts(p.items); setSlots(s.slots ?? {});
    } catch (e) {
      captureException(e, { where: 'admin2_shop_promote_load' });
      setError(errMessage(e, 'Could not load the promotion slots.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!products) return <div className="sh-apanel is-on"><Spinner /></div>;

  const byId = new Map(products.map((p) => [p.id, p]));

  async function saveSlot(key: SlotKey, ids: string[]) {
    const prev = slots;
    setSlots({ ...slots, [key]: ids });
    try { await putSlot(key, ids); toast.success('Promotion saved'); }
    catch (e) { captureException(e, { where: 'admin2_shop_slot_save', slot: key }); toast.error(errMessage(e, 'Could not save this card.')); setSlots(prev); }
  }

  return (
    <div className="sh-apanel is-on" data-apanel="promo">
      <p style={{ font: '700 15px Nunito', color: '#6b4a2b', margin: '0 0 14px' }}>Each card on the shop home is a slot. Pick which products show in it — or use “Promote” on any product.</p>
      <div className="sh-slots">
        {SLOTS.map((s) => {
          const ids = (slots[s.key] ?? []).filter((id) => byId.has(id));
          return (
            <div className="sh-slot" key={s.key}>
              <h3>{s.title}</h3>
              <p>{ids.length} product{ids.length === 1 ? '' : 's'} · drag to reorder</p>
              <div className="sh-slot-items">
                {ids.map((id, i) => {
                  const pr = byId.get(id)!;
                  return (
                    <span
                      key={id} draggable className="sh-chipx"
                      onDragStart={() => { dragRef.current = { slot: s.key, i }; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const d = dragRef.current; dragRef.current = null;
                        if (!d || d.slot !== s.key || d.i === i) return;
                        const l = ids.slice(); const [m] = l.splice(d.i, 1); l.splice(i, 0, m); void saveSlot(s.key, l);
                      }}
                    >
                      <Thumb url={pr.image_url} />{pr.name}
                      <button type="button" aria-label={`Remove ${pr.name}`} onClick={() => void saveSlot(s.key, ids.filter((x) => x !== id))}>×</button>
                    </span>
                  );
                })}
                <span style={{ borderStyle: 'dashed', padding: '4px 10px', cursor: 'pointer' }} role="button" tabIndex={0}
                  onClick={() => setPicker(s.key)} onKeyDown={(e) => { if (e.key === 'Enter') setPicker(s.key); }}>+ Add</span>
              </div>
            </div>
          );
        })}

        {/* [SAATHUM-SHOP-EDITOR-1] The hero and the featured banner (and every other word / photo on the shop home) are edited visually now. */}
        <div className="sh-slot" style={{ gridColumn: '1 / -1' }}>
          <h3>Shop-home hero, featured banner and page text</h3>
          <p>The big hero photo and its words, the collection photos, the featured banner and its photo are now edited directly on the page — click any text to change it.</p>
          <div style={{ marginTop: 14 }}><a className="sh-btn sh-btn--teal" href="/admin/shop/editor">Edit shop page →</a></div>
        </div>
      </div>

      <PickerModal
        slotKey={picker} products={products} current={picker ? (slots[picker] ?? []) : []}
        onClose={() => setPicker(null)}
        onSave={(ids) => { const k = picker!; setPicker(null); void saveSlot(k, ids); }}
      />
    </div>
  );
}

function PickerModal({ slotKey, products, current, onClose, onSave }: {
  slotKey: SlotKey | null; products: AdminProduct[]; current: string[]; onClose: () => void; onSave: (ids: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { setSel([]); }, [slotKey]);
  if (!slotKey) return null;
  const title = SLOTS.find((s) => s.key === slotKey)?.title ?? '';
  const free = products.filter((p) => !current.includes(p.id));
  return (
    <Modal open onClose={onClose}>
      <h2>Add to “{title}”</h2>
      <p>Tick the products to show in this card.</p>
      <div className="sh-promo-opts">
        {free.length === 0 && <p>Every live product is already here.</p>}
        {free.map((p) => (
          <label key={p.id} className="sh-opt">
            <input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel((c) => e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id))} />{p.name}
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="sh-btn sh-btn--teal" style={{ flex: 1 }} disabled={!sel.length} onClick={() => onSave([...current, ...sel])}>Add {sel.length || ''}</button>
      </div>
    </Modal>
  );
}
