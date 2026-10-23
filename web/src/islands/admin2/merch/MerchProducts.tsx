/* MerchProducts — [HF-MERCH-ADMIN-1] Review queue for influencer merch designs.
 * Worker: GET /api/admin/merch/products?status= · POST /api/admin/merch/products/:id/review {decision:'approve'|'reject'|'hide', note}. */
import { useCallback, useEffect, useState } from 'react';
import { DesiEmpty } from '../desi';
import { Banner, adminCall, click, fail, money, usePageView, type AdminProduct } from './merchKit';

type St = 'pending' | 'live' | 'hidden' | 'rejected';
const TABS: { key: St; label: string }[] = [{ key: 'pending', label: 'To review' }, { key: 'live', label: 'Live' }, { key: 'hidden', label: 'Hidden' }, { key: 'rejected', label: 'Rejected' }];
const TONE: Record<St, string> = { pending: '', live: 'tea', hidden: 'lav', rejected: 'rani' };

function Product({ p, onDone }: { p: AdminProduct; onDone: (msg: string) => void }) {
  const [pic, setPic] = useState(0);
  const [mode, setMode] = useState<null | 'reject' | 'hide'>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pics = p.mockups.length ? p.mockups : p.imageUrl ? [p.imageUrl] : [];
  const sizes = p.sizes;
  const baseRange = sizes.length ? `${money(Math.min(...sizes.map((s) => s.basePaise)))}${sizes.some((s) => s.basePaise !== sizes[0].basePaise) ? ` to ${money(Math.max(...sizes.map((s) => s.basePaise)))}` : ''}` : '—';

  const decide = async (decision: 'approve' | 'reject' | 'hide') => {
    click('merch_product_review_clicked', { product_id: p.id, decision });
    setBusy(true); setErr(null);
    try {
      await adminCall(`/api/admin/merch/products/${encodeURIComponent(p.id)}/review`, { method: 'POST', body: { decision, note: note.trim() } });
      onDone(`${p.title}: ${decision === 'approve' ? 'approved and live' : decision === 'reject' ? 'rejected' : 'hidden'}.`);
    } catch (e) { setErr(fail('merch_product_review', e, { product_id: p.id, decision })); }
    setBusy(false);
  };

  return (
    <article className="mx-row open">
      <div className="mx-body" style={{ paddingTop: 18 }}>
        <div className="mx-cols">
          <div>
            {pics[pic] ? <img className="mx-mock" src={pics[pic]} alt={`${p.title} mockup ${pic + 1}`} loading="lazy" /> : <div className="mx-mock" aria-hidden="true" />}
            {pics.length > 1 && (
              <div className="mx-acts" style={{ marginTop: 8 }}>
                {pics.map((u, i) => <button key={u} type="button" aria-label={`Mockup ${i + 1}`} aria-pressed={i === pic} onClick={() => setPic(i)} style={{ border: i === pic ? '2px solid var(--a-rani)' : '2px solid transparent', borderRadius: 14, padding: 0, background: 'none', cursor: 'pointer' }}><img className="mx-thumb" src={u} alt="" loading="lazy" /></button>)}
              </div>
            )}
          </div>
          <div>
            <h3 className="mx-title" style={{ fontSize: 20, margin: 0 }}>{p.title} <span className={`mx-chip ${TONE[p.status]}`}>{p.status}</span></h3>
            <p className="mx-sub">{p.seller.displayName ?? 'Influencer'}{p.seller.slug ? ` (/${p.seller.slug})` : ''} · {p.catalogName} · sold {p.soldCount}</p>
            {p.description && <p style={{ margin: '6px 0', fontSize: 15 }}>{p.description}</p>}
            <p style={{ margin: '6px 0', fontSize: 15, fontWeight: 700 }}>
              {p.colours.map((c) => <span key={c.name} style={{ marginRight: 12, whiteSpace: 'nowrap' }}><span className="mx-sw" style={{ background: c.hex }} />{c.name}</span>)}
            </p>
            {p.moderation === 'unscanned' && <div className="mx-warn" role="alert">The automatic image check did not run on this art. Look at it carefully before approving.</div>}
            {p.reviewNote && <p className="hfa-note">Last note: {p.reviewNote}</p>}
            {p.publicUrl && <p style={{ margin: '6px 0' }}><a href={p.publicUrl} target="_blank" rel="noopener noreferrer">Open the public page</a></p>}
          </div>
          <div>
            <h3 className="mx-h">Price</h3>
            <dl className="mx-kv"><dt>Base price</dt><dd>{baseRange}</dd><dt>Influencer markup</dt><dd>{money(p.markupRupees * 100)}</dd></dl>
            <div className="mx-scroll"><table className="mx-table">
              <thead><tr><th>Size</th><th className="n">Base</th><th className="n">Fan pays</th><th className="n">Influencer</th></tr></thead>
              <tbody>{sizes.map((s) => <tr key={s.size}><td>{s.size}</td><td className="n">{money(s.basePaise)}</td><td className="n">{money(s.pricePaise)}</td><td className="n">{money(s.youEarnPaise)}</td></tr>)}</tbody>
            </table></div>
          </div>
        </div>
        {err && <Banner tone="error">{err}</Banner>}
        {mode ? (
          <div className="mx-form">
            <label>{mode === 'reject' ? 'Why is this rejected? (the influencer sees it)' : 'Why is this hidden?'}
              <input className="mx-in" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A short, kind reason" /></label>
            <div className="mx-acts">
              <button type="button" className="hfa-btn danger" disabled={busy || note.trim().length < 3} onClick={() => void decide(mode)}>{busy ? 'Working…' : mode === 'reject' ? 'Reject' : 'Hide'}</button>
              <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => setMode(null)}>Go back</button>
            </div>
          </div>
        ) : (
          <div className="mx-acts">
            {p.status !== 'live' && <button type="button" className="hfa-btn tea" disabled={busy} onClick={() => void decide('approve')}>{busy ? 'Working…' : p.status === 'pending' ? 'Approve' : 'Approve and make live'}</button>}
            {p.status !== 'rejected' && <button type="button" className="hfa-btn danger" disabled={busy} onClick={() => { setNote(''); setMode('reject'); }}>Reject</button>}
            {p.status === 'live' && <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => { setNote(''); setMode('hide'); }}>Hide</button>}
          </div>
        )}
      </div>
    </article>
  );
}

export default function MerchProducts() {
  usePageView('products');
  const [tab, setTab] = useState<St>('pending');
  const [items, setItems] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems((await adminCall<{ products: AdminProduct[] }>('/api/admin/merch/products', { query: { status: tab } })).products); }
    catch (e) { setError(fail('merch_products_list', e, { tab })); setItems([]); }
  }, [tab]);
  useEffect(() => { setItems(null); void load(); }, [load]);
  return (
    <div className="hfa-stack">
      <div className="hfa-pills" style={{ alignItems: 'center' }}>
        {TABS.map((t) => <button key={t.key} type="button" className="hfa-pill" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setFlash(null); click('merch_products_tab', { tab: t.key }); }}>{t.label}</button>)}
        <button type="button" className="hfa-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => void load()}>Refresh</button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {flash && <Banner tone="info">{flash}</Banner>}
      {items === null && <p className="mx-empty" role="status">Loading products…</p>}
      {items && items.length === 0 && !error && <DesiEmpty text="Nothing here." />}
      <div className="mx-list">{items?.map((p) => <Product key={p.id} p={p} onDone={(m) => { setFlash(m); void load(); }} />)}</div>
    </div>
  );
}
