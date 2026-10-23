/* MerchProducts — [HF-MERCH-ADMIN-REVIEW-2] "Approve merch": a row list of influencer T-shirt designs. New arrivals say "Needs approval";
 * a row slides open below itself with the details; any shirt picture opens a full-screen lightbox; Approve / Reject / Hide live in the panel.
 * Worker: GET /api/admin/merch/products[?status=] · POST /api/admin/merch/products/:id/review {decision:'approve'|'reject'|'hide', note}
 * (approve can answer 502 listing_failed: shown plainly, the row stays "Needs approval"). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { DesiEmpty } from '../desi';
import { Banner, adminCall, click, dateIST, fail, money, usePageView, ProfitTable, type AdminProduct } from './merchKit';

type St = AdminProduct['status'];
type Tab = St | 'all';
const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Needs approval' }, { key: 'live', label: 'Live' }, { key: 'hidden', label: 'Hidden' }, { key: 'rejected', label: 'Rejected' }, { key: 'all', label: 'All' },
];
const CHIP: Record<St, { label: string; tone: string }> = {
  pending: { label: 'Needs approval', tone: '' }, live: { label: 'Live', tone: 'tea' }, hidden: { label: 'Hidden', tone: 'lav' }, rejected: { label: 'Rejected', tone: 'rani' },
};
const RANK: Record<St, number> = { pending: 0, live: 1, hidden: 2, rejected: 3 };
/** Tells the admin menu how many designs need approval (read by AdminNav's NeedsBadge). */
export const NEEDS_APPROVAL_EVENT = 'merch-admin:needs-approval';

const picsOf = (p: AdminProduct): string[] => (p.mockups.length ? p.mockups : p.imageUrl ? [p.imageUrl] : []);
const priceRange = (p: AdminProduct): string => {
  if (!p.sizes.length) return '—';
  const v = p.sizes.map((s) => s.pricePaise), lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`;
};

function Lightbox({ pics, start, title, onClose }: { pics: string[]; start: number; title: string; onClose: () => void }) {
  const [i, setI] = useState(start);
  const closeRef = useRef<HTMLButtonElement>(null);
  const go = useCallback((d: number) => setI((x) => (x + d + pics.length) % pics.length), [pics.length]);
  useEffect(() => {
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && pics.length > 1) go(-1);
      else if (e.key === 'ArrowRight' && pics.length > 1) go(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [go, onClose, pics.length]);
  return (
    <div className="mx-lb" role="dialog" aria-modal="true" aria-label={`${title}, large picture`} onClick={onClose}>
      <button ref={closeRef} type="button" className="mx-lb-x" aria-label="Close picture" onClick={onClose}><X size={28} aria-hidden="true" /></button>
      {pics.length > 1 && <button type="button" className="mx-lb-nav l" aria-label="Previous picture" onClick={(e) => { e.stopPropagation(); go(-1); }}><ChevronLeft size={32} aria-hidden="true" /></button>}
      <img className="mx-lb-img" src={pics[i]} alt={`${title}, picture ${i + 1} of ${pics.length}`} onClick={(e) => e.stopPropagation()} />
      {pics.length > 1 && <button type="button" className="mx-lb-nav r" aria-label="Next picture" onClick={(e) => { e.stopPropagation(); go(1); }}><ChevronRight size={32} aria-hidden="true" /></button>}
      {pics.length > 1 && (
        <div className="mx-lb-strip" onClick={(e) => e.stopPropagation()}>
          {pics.map((u, n) => <button key={u} type="button" aria-label={`Picture ${n + 1}`} aria-pressed={n === i} className={n === i ? 'on' : ''} onClick={() => setI(n)}><img src={u} alt="" /></button>)}
        </div>
      )}
    </div>
  );
}

function Row({ p, open, onToggle, onZoom, onChanged }: {
  p: AdminProduct; open: boolean; onToggle: () => void; onZoom: (pics: string[], at: number) => void; onChanged: (np: AdminProduct, msg: string) => void;
}) {
  const [mode, setMode] = useState<null | 'reject' | 'hide'>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pics = picsOf(p);
  const chip = CHIP[p.status];
  const who = p.seller.displayName ?? 'the influencer';

  const decide = async (decision: 'approve' | 'reject' | 'hide') => {
    click('merch_product_review_clicked', { product_id: p.id, decision });
    setBusy(true); setErr(null);
    try {
      const r = await adminCall<{ product: AdminProduct }>(`/api/admin/merch/products/${encodeURIComponent(p.id)}/review`, { method: 'POST', body: { decision, note: note.trim() } });
      const status: St = decision === 'approve' ? 'live' : decision === 'reject' ? 'rejected' : 'hidden';
      setMode(null); setNote('');
      onChanged({ ...p, ...r.product, seller: p.seller, moderation: p.moderation, status }, `${p.title}: ${decision === 'approve' ? 'approved and live' : decision === 'reject' ? 'rejected' : 'hidden'}.`);
    } catch (e) { setErr(fail('merch_product_review', e, { product_id: p.id, decision })); }
    setBusy(false);
  };

  return (
    <article className={`mx-row${open ? ' open' : ''}`}>
      <div className="mx-head mx-prow">
        <button type="button" className="mx-zoom" aria-label={`See ${p.title} large`} disabled={!pics.length} onClick={() => onZoom(pics, 0)}>
          {pics[0] ? <img className="mx-thumb" src={pics[0]} alt="" loading="lazy" /> : <span className="mx-thumb" aria-hidden="true" />}
        </button>
        <button type="button" className="mx-pmain" aria-expanded={open} onClick={onToggle}>
          <span className="mx-title">{p.title} <ChevronDown size={16} aria-hidden="true" style={{ verticalAlign: -2, transform: open ? 'rotate(180deg)' : undefined }} /></span>
          <span className="mx-sub">{p.seller.displayName ?? 'Influencer'} · {p.catalogName || 'T-shirt'} · Fan pays {priceRange(p)} (incl. GST &amp; delivery)</span>
          <span className="mx-dots" aria-label={`${p.colours.length} colours`}>{p.colours.map((c) => <i key={c.name} title={c.name} style={{ background: c.hex }} />)}</span>
        </button>
        <button type="button" className="mx-pchip" tabIndex={-1} aria-hidden="true" onClick={onToggle}><span className={`mx-chip ${chip.tone}`}>{chip.label}</span></button>
      </div>
      <div className="mx-slide"><div><div className="mx-body">
        {err && <Banner tone="error">{err}</Banner>}
        {p.status === 'live' && <Banner tone="info">Live on {who}’s page{p.publicUrl ? <> · <a href={p.publicUrl} target="_blank" rel="noopener noreferrer">Open it</a></> : null}</Banner>}
        <div className="mx-cols">
          <div>
            <h3 className="mx-h">Pictures (tap to enlarge)</h3>
            <div className="mx-gal">
              {pics.map((u, n) => <button key={u} type="button" aria-label={`Enlarge mockup ${n + 1}`} onClick={() => onZoom(pics, n)}><img src={u} alt={`${p.title} mockup ${n + 1}`} loading="lazy" /></button>)}
              {!pics.length && <p className="hfa-note">No picture on this design.</p>}
            </div>
          </div>
          <div>
            <h3 className="mx-h">Design</h3>
            <dl className="mx-kv">
              <dt>Influencer</dt><dd>{p.seller.slug ? <a href={`/h/${encodeURIComponent(p.seller.slug)}`} target="_blank" rel="noopener noreferrer">{p.seller.displayName ?? p.seller.slug}</a> : (p.seller.displayName ?? '—')}</dd>
              <dt>Shirt</dt><dd>{p.catalogName || '—'}</dd>
              <dt>Added</dt><dd>{dateIST(p.createdAt)}</dd>
              <dt>Sold so far</dt><dd>{p.soldCount}</dd>
            </dl>
            <p style={{ margin: '8px 0', fontSize: 15, fontWeight: 700 }}>
              {p.colours.map((c) => <span key={c.name} style={{ marginRight: 12, whiteSpace: 'nowrap' }}><span className="mx-sw" style={{ background: c.hex }} />{c.name}</span>)}
            </p>
            {p.description && <p style={{ margin: '6px 0', fontSize: 15 }}>{p.description}</p>}
            {p.moderation === 'unscanned'
              ? <div className="mx-warn" role="alert">The automatic image check did not run on this art. Look at it carefully before approving.</div>
              : <p className="hfa-note">Automatic image check: {p.moderation ?? 'no result recorded'}.</p>}
            {p.reviewNote && <p className="hfa-note">Last note: {p.reviewNote}</p>}
            {p.publicUrl && <p style={{ margin: '8px 0' }}><a href={p.publicUrl} target="_blank" rel="noopener noreferrer">Open the public page</a></p>}
          </div>
          <div>
            <h3 className="mx-h">Prices</h3>
            <dl className="mx-kv"><dt>Influencer markup</dt><dd>{money(p.markupRupees * 100)}</dd><dt>Fan pays (incl. GST &amp; delivery)</dt><dd>{priceRange(p)}</dd></dl>
          </div>
        </div>
        <div>
          <h3 className="mx-h">Money per size</h3>
          <ProfitTable profit={p.profit} />
        </div>
        {mode ? (
          <div className="mx-form">
            <label>{mode === 'reject' ? 'Why is this rejected? (the influencer sees it)' : 'Why is this hidden?'}
              <input className="mx-in" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A short, kind reason" /></label>
            <div className="mx-acts">
              <button type="button" className="hfa-btn danger mx-big" disabled={busy || note.trim().length < 3} onClick={() => void decide(mode)}>{busy ? 'Working…' : mode === 'reject' ? 'Reject' : 'Hide'}</button>
              <button type="button" className="hfa-btn ghost mx-big" disabled={busy} onClick={() => setMode(null)}>Go back</button>
            </div>
          </div>
        ) : (
          <div className="mx-acts">
            {p.status !== 'live' && <button type="button" className="hfa-btn tea mx-big" disabled={busy} onClick={() => void decide('approve')}>{busy ? 'Working…' : 'Approve'}</button>}
            {p.status !== 'rejected' && <button type="button" className="hfa-btn danger mx-big" disabled={busy} onClick={() => { setNote(''); setMode('reject'); }}>Reject</button>}
            {p.status === 'live' && <button type="button" className="hfa-btn ghost mx-big" disabled={busy} onClick={() => { setNote(''); setMode('hide'); }}>Hide</button>}
          </div>
        )}
      </div></div></div>
    </article>
  );
}

export default function MerchProducts() {
  usePageView('products');
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [stay, setStay] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState<{ pics: string[]; at: number; title: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // One call per status: the unfiltered list is capped at 100 newest-updated, which could push waiting designs off it.
      const parts = await Promise.all((['pending', 'live', 'hidden', 'rejected'] as const).map((status) => adminCall<{ products: AdminProduct[] }>('/api/admin/merch/products', { query: { status } })));
      setItems(parts.flatMap((r) => r.products));
    }
    catch (e) { setError(fail('merch_products_list', e)); setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { pending: 0, live: 0, hidden: 0, rejected: 0, all: 0 };
    for (const p of items ?? []) { c[p.status] += 1; c.all += 1; }
    return c;
  }, [items]);
  useEffect(() => {
    if (items === null) return;
    try { sessionStorage.setItem('admin2:merch-needs', String(counts.pending)); } catch { /* storage blocked: the pill just waits for the next visit */ }
    window.dispatchEvent(new CustomEvent<number>(NEEDS_APPROVAL_EVENT, { detail: counts.pending }));
  }, [items, counts.pending]);

  const shown = useMemo(() => (items ?? [])
    .filter((p) => tab === 'all' || p.status === tab || stay.has(p.id))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.createdAt - a.createdAt), [items, tab, stay]);

  const changed = (np: AdminProduct, msg: string) => {
    setItems((cur) => (cur ?? []).map((x) => (x.id === np.id ? np : x)));
    setStay((s) => new Set(s).add(np.id));
    setFlash(msg);
  };
  const closeZoom = useCallback(() => setZoom(null), []);

  return (
    <div className="hfa-stack">
      <div className="hfa-pills" style={{ alignItems: 'center' }}>
        {TABS.map((t) => <button key={t.key} type="button" className="hfa-pill" aria-pressed={tab === t.key}
          onClick={() => { setTab(t.key); setFlash(null); setOpenId(null); setStay(new Set()); click('merch_products_tab', { tab: t.key }); }}>{t.label} ({counts[t.key]})</button>)}
        <button type="button" className="hfa-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => { setStay(new Set()); void load(); }}>Refresh</button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {flash && <Banner tone="info">{flash}</Banner>}
      {items === null && <p className="mx-empty" role="status">Loading products…</p>}
      {items && shown.length === 0 && !error && <DesiEmpty text={tab === 'pending' ? 'Nothing needs approval right now.' : 'Nothing here.'} />}
      <div className="mx-list">
        {shown.map((p) => <Row key={p.id} p={p} open={openId === p.id}
          onToggle={() => { const next = openId === p.id ? null : p.id; setOpenId(next); click('merch_review_row_toggled', { product_id: p.id, open: next !== null }); }}
          onZoom={(pics, at) => { click('merch_review_lightbox_opened', { product_id: p.id, picture: at }); setZoom({ pics, at, title: p.title }); }}
          onChanged={changed} />)}
      </div>
      {zoom && <Lightbox pics={zoom.pics} start={zoom.at} title={zoom.title} onClose={closeZoom} />}
    </div>
  );
}
