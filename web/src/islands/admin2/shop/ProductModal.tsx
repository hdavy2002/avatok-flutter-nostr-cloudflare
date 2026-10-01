/* ProductModal — [SAATHUM-SHOP-ADMIN-1 2026-10-01] The mockup's "Add product" / "Edit product" modal.
 * Field order is the mockup's (name, collection, fit, price, MRP, colours, sizes, Printrove ID,
 * photos, description, status, the disabled "+18% GST at checkout" field); the owner's spec adds
 * print type, For (Adults/Kids), badge, photo labels + reorder, and a hex colour editor.
 * API: POST products / PUT products/:id (spec §4.4); photos go to /upload/public via uploadCover().
 * The list rows carry only card fields, so Edit asks GET products/:id for the full row and falls
 * back to the card fields if that route is not there. */
import { useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { uploadCover } from '../eventsApi';
import { Modal } from './ShopUI';
import {
  PHOTO_LABELS, digitsOnly, errMessage, getProduct, listCollections, saveProduct,
  type AdminCollection, type AdminProduct, type Colour, type ProductImage,
} from './shopApi';

const HEX = /^#[0-9a-fA-F]{6}$/;
const PRINT_TYPES = ['Chest print', 'Big front print', 'Back print', 'Embroidery'];

export default function ProductModal({ open, product, onClose, onSaved }: {
  open: boolean; product: AdminProduct | null; onClose: () => void; onSaved: () => void;
}) {
  const [cols, setCols] = useState<AdminCollection[]>([]);
  const [name, setName] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [fit, setFit] = useState<'Regular' | 'Oversized'>('Regular');
  const [printType, setPrintType] = useState('Big front print');
  const [audience, setAudience] = useState<'Adults' | 'Kids'>('Adults');
  const [price, setPrice] = useState('');
  const [mrp, setMrp] = useState('');
  const [colours, setColours] = useState<Colour[]>([{ name: '', hex: '#222222' }]);
  const [sizes, setSizes] = useState('S, M, L, XL, XXL');
  const [ref, setRef] = useState('');
  const [images, setImages] = useState<ProductImage[]>([]);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'live' | 'draft' | 'hidden'>('live');
  const [badge, setBadge] = useState<'' | 'new' | 'best' | 'sale'>('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editing = !!product;

  // Reset / hydrate whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setErr(''); setBusy(false);
    const fill = (p: AdminProduct | null) => {
      setName(p?.name ?? '');
      setCollectionId(p?.collection_id ?? '');
      setFit(p?.fit ?? 'Regular');
      setPrintType(p?.print_type ?? 'Big front print');
      setAudience(p?.audience ?? 'Adults');
      setPrice(p ? String(p.price_rupees) : '');
      setMrp(p?.mrp_rupees ? String(p.mrp_rupees) : '');
      setColours(p?.colours?.length ? p.colours.map((c) => ({ ...c })) : [{ name: '', hex: '#222222' }]);
      setSizes(p?.sizes?.length ? p.sizes.join(', ') : 'S, M, L, XL, XXL');
      setRef(p?.printrove_ref ?? '');
      setImages(p?.images?.length ? p.images.map((i) => ({ ...i })) : (p?.image_url ? [{ url: p.image_url, label: 'Front' }] : []));
      setDescription(p?.description ?? '');
      setStatus(p && p.status !== 'archived' ? p.status : 'live');
      setBadge(p?.badge ?? '');
    };
    fill(product);
    let off = false;
    listCollections().then((r) => {
      if (off) return;
      setCols(r.items);
      if (!product) setCollectionId((cur) => cur || r.items[0]?.id || '');
    }).catch((e) => captureException(e, { where: 'admin2_shop_product_collections' }));
    if (product && product.description === undefined) {
      getProduct(product.id).then((r) => { if (!off && r.product) fill({ ...product, ...r.product }); }).catch(() => { /* route may not exist: card fields are enough to edit */ });
    }
    return () => { off = true; };
  }, [open, product?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setUploading((n) => n + list.length); setErr('');
    for (const f of list) {
      try {
        const url = await uploadCover(f);
        setImages((cur) => [...cur, { url, label: PHOTO_LABELS[cur.length] ?? 'Front' }]);
      } catch (e) {
        captureException(e, { where: 'admin2_shop_product_upload' });
        setErr(errMessage(e, e instanceof Error ? e.message : 'The photo could not be uploaded.'));
      } finally { setUploading((n) => n - 1); }
    }
  }

  const move = (i: number, d: -1 | 1) => setImages((cur) => {
    const j = i + d; if (j < 0 || j >= cur.length) return cur;
    const c = cur.slice(); [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const priceN = Number(price), mrpN = mrp.trim() ? Number(mrp) : null;
    const sizeList = sizes.split(',').map((s) => s.trim()).filter(Boolean);
    const colourList = colours.map((c) => ({ name: c.name.trim(), hex: c.hex.trim() })).filter((c) => c.name || c.hex);
    if (name.trim().length < 2) return setErr('Give the product a name.');
    if (!collectionId) return setErr('Pick a collection (add one under Categories first).');
    if (!Number.isInteger(priceN) || priceN < 1) return setErr('Enter the price in whole rupees.');
    if (mrpN !== null && (!Number.isInteger(mrpN) || mrpN <= priceN)) return setErr('MRP must be higher than the price (or leave it empty).');
    if (!colourList.length || colourList.some((c) => !c.name || !HEX.test(c.hex))) return setErr('Each colour needs a name and a hex like #B3261E.');
    if (!sizeList.length) return setErr('List the sizes offered, e.g. S, M, L, XL.');
    if (uploading) return setErr('Wait for the photos to finish uploading.');
    setBusy(true);
    try {
      const body = {
        name: name.trim(), collection_id: collectionId, description: description.trim(), fit, print_type: printType, audience,
        price_rupees: priceN, mrp_rupees: mrpN, colours: colourList, sizes: sizeList, images, badge, status,
        printrove_ref: ref.trim() || null,
      };
      const r = await saveProduct(product?.id ?? null, body);
      capture('admin2_shop_product_saved', { product_id: r.product?.id ?? product?.id, created: !editing, status });
      toast.success(editing ? 'Changes saved' : 'Product published');
      onSaved();
    } catch (er) {
      captureException(er, { where: 'admin2_shop_product_save' });
      setErr(errMessage(er, 'The product could not be saved.'));
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{editing ? 'Edit product' : 'Add product'}</h2>
        <p>Photos, price and stock per size. SEO title and share card are written automatically.</p>
        <div className="sh-form">
          <label className="full">Product name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ram Darbar Tee" /></label>
          <label>Collection
            <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              {cols.length === 0 && <option value="">No collections yet</option>}
              {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Fit<select value={fit} onChange={(e) => setFit(e.target.value as 'Regular' | 'Oversized')}><option>Regular</option><option>Oversized</option></select></label>
          <label>Print type<select value={printType} onChange={(e) => setPrintType(e.target.value)}>{PRINT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>For<select value={audience} onChange={(e) => setAudience(e.target.value as 'Adults' | 'Kids')}><option>Adults</option><option>Kids</option></select></label>
          <label>Price (₹)<input inputMode="numeric" value={price} onChange={(e) => setPrice(digitsOnly(e.target.value, 6))} /></label>
          <label>MRP for strike-through (₹)<input inputMode="numeric" value={mrp} onChange={(e) => setMrp(digitsOnly(e.target.value, 6))} placeholder="optional" /></label>

          <div className="full sh-field">
            <span className="sh-field-lbl">Colours</span>
            {colours.map((c, i) => (
              <div className="sh-colrow" key={i}>
                <input type="color" aria-label="Pick colour" value={HEX.test(c.hex) ? c.hex : '#222222'} onChange={(e) => setColours((cur) => cur.map((x, k) => k === i ? { ...x, hex: e.target.value } : x))} />
                <input className="sh-colname" placeholder="Black" value={c.name} onChange={(e) => setColours((cur) => cur.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} />
                <input className="sh-colhex" placeholder="#222222" value={c.hex} maxLength={7} onChange={(e) => setColours((cur) => cur.map((x, k) => k === i ? { ...x, hex: e.target.value } : x))} />
                <button type="button" className="sh-btn sh-btn--ghost sh-mini" aria-label="Remove colour" disabled={colours.length === 1} onClick={() => setColours((cur) => cur.filter((_, k) => k !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="sh-link" onClick={() => setColours((cur) => [...cur, { name: '', hex: '#222222' }])}>+ Add colour</button>
          </div>

          <label className="full">Sizes offered<input value={sizes} onChange={(e) => setSizes(e.target.value)} /></label>
          <label className="full">Printrove product / design ID<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="from your Printrove dashboard" /></label>

          <div className="full sh-field">
            <span className="sh-field-lbl">Photos (front, back, close-up, on model)</span>
            {images.length > 0 && (
              <div className="sh-photos">
                {images.map((im, i) => (
                  <div className="sh-photo" key={im.url + i}>
                    <img src={im.url} alt="" />
                    <select aria-label="Photo label" value={PHOTO_LABELS.includes(im.label) ? im.label : 'Front'} onChange={(e) => setImages((cur) => cur.map((x, k) => k === i ? { ...x, label: e.target.value } : x))}>
                      {PHOTO_LABELS.map((l) => <option key={l}>{l}</option>)}
                    </select>
                    <div className="sh-photo-act">
                      <button type="button" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>‹</button>
                      <button type="button" aria-label="Move later" disabled={i === images.length - 1} onClick={() => move(i, 1)}>›</button>
                      <button type="button" aria-label="Remove photo" onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}>×</button>
                    </div>
                    {i === 0 && <em>Card photo</em>}
                  </div>
                ))}
              </div>
            )}
            <div
              className={`sh-ph sh-drop${drag ? ' is-drag' : ''}`}
              style={{ minHeight: 90, borderRadius: 12, cursor: 'pointer' }}
              role="button" tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
            >
              <span>{uploading ? `Uploading ${uploading}…` : 'Drop photos here'}</span>
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          <label className="full">Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Original artwork, fabric, the story behind the design…" /></label>
          <label>Status<select value={status} onChange={(e) => setStatus(e.target.value as 'live' | 'draft' | 'hidden')}><option value="live">Live</option><option value="draft">Draft</option><option value="hidden">Hidden</option></select></label>
          <label>Price shown<input value="+18% GST at checkout" disabled readOnly /></label>
          <label>Badge<select value={badge} onChange={(e) => setBadge(e.target.value as '' | 'new' | 'best' | 'sale')}><option value="">None</option><option value="new">New</option><option value="best">Bestseller</option><option value="sale">Sale</option></select></label>
        </div>
        {err && <p className="sh-err" role="alert">{err}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="sh-btn sh-btn--red" style={{ flex: 1 }} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Publish product'}</button>
        </div>
      </form>
    </Modal>
  );
}
