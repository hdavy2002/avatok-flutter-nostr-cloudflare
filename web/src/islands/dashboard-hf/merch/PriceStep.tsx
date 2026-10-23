/* [HF-MERCH-STUDIO-2] Wizard step 4 "Price & publish": mockup gallery on the left, markup + price table on the right. Money logic is unchanged from merch v1. */
import { useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { PriceNote, PriceTable, type PriceRow } from './PriceTable';
import { MARKUP_MAX, capHint, createProduct, getQuote, markupLimit, type CatalogInfo, type CatalogItem, type Product } from './api';
import type { DesignResult } from './studio/types';

export default function PriceStep({ info, item, colours, sizes, side, placed, minMarkup, onBack, onDone }: {
  info: CatalogInfo; item: CatalogItem; colours: string[]; sizes: string[]; side: 'front' | 'back'; placed: DesignResult; minMarkup: number; onBack: () => void; onDone: (p: Product) => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [markup, setMarkup] = useState(String(Math.max(100, minMarkup)));
  const [quote, setQuote] = useState<Record<string, PriceRow> | null>(null);
  const [quoteErr, setQuoteErr] = useState(false);
  // [HF-MERCH-GST-1] The cap and the GST rate belong to the product's category (clothing: 5%, capped at ₹2,500; others: no cap). The exact limits come with the quote.
  const [gstInfo, setGstInfo] = useState<{ bps?: number; capApplies: boolean; capPaise?: number | null; limit: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pics = placed.mockupUrls.length ? placed.mockupUrls : [placed.previewUrl];
  const [pic, setPic] = useState(0);

  useEffect(() => {
    let live = true;
    setQuote(null); setQuoteErr(false);
    void getQuote({ catalogId: item.id, colours, side, w: placed.wIn, h: placed.hIn, sizes }).then(r => {
      if (!live) return;
      if (r.ok) {
        setQuote(Object.fromEntries(r.data.sizes.map(x => [x.size, { size: x.size, printingPaise: x.printingPaise, shippingPaise: x.shippingPaise, basePaise: x.basePaise }])));
        setGstInfo({ bps: r.data.gstRateBps, capApplies: r.data.capApplies !== false && typeof r.data.priceCapPaise === 'number', capPaise: r.data.priceCapPaise, limit: markupLimit(r.data.sizes) });
      }
      else { setQuoteErr(true); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_quote_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'price_publish' }); }
    });
    return () => { live = false; };
  }, [item.id, colours, side, placed.wIn, placed.hIn, sizes]);

  const m = Math.floor(Number(markup) || 0);
  // Until the exact quote arrives, the catalogue's "up to" figures for the chosen sizes give the limit (null = this category has no cap).
  const gstBps = gstInfo?.bps ?? item.gstRateBps;
  const capApplies = gstInfo ? gstInfo.capApplies : item.capApplies !== false && item.sizes.some(s => typeof s.maxMarkupRupees === 'number');
  const maxM = gstInfo ? gstInfo.limit : markupLimit(item.sizes.filter(s => sizes.includes(s.size)));
  const okM = m >= minMarkup && m <= maxM;
  const rows: PriceRow[] = sizes.map(sz => {
    const c = item.sizes.find(x => x.size === sz);
    return quote?.[sz] ?? { size: sz, printingPaise: c?.printingPaise ?? 0, shippingPaise: c?.shippingPaise ?? 0, basePaise: c?.basePaise ?? 0 };
  });
  const ready = title.trim().length >= 2 && okM && !!quote && !busy;

  async function publish() {
    if (!ready) return;
    setBusy(true); setErr(null);
    const r = await createProduct({
      title: title.trim(), description: desc.trim() || undefined, catalogId: item.id, colours, sizes, side,
      placement: { frame: 'rect', x: placed.leftIn, y: placed.topIn, w: placed.wIn, h: placed.hIn, zoom: 100 },
      artId: placed.artId, printFileId: placed.printFileId, markupRupees: m, ownArtConfirmed: true, mockupUrls: placed.mockupUrls,
    });
    setBusy(false);
    if (r.ok) { capture('merch_studio_step', { step: 'publish_ok', status: r.data.product.status }); onDone(r.data.product); }
    else { setErr(r.code === 'over_price_cap' ? (r.message || `That price is over the cap. ${capHint(info.priceCapPaise, gstBps)}`) : (r.message || 'Could not publish.')); if (r.code !== 'over_price_cap') captureException(new Error(`merch_publish_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'price_publish', status: r.status }); }
  }

  return <div className="mc-price">
    <section className="mc-gallery" aria-label="Your product pictures">
      <div className="mc-bigpic"><img src={pics[Math.min(pic, pics.length - 1)]} alt={`${item.name} with your design`} /></div>
      {pics.length > 1 && <ul className="mc-thumbs">{pics.map((u, i) => <li key={u}><button type="button" className={i === pic ? 'on' : ''} aria-label={`Show picture ${i + 1}`} aria-pressed={i === pic} onClick={() => setPic(i)}><img src={u} alt="" /></button></li>)}</ul>}
      <label className="f">Product name<input value={title} maxLength={80} placeholder="e.g. Sunrise Chai Special" onChange={e => setTitle(e.target.value)} /></label>
      <label className="f">Description (optional)<textarea rows={3} maxLength={600} value={desc} placeholder="Tell fans what makes it special." onChange={e => setDesc(e.target.value)} /></label>
    </section>
    <section className="mc-pricebox">
      <h3 className="mc-h3">Set your price</h3>
      <label className="f">Your markup per item (₹{minMarkup} – ₹{maxM})<input inputMode="numeric" value={markup} onChange={e => setMarkup(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} aria-label="Markup in rupees" /></label>
      <div className="mc-sw">{[50, 100, 150, 200, 300].filter(v => v >= minMarkup).map(v => <button key={v} type="button" className={m === v ? 'on' : ''} aria-pressed={m === v} onClick={() => setMarkup(String(v))}>₹{v}</button>)}</div>
      {capApplies && <p className="small muted">{capHint(gstInfo?.capPaise ?? info.priceCapPaise, gstBps)}</p>}
      <PriceTable rows={rows} markup={m} okMarkup={okM} shareBps={info.platformShareBps} loading={!quote} gstBps={gstBps} />
      <PriceNote shareBps={info.platformShareBps} holdDays={info.holdDays} />
      {quoteErr && <p className="mc-err small" role="alert">We could not get the exact base price. Go back and try again in a moment.</p>}
      {!okM && <p className="mc-err small">Enter a markup between ₹{minMarkup} and ₹{maxM}.</p>}
      {err && <p className="mc-err" role="alert">{err}</p>}
      <div className="mc-foot"><button type="button" className="h3-btn ghost mc-big" onClick={onBack} disabled={busy}>← Back to design</button>
        <button type="button" className="h3-btn rani mc-big" disabled={!ready} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish'}</button></div>
    </section>
  </div>;
}
