/* [HF-MERCH-CREATOR-WEB-1] Products grid: status chip, price range, "you earn", sold count; edit markup with live per-size maths, hide/show, delete. */
import { PriceNote, PriceTable } from './PriceTable';
import { useCallback, useEffect, useState } from 'react';
import { captureException, capture } from '../../../lib/analytics';
import { Dialog, Empty, Failed, Skel, Ic, useToast } from '../v3/ui';
import { capText, deleteProduct, gstPct, listProducts, markupLimit, merchConfig, patchProduct, rupees, type Product, type ProductStatus } from './api';

const STATUS: Record<ProductStatus, { label: string; cls: string }> = {
  pending: { label: 'Waiting for review', cls: 'gold' }, live: { label: 'Live', cls: '' }, hidden: { label: 'Hidden', cls: 'dec' }, rejected: { label: 'Rejected', cls: 'miss' },
};
const range = (a: number[]) => { const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? rupees(lo) : `${rupees(lo)} – ${rupees(hi)}`; };

export default function ProductsTab({ shareBps, minMarkup, onNew, onChanged }: { shareBps: number; minMarkup: number; onNew: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<Product[] | null>(null);
  const [gstRateBps, setGstRateBps] = useState<number | undefined>(undefined); // [HF-MERCH-GST-1]
  const [capPaise, setCapPaise] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [edit, setEdit] = useState<Product | null>(null);
  const [del, setDel] = useState<Product | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    setFailed(false);
    void listProducts().then(r => {
      if (r.ok) { setItems(r.data.products); setGstRateBps(r.data.gstRateBps); setCapPaise(r.data.priceCapPaise); }
      else { setFailed(true); setItems([]); if (r.status !== 401) captureException(new Error(`merch_products_${r.status}_${r.code}`), { area: 'hf_merch_creator', part: 'products' }); }
    });
  }, []);
  useEffect(load, [load]);

  async function toggle(p: Product) {
    const r = await patchProduct(p.id, { hidden: p.status === 'live' });
    if (r.ok) { toast(p.status === 'live' ? 'Hidden. Fans can no longer see it.' : 'It is live again.'); load(); onChanged(); }
    else { toast(r.message || 'Could not change this product.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_hide_${r.status}_${r.code}`), { area: 'hf_merch_creator' }); }
  }
  async function copy(p: Product) {
    try { await navigator.clipboard.writeText(p.publicUrl); toast('Link copied. Share it with your fans.'); } catch { toast(p.publicUrl); }
  }

  if (items === null) return <div className="mc-grid"><Skel h={320} /><Skel h={320} /><Skel h={320} /></div>;
  return <>
    {failed && <Failed onRetry={load} text="We could not load your products." />}
    {!failed && items.length === 0 && <Empty text="No products yet. Put your art on a T-shirt and your fans can buy it.">
      <button type="button" className="h3-btn rani mc-big" onClick={onNew}><Ic name="plus" className="" />Make your first product</button></Empty>}
    <div className="mc-grid">{items.map(p => {
      const prices = p.sizes.map(s => s.pricePaise), earns = p.sizes.map(s => s.youEarnPaise);
      const st = STATUS[p.status];
      return <article key={p.id} className="mc-prod">
        <div className="pic">{p.imageUrl ? <img src={p.imageUrl} alt={p.title} loading="lazy" /> : <Ic name="shirt" className="" size={56} />}<span className={`h3-chip ${st.cls}`}>{st.label}</span></div>
        <div className="bd">
          <h3>{p.title}</h3>
          <div className="small muted">{p.catalogName}{p.colours.length ? ` · ${p.colours.length} colour${p.colours.length === 1 ? '' : 's'}` : ''}</div>
          <div><span className="small muted">Fan pays</span> <b>{prices.length ? range(prices) : '—'}</b> <span className="small muted">(incl. {gstPct(gstRateBps)} GST &amp; delivery)</span></div>
          <div className="mc-earn">{earns.length ? range(earns) : '—'} <span className="small muted" style={{ fontWeight: 600 }}>design royalty per shirt</span></div>
          <div className="small muted">{p.soldCount} sold</div>
          {(p.status === 'rejected' || p.status === 'pending') && p.reviewNote && <div className="mc-note">{p.reviewNote}</div>}
          {p.status === 'pending' && !p.reviewNote && <div className="mc-note">Our team is checking your art. You can still change the price.</div>}
          <div className="acts">
            <button type="button" className="h3-btn sm" onClick={() => setEdit(p)}>Edit price</button>
            {(p.status === 'live' || p.status === 'hidden') && <button type="button" className="h3-btn sm ghost" onClick={() => void toggle(p)}>{p.status === 'live' ? 'Hide' : 'Show'}</button>}
            {p.status === 'live' && <button type="button" className="h3-btn sm ghost" onClick={() => void copy(p)}>Copy link</button>}
            <button type="button" className="h3-btn sm ghost" onClick={() => setDel(p)}>Delete</button>
          </div>
        </div>
      </article>;
    })}</div>
    {edit && <EditDialog p={edit} shareBps={shareBps} minMarkup={minMarkup} gstRateBps={gstRateBps} capPaise={capPaise} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); onChanged(); toast('Saved.'); }} />}
    {del && <DeleteDialog p={del} onClose={() => setDel(null)} onDone={() => { setDel(null); load(); onChanged(); toast('Deleted.'); }} onHide={async () => { const r = await patchProduct(del.id, { hidden: true }); setDel(null); toast(r.ok ? 'Hidden instead. Fans can no longer see it.' : r.message || 'Could not hide it.'); load(); onChanged(); }} />}
  </>;
}

function EditDialog({ p, shareBps, minMarkup, gstRateBps, capPaise, onClose, onSaved }: { p: Product; shareBps: number; minMarkup: number; gstRateBps?: number; capPaise?: number; onClose: () => void; onSaved: () => void }) {
  const [markup, setMarkup] = useState(String(p.markupRupees));
  const [title, setTitle] = useState(p.title);
  const [desc, setDesc] = useState(p.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [holdDays, setHoldDays] = useState(7);
  useEffect(() => { void merchConfig().then(c => setHoldDays(c.holdDays)); }, []);
  const m = Math.floor(Number(markup) || 0);
  const maxM = markupLimit(p.sizes); // [HF-MERCH-GST-1] smallest max across sizes (the fan price may not pass the cap)
  const okM = m >= minMarkup && m <= maxM;
  async function save() {
    if (!okM || busy) return;
    setBusy(true); setErr(null);
    const body: Partial<{ markupRupees: number; title: string; description: string }> = {};
    if (m !== p.markupRupees) body.markupRupees = m;
    if (title.trim() !== p.title) body.title = title.trim();
    if (desc.trim() !== (p.description ?? '')) body.description = desc.trim();
    const r = await patchProduct(p.id, body);
    setBusy(false);
    if (r.ok) { capture('merch_product_edited', { product_id: p.id, markup: m }); onSaved(); }
    else { setErr(r.message || 'Could not save.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_edit_${r.status}_${r.code}`), { area: 'hf_merch_creator' }); }
  }
  return <Dialog open onClose={onClose} label="Edit product">
    <h2>Edit {p.title}</h2>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
      <label className="f">Name<input value={title} maxLength={80} onChange={e => setTitle(e.target.value)} /></label>
      <label className="f">Description<textarea rows={3} maxLength={600} value={desc} onChange={e => setDesc(e.target.value)} /></label>
      <label className="f">Your markup per shirt (₹{minMarkup} – ₹{maxM})<input inputMode="numeric" value={markup} onChange={e => setMarkup(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} /></label>
      <p className="small muted">Shirts are capped at {capText(capPaise)} so the {gstPct(gstRateBps)} GST rate applies.</p>
      <PriceTable rows={p.sizes.map(x => ({ size: x.size, printingPaise: x.printingPaise, shippingPaise: x.shippingPaise, basePaise: x.basePaise }))} markup={m} okMarkup={okM} shareBps={shareBps} gstBps={gstRateBps} />
      {p.breakdownEstimated && <p className="small muted">This product was made before we showed the split, so printing and shipping are an estimate. The base and the fan price are exact.</p>}
      <PriceNote shareBps={shareBps} holdDays={holdDays} />
      {!okM && <p className="mc-err small">Enter a markup between ₹{minMarkup} and ₹{maxM}.</p>}
      {err && <p className="mc-err small" role="alert">{err}</p>}
      <div className="acts"><button type="button" className="h3-btn rani mc-big" disabled={!okM || busy || !title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="h3-btn ghost mc-big" onClick={onClose}>Cancel</button></div>
    </div>
  </Dialog>;
}

function DeleteDialog({ p, onClose, onDone, onHide }: { p: Product; onClose: () => void; onDone: () => void; onHide: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    const r = await deleteProduct(p.id);
    setBusy(false);
    if (r.ok) onDone();
    else if (r.code === 'open_orders') setOpen(r.message || 'This product has orders that are not delivered yet. You can hide it instead.');
    else { setOpen(r.message || 'Could not delete it.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_delete_${r.status}_${r.code}`), { area: 'hf_merch_creator' }); }
  }
  return <Dialog open onClose={onClose} label="Delete product">
    <h2>Delete {p.title}?</h2>
    {open ? <>
      <p className="muted" style={{ marginTop: 8 }}>{open}</p>
      <div className="acts">{p.status === 'live' && <button type="button" className="h3-btn rani mc-big" onClick={onHide}>Hide it instead</button>}<button type="button" className="h3-btn ghost mc-big" onClick={onClose}>Okay</button></div>
    </> : <>
      <p className="muted" style={{ marginTop: 8 }}>Fans will not see it any more. Orders already placed are not affected.</p>
      <div className="acts"><button type="button" className="h3-btn danger mc-big" disabled={busy} onClick={() => void go()}>{busy ? 'Deleting…' : 'Yes, delete'}</button><button type="button" className="h3-btn ghost mc-big" onClick={onClose}>Keep it</button></div>
    </>}
  </Dialog>;
}
