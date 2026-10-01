/* CollectionsPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/collections — the mockup's
 * "Categories & collections" panel: reorder handle, name + "N products · shown on shop home",
 * Edit / Delete, and the "New collection name" add box. A collection that still has products
 * cannot be deleted (mockup toast). On phones, where drag does not work, ▲ ▼ buttons appear.
 * API (spec §4.4): GET/POST collections, PUT/DELETE collections/:id, POST collections/reorder. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { uploadCover } from '../eventsApi';
import { LoadError, Modal, Spinner } from './ShopUI';
import {
  createCollection, deleteCollection, errMessage, listCollections, reorderCollections, updateCollection,
  type AdminCollection,
} from './shopApi';

export default function CollectionsPanel() {
  const [items, setItems] = useState<AdminCollection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<AdminCollection | 'new' | null>(null);
  const [del, setDel] = useState<AdminCollection | null>(null);
  const dragFrom = useRef<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems((await listCollections()).items); }
    catch (e) { captureException(e, { where: 'admin2_shop_collections_load' }); setError(errMessage(e, 'Could not load the collections.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function reorder(list: AdminCollection[]) {
    const prev = items;
    setItems(list);
    try { await reorderCollections(list.map((c) => c.id)); }
    catch (e) { captureException(e, { where: 'admin2_shop_collection_reorder' }); toast.error(errMessage(e, 'Could not save the new order.')); setItems(prev); }
  }

  const moveBy = (i: number, d: -1 | 1) => {
    if (!items) return;
    const j = i + d; if (j < 0 || j >= items.length) return;
    const c = items.slice(); [c[i], c[j]] = [c[j], c[i]]; void reorder(c);
  };

  function askDelete(c: AdminCollection) {
    if (c.count > 0) { toast(`Move its ${c.count} product(s) first — a collection with products can't be deleted`); return; }
    setDel(c);
  }

  return (
    <div className="sh-apanel is-on" data-apanel="cats">
      <div className="sh-panel">
        <h2>Categories &amp; collections</h2>
        <p>Collections show as tiles on the shop home and as a filter. Drag to reorder.</p>
        {error ? <LoadError message={error} onRetry={() => void load()} /> : !items ? <Spinner /> : (
          <div>
            {items.length === 0 && <p>No collections yet — add the first one below.</p>}
            {items.map((c, i) => (
              <div
                className="sh-sum-item sh-cat-row" key={c.id} style={{ gridTemplateColumns: '28px 1fr auto' }}
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = dragFrom.current; dragFrom.current = null;
                  if (from === null || from === i) return;
                  const l = items.slice(); const [m] = l.splice(from, 1); l.splice(i, 0, m); void reorder(l);
                }}
              >
                <span style={{ font: '900 18px Nunito', color: '#a08974', cursor: 'grab' }} aria-hidden>⋮⋮</span>
                <div><b>{c.name}</b><small>{c.count} products · shown on shop home{c.active ? '' : ' · hidden'}</small></div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span className="sh-mv">
                    <button type="button" className="sh-btn sh-btn--ghost sh-mini" aria-label="Move up" disabled={i === 0} onClick={() => moveBy(i, -1)}>▲</button>{' '}
                    <button type="button" className="sh-btn sh-btn--ghost sh-mini" aria-label="Move down" disabled={i === items.length - 1} onClick={() => moveBy(i, 1)}>▼</button>{' '}
                  </span>
                  <button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setEdit(c)}>Edit</button>{' '}
                  <button type="button" className="sh-btn sh-btn--ghost sh-mini" style={{ color: '#b3261e', borderColor: '#b3261e' }} onClick={() => askDelete(c)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* [SAATHUM-SHOP-EDITOR-2] A new collection is made in the same form as editing one — name, one line and the tile photo — so it is ready for the shop home straight away. */}
        <div className="sh-coupon">
          <button type="button" className="sh-btn sh-btn--teal" onClick={() => setEdit('new')}>+ New collection</button>
        </div>
        <p style={{ marginTop: 10 }}><small>A collection appears on the shop home once at least one live product is in it.</small></p>
      </div>

      <EditModal target={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />
      <Modal open={!!del} onClose={() => setDel(null)}>
        <h2>Delete “{del?.name}”?</h2>
        <p>It disappears from the shop home and the filters. It has no products, so nothing else changes.</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={() => setDel(null)}>Cancel</button>
          <button type="button" className="sh-btn sh-btn--red" style={{ flex: 1 }} onClick={async () => {
            if (!del) return;
            try { await deleteCollection(del.id); toast.success('Collection deleted'); setDel(null); await load(); }
            catch (e) {
              captureException(e, { where: 'admin2_shop_collection_delete' });
              toast.error(errMessage(e, "A collection with products can't be deleted."));
              setDel(null);
            }
          }}>Delete collection</button>
        </div>
      </Modal>
    </div>
  );
}

function EditModal({ target, onClose, onSaved }: { target: AdminCollection | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const c = target === 'new' ? null : target;
  const creating = target === 'new';
  const [name, setName] = useState('');
  const [blurb, setBlurb] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setName(c?.name ?? ''); setBlurb(c?.blurb ?? ''); setImage(c?.image_url ?? null); setActive(c ? !!c.active : true); setErr('');
  }, [target === 'new' ? 'new' : c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!target) return null;

  async function pick(f: File | undefined) {
    if (!f) return;
    setUp(true); setErr('');
    try { setImage(await uploadCover(f)); }
    catch (e) { captureException(e, { where: 'admin2_shop_collection_upload' }); setErr(errMessage(e, e instanceof Error ? e.message : 'The photo could not be uploaded.')); }
    finally { setUp(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) { setErr('Give the collection a name.'); return; }
    setBusy(true);
    try {
      if (creating) { await createCollection({ name: name.trim(), blurb: blurb.trim(), image_url: image }); toast.success('Collection added'); }
      else { await updateCollection(c!.id, { name: name.trim(), blurb: blurb.trim(), image_url: image, active }); toast.success('Collection saved'); }
      onSaved();
    }
    catch (er) { captureException(er, { where: 'admin2_shop_collection_save' }); setErr(errMessage(er, 'Could not save it.')); }
    finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{creating ? 'New collection' : 'Edit collection'}</h2>
        <p>The photo and one line appear on the tile on the shop home.</p>
        <div className="sh-form">
          <label className="full">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="full">One line about it<input value={blurb} onChange={(e) => setBlurb(e.target.value)} placeholder="e.g. Tees inspired by Mahadev" /></label>
          <div className="full sh-field">
            <span className="sh-field-lbl">Tile photo</span>
            <div className="sh-photos">
              <div className="sh-photo">
                {image ? <img src={image} alt="" /> : <span className="sh-ph" style={{ aspectRatio: '1', height: 'auto' }}><span>No photo</span></span>}
                <div className="sh-photo-act">
                  <button type="button" onClick={() => fileRef.current?.click()}>{up ? '…' : '+'}</button>
                  {image && <button type="button" aria-label="Remove photo" onClick={() => setImage(null)}>×</button>}
                </div>
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        </div>
        {!creating && <label className="sh-opt" style={{ marginTop: 14 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Show on the shop home</label>}
        {err && <p className="sh-err" role="alert">{err}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="sh-btn sh-btn--teal" style={{ flex: 1 }} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
