/* PromotePanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/promote — the mockup's "Promote to
 * cards": one slot card per shop-home rail (product chips, drag to reorder, "+ Add" picker), plus
 * two cards in the same style for what the mockup shows but no slot can hold: the shop-home HERO
 * (photo, eyebrow, title + highlighted words, lead, CTAs, ticks, 3 promise items, hotspot x/y %
 * per product) and the FEATURED BANNER (product, texts, photo).
 * API (spec §4.4): GET slots, PUT slots/:slot, GET products?status=live, GET/PUT settings/:key. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { uploadCover } from '../eventsApi';
import { LoadError, Modal, Spinner, Thumb } from './ShopUI';
import {
  SLOTS, errMessage, getSettings, getSlots, listCollections, listProducts, putSetting, putSlot,
  type AdminCollection, type AdminProduct, type BannerSettings, type HeroSettings, type SlotKey,
} from './shopApi';

type SlotMap = Partial<Record<SlotKey, string[]>>;

export default function PromotePanel() {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [slots, setSlots] = useState<SlotMap>({});
  const [hero, setHero] = useState<HeroSettings>({});
  const [banner, setBanner] = useState<BannerSettings>({});
  const [cols, setCols] = useState<AdminCollection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<SlotKey | null>(null);
  const dragRef = useRef<{ slot: SlotKey; i: number } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, s, st, c] = await Promise.all([listProducts('live'), getSlots(), getSettings(), listCollections()]);
      setProducts(p.items); setSlots(s.slots ?? {}); setHero(st.hero ?? {}); setBanner(st.featured_banner ?? {}); setCols(c.items);
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

        <HeroCard hero={hero} products={products} cols={cols} onSaved={(h) => setHero(h)} />
        <BannerCard banner={banner} products={products} onSaved={(b) => setBanner(b)} />
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

/* A photo field used by both cards: preview, choose, remove. */
function PhotoField({ label, url, onChange, aspect = '16 / 7' }: { label: string; url: string | null | undefined; onChange: (u: string | null) => void; aspect?: string }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [up, setUp] = useState(false);
  return (
    <div className="full sh-field">
      <span className="sh-field-lbl">{label}</span>
      <div className="sh-ph sh-wide-ph" style={{ aspectRatio: aspect, height: 'auto', borderRadius: 12, overflow: 'hidden', padding: 0 }}>
        {url ? <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span>No photo yet</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={up} onClick={() => ref.current?.click()}>{up ? 'Uploading…' : url ? 'Replace photo' : 'Upload photo'}</button>
        {url && <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => onChange(null)}>Remove</button>}
      </div>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        setUp(true);
        try { onChange(await uploadCover(f)); }
        catch (er) { captureException(er, { where: 'admin2_shop_promote_upload' }); toast.error(errMessage(er, er instanceof Error ? er.message : 'The photo could not be uploaded.')); }
        finally { setUp(false); }
      }} />
    </div>
  );
}

function HeroCard({ hero, products, cols, onSaved }: { hero: HeroSettings; products: AdminProduct[]; cols: AdminCollection[]; onSaved: (h: HeroSettings) => void }) {
  const [h, setH] = useState<HeroSettings>(hero);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setH(hero); }, [hero]);
  const ticks = [0, 1, 2].map((i) => h.ticks?.[i] ?? '');
  const promise = [0, 1, 2].map((i) => h.promise?.[i] ?? { title: '', sub: '' });
  const spots = h.hotspots ?? [];
  const set = (patch: Partial<HeroSettings>) => setH((c) => ({ ...c, ...patch }));
  const setSpot = (i: number, patch: Partial<{ product_id: string; x: number; y: number }>) => set({ hotspots: spots.map((s, k) => k === i ? { ...s, ...patch } : s) });
  const pct = (v: string) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  async function save() {
    setBusy(true);
    try {
      const value: HeroSettings = {
        ...h,
        ticks: ticks.map((t) => t.trim()).filter(Boolean),
        promise: promise.map((p) => ({ title: p.title.trim(), sub: p.sub.trim() })).filter((p) => p.title),
        hotspots: spots.filter((s) => s.product_id),
      };
      await putSetting('hero', value);
      onSaved(value); toast.success('Shop-home hero saved');
    } catch (e) { captureException(e, { where: 'admin2_shop_hero_save' }); toast.error(errMessage(e, 'Could not save the hero.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="sh-slot" style={{ gridColumn: '1 / -1' }}>
      <h3>Shop-home hero</h3>
      <p>The big photo at the top of the shop, its card of words and the tappable dots.</p>
      <div className="sh-form">
        <PhotoField label="Hero photo" url={h.image_url} onChange={(u) => set({ image_url: u })} />
        {h.image_url && spots.length > 0 && (
          <div className="full sh-field">
            <span className="sh-field-lbl">Hotspot positions — tap the photo to place the selected dot</span>
            <div className="sh-hotbox" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSpot(sel, { x: pct(String(((e.clientX - r.left) / r.width) * 100)), y: pct(String(((e.clientY - r.top) / r.height) * 100)) });
            }}>
              <img src={h.image_url} alt="" />
              {spots.map((s, i) => <i key={i} className={i === sel ? 'is-sel' : ''} style={{ left: `${s.x}%`, top: `${s.y}%` }}>{i + 1}</i>)}
            </div>
          </div>
        )}
        <label className="full">Small line above the title<input value={h.eyebrow ?? ''} onChange={(e) => set({ eyebrow: e.target.value })} placeholder="New season" /></label>
        <label>Title<input value={h.title ?? ''} onChange={(e) => set({ title: e.target.value })} placeholder="Wear your faith," /></label>
        <label>Highlighted words (red)<input value={h.title_em ?? ''} onChange={(e) => set({ title_em: e.target.value })} placeholder="softly." /></label>
        <label className="full">Lead paragraph<textarea rows={3} value={h.lead ?? ''} onChange={(e) => set({ lead: e.target.value })} /></label>
        <label>Main button text<input value={h.cta_label ?? ''} onChange={(e) => set({ cta_label: e.target.value })} placeholder="Shop all T-shirts →" /></label>
        <label>Second button opens collection
          <select value={h.second_cta_collection ?? ''} onChange={(e) => set({ second_cta_collection: e.target.value })}>
            <option value="">None</option>
            {cols.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </label>
        {ticks.map((t, i) => (
          <label key={i}>Tick line {i + 1}<input value={t} onChange={(e) => set({ ticks: ticks.map((x, k) => k === i ? e.target.value : x) })} placeholder={['100% cotton, 180 GSM', 'Sizes S to 3XL + kids', 'Pay by UPI'][i]} /></label>
        ))}
        {promise.map((p, i) => (
          <div className="full sh-pair" key={i}>
            <label>Promise {i + 1} — title<input value={p.title} onChange={(e) => set({ promise: promise.map((x, k) => k === i ? { ...x, title: e.target.value } : x) })} placeholder={['Free shipping', 'Printed to order', 'Pay by any UPI app'][i]} /></label>
            <label>Promise {i + 1} — small text<input value={p.sub} onChange={(e) => set({ promise: promise.map((x, k) => k === i ? { ...x, sub: e.target.value } : x) })} placeholder={['Pan India, every order', 'Made just for you', 'Scan the QR, done'][i]} /></label>
          </div>
        ))}
        <div className="full sh-field">
          <span className="sh-field-lbl">Hotspots (the dots on the photo) — position is % across and % down</span>
          {spots.map((s, i) => (
            <div className="sh-hotrow" key={i} onClick={() => setSel(i)}>
              <span className={`sh-hotn${i === sel ? ' is-sel' : ''}`}>{i + 1}</span>
              <select aria-label="Product" value={s.product_id} onChange={(e) => setSpot(i, { product_id: e.target.value })}>
                <option value="">Choose product…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input aria-label="Across %" inputMode="numeric" value={s.x} onChange={(e) => setSpot(i, { x: pct(e.target.value) })} />
              <input aria-label="Down %" inputMode="numeric" value={s.y} onChange={(e) => setSpot(i, { y: pct(e.target.value) })} />
              <button type="button" className="sh-btn sh-btn--ghost sh-mini" aria-label="Remove hotspot" onClick={() => { set({ hotspots: spots.filter((_, k) => k !== i) }); setSel(0); }}>×</button>
            </div>
          ))}
          <button type="button" className="sh-link" onClick={() => { set({ hotspots: [...spots, { product_id: '', x: 50, y: 50 }] }); setSel(spots.length); }}>+ Add hotspot</button>
        </div>
      </div>
      <div style={{ marginTop: 14 }}><button type="button" className="sh-btn sh-btn--teal" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save hero'}</button></div>
    </div>
  );
}

function BannerCard({ banner, products, onSaved }: { banner: BannerSettings; products: AdminProduct[]; onSaved: (b: BannerSettings) => void }) {
  const [b, setB] = useState<BannerSettings>(banner);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setB(banner); }, [banner]);
  const set = (patch: Partial<BannerSettings>) => setB((c) => ({ ...c, ...patch }));
  async function save() {
    setBusy(true);
    try { await putSetting('featured_banner', b); onSaved(b); toast.success('Featured banner saved'); }
    catch (e) { captureException(e, { where: 'admin2_shop_banner_save' }); toast.error(errMessage(e, 'Could not save the banner.')); }
    finally { setBusy(false); }
  }
  return (
    <div className="sh-slot" style={{ gridColumn: '1 / -1' }}>
      <h3>Featured banner</h3>
      <p>The red banner between New arrivals and Bestsellers.</p>
      <div className="sh-form">
        <label className="full">Product it opens
          <select value={b.product_id ?? ''} onChange={(e) => set({ product_id: e.target.value || null })}>
            <option value="">None</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="full">Small line above the title<input value={b.eyebrow ?? ''} onChange={(e) => set({ eyebrow: e.target.value })} placeholder="Featured · Navratri drop" /></label>
        <label className="full">Title<input value={b.title ?? ''} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="full">Text<textarea rows={2} value={b.text ?? ''} onChange={(e) => set({ text: e.target.value })} /></label>
        <label className="full">Button text<input value={b.cta_label ?? ''} onChange={(e) => set({ cta_label: e.target.value })} placeholder="See the tee →" /></label>
        <PhotoField label="Banner photo" url={b.image_url} onChange={(u) => set({ image_url: u })} aspect="4 / 3" />
      </div>
      <div style={{ marginTop: 14 }}><button type="button" className="sh-btn sh-btn--teal" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save banner'}</button></div>
    </div>
  );
}
