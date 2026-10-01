/* PublishStep — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Step 5, replica of Specs/studio-mockup/Publish.dc.html.
 * "What Printrove will print" summary, words (+ Write with AI), sizes and prices, and the resumable publish steps
 * (POST publish returns every step as done / skipped / failed; a failed step is retried by pressing Publish again).
 * [AUMFE-POD-COST-1] Deliberate differences: Printrove gives no size chart, so Chest/Length are replaced by the real cost per size
 * (Printrove garment + print, GST, shipping estimate -> "Your cost") with a live Profit column and a "Suggest prices" helper;
 * sizes come from the real catalogue (S-5XL etc.); prices start empty (the owner sets them, we do not invent one). Shop checkout charges ONE price per product (spec §4), so a
 * 2XL/3XL price that differs from S–XL gets the note "priced the same for now". */
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { capture, captureException } from '../../../lib/analytics';
import {
  areaFor, copyAi, errMessage, fmtIn, getFits, gstOn, publishDesign, stepHref, suggestPrice, updateDesign,
  type CostRange, type Fits, type PublishStepRow, type SizeCost,
} from '../../../lib/studioApi';
import { listCollections, type AdminCollection } from '../shop/shopApi';
import { LoadError, Loading, Page, Steps, TopBar, useDesign } from './StudioKit';

const FALLBACK_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL']; // last resort only: the catalogue's own sizes are used whenever there is one
const SHAPE_LABEL: Record<string, string> = { none: 'Whole print area', rect: 'Rectangle', square: 'Square', circle: 'Circle' };
const BADGES: [string, string][] = [['', 'Automatic'], ['new', 'New'], ['best', 'Bestseller'], ['sale', 'Sale']];
const inr = (n: number): string => `₹${n.toLocaleString('en-IN')}`;
/** Rupees rounded up to a whole rupee; a range prints as ₹165–₹175. */
const up = (n: number): number => Math.ceil(n - 1e-9);
const rangeText = (r: CostRange | null): string => (!r ? '—' : up(r.min) === up(r.max) ? inr(up(r.max)) : `${inr(up(r.min))}–${inr(up(r.max))}`);
const gstAmount = (c: SizeCost): number | null => (c.garment_rupees && c.print_rupees ? ((c.garment_rupees.max + c.print_rupees.max) * c.partner_gst_pct) / 100 : null);

export default function PublishStep({ designId }: { designId: string }) {
  const { design, setDesign, error, reload } = useDesign(designId);
  const [fits, setFits] = useState<Fits | null>(null);
  const [collections, setCollections] = useState<AdminCollection[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [badge, setBadge] = useState('new');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<PublishStepRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [inited, setInited] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => { capture('studio_viewed', { step: 'publish' }); }, []);
  useEffect(() => {
    let live = true;
    getFits(designId).then((f) => { if (live) setFits(f); }).catch((e) => captureException(e, { where: 'studio_fits' }));
    listCollections().then((r) => { if (live) setCollections(r.items ?? []); }).catch((e) => captureException(e, { where: 'studio_collections' }));
    return () => { live = false; };
  }, [designId]);

  useEffect(() => {
    if (!design || inited) return;
    setName(design.copy.name ?? design.name);
    setDesc(design.copy.description ?? '');
    setPrices(Object.fromEntries(Object.entries(design.prices).map(([k, v]) => [k, String(v)])));
    if (design.copy.publish_steps?.length) setSteps(design.copy.publish_steps);
    setInited(true);
  }, [design, inited]);

  const product = design?.products[0] ?? null;
  const fit = fits?.items.find((i) => i.kind === product?.kind && i.side === product?.side) ?? fits?.items.find((i) => i.kind === product?.kind);
  const costs = design?.costs ?? null;
  const costBySize = useMemo(() => new Map((costs?.sizes ?? []).map((c) => [c.size, c])), [costs]);
  // Sizes come from the real catalogue; a size with nothing in stock in the chosen colours cannot be sold, so it is left out.
  const sizes = useMemo(() => {
    if (costs?.sizes.length) { const live = costs.sizes.filter((c) => c.in_stock).map((c) => c.size); if (live.length) return live; }
    return fit?.catalog?.sizes?.length ? fit.catalog.sizes : FALLBACK_SIZES;
  }, [costs, fit]);

  if (error && !design) return <Page><LoadError message={error} onRetry={() => void reload()} /></Page>;
  if (!design || !fits || !inited) return <Page><Loading what="Opening the last step…" /></Page>;

  const pl = design.placement;
  const area = pl ? areaFor(pl.kind, pl.side) : null;
  const priceNum = (sz: string): number => { const n = Math.round(Number(prices[sz])); return Number.isFinite(n) && n > 0 ? n : 0; };
  const allPriced = sizes.every((sz) => priceNum(sz) > 0);
  const baseSizes = sizes.filter((sz) => !/^[2-5]XL$/i.test(sz));
  const base = Math.min(...(baseSizes.length ? baseSizes : sizes).map(priceNum).filter((n) => n > 0), Infinity);
  const bigDiffer = sizes.some((sz) => /^[2-5]XL$/i.test(sz) && priceNum(sz) > 0 && Number.isFinite(base) && priceNum(sz) !== base);
  const builtin = design.catalog_source === 'builtin';
  const unsold = design.colour_info.filter((c) => c.unavailable).map((c) => c.name);
  const yourCost = (sz: string): number | null => { const t = costBySize.get(sz)?.total_rupees; return typeof t === 'number' ? up(t) : null; };
  const suggestable = sizes.some((sz) => yourCost(sz) !== null);
  const suggest = (): void => {
    setPrices((p) => {
      const next = { ...p };
      for (const sz of sizes) { const c = yourCost(sz); if (c !== null && !(Number(next[sz]) > 0)) next[sz] = String(suggestPrice(c)); }
      return next;
    });
    capture('studio_prices_suggested', { sizes: sizes.length });
  };
  const hasPrint = !!design.print_w && !!pl;
  const colName = collections.find((c) => c.id === collectionId)?.name ?? 'your';
  const keptPhotos = design.photos.filter((p) => p.status === 'kept').length;
  const failed = (steps ?? []).filter((s) => s.status === 'failed').length;
  const published = !!steps && steps.length > 0 && failed === 0 && design.status === 'live';
  const canPublish = hasPrint && allPriced && !!collectionId && name.trim().length > 1 && !busy && unsold.length === 0;

  const pricesBody = (): Record<string, number> => Object.fromEntries(sizes.map((sz) => [sz, priceNum(sz)]));
  const saveDraft = async (): Promise<void> => {
    setBusy('Saving…');
    try {
      setDesign(await updateDesign(design.id, { copy: { ...design.copy, name: name.trim(), description: desc }, prices: pricesBody() }));
      toast.success('Draft saved.');
    } catch (e) {
      captureException(e, { where: 'studio_save_draft' });
      toast.error(errMessage(e, 'Could not save the draft.'));
    } finally { setBusy(null); }
  };
  const writeAi = async (): Promise<void> => {
    setAiBusy(true);
    try {
      const r = await copyAi(design.id);
      setName(r.name); setDesc(r.description);
      setDesign({ ...design, copy: { ...design.copy, name: r.name, description: r.description, seo_title: r.seo_title } });
    } catch (e) {
      captureException(e, { where: 'studio_copy_ai' });
      toast.error(errMessage(e, 'The writing helper could not answer. Write it yourself or try again.'));
    } finally { setAiBusy(false); }
  };
  const publish = async (): Promise<void> => {
    if (!canPublish) return;
    setBusy('Publishing…'); setProblem(null);
    try {
      await updateDesign(design.id, { copy: { ...design.copy, name: name.trim(), description: desc }, prices: pricesBody() });
      const r = await publishDesign(design.id, { collection_id: collectionId, badge, prices: pricesBody(), slots: ['new_arrivals'] });
      setSteps(r.steps); setDesign(r.design);
      const nFailed = r.steps.filter((s) => s.status === 'failed').length;
      capture('studio_published', { steps_failed: nFailed });
      if (nFailed === 0) toast.success('Published to the shop.'); else toast.error(`${nFailed} step${nFailed === 1 ? '' : 's'} need another try.`);
    } catch (e) {
      captureException(e, { where: 'studio_publish' });
      setProblem(errMessage(e, 'Publishing did not finish. Press Publish again to continue where it stopped.'));
    } finally { setBusy(null); }
  };

  const staticSteps: { title: string; sub: string }[] = [
    { title: 'Upload print file to Printrove', sub: 'The partner keeps its own design number' },
    { title: 'Create the product at Printrove', sub: 'Placement and file saved there' },
    { title: `Link ${sizes.length * Math.max(1, design.colours.length)} sizes and colours`, sub: `${Math.max(1, design.colours.length)} colours × ${sizes.length} sizes, each tied to Printrove's item` },
    { title: 'Create the shop product', sub: `Live · ${colName} collection · ${keptPhotos} photos + plain-shirt pictures` },
    { title: 'Show on New arrivals', sub: '' },
  ];
  const rows = steps && steps.length > 0
    ? steps.map((s, i) => ({ title: s.label, sub: s.note, cls: s.status === 'failed' ? 'bad' : s.status === 'done' ? 'ok' : 'wait', mark: s.status === 'failed' ? '✗' : s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : String(i + 1) }))
    : staticSteps.map((s, i) => ({ title: s.title, sub: s.sub, cls: 'wait', mark: String(i + 1) }));
  const half = Math.ceil(rows.length / 2);

  return (
    <Page>
      <TopBar design={design} />
      <Steps id={design.id} current="publish" design={design} />
      <div className="g2">
        <div className="panel"><h2>What Printrove will print</h2>
          <ul className="list">
            <li><span className="dot ok">✓</span><div><b>Product</b><br />{area?.label ?? fit?.label ?? 'Chosen product'}{design.colours.length ? ` · ${design.colours.join(', ')}` : ''}</div></li>
            <li><span className={`dot ${pl ? 'ok' : 'warn'}`}>{pl ? '✓' : '!'}</span><div><b>Print</b><br />
              {pl ? `${pl.side === 'front' ? 'Front' : 'Back'} · ${SHAPE_LABEL[pl.shape] ?? pl.shape}${pl.shape === 'none' ? '' : ` ${fmtIn(pl.frame_w_in)} × ${fmtIn(pl.frame_h_in)} in · ${fmtIn(pl.frame_top_in)} in below the top of the print area`}` : 'Not placed yet — go back to Step 3.'}</div></li>
            <li><span className={`dot ${hasPrint ? 'ok' : 'warn'}`}>{hasPrint ? '✓' : '!'}</span><div><b>Print file</b><br />
              {hasPrint ? `${design.print_w} × ${design.print_h} px PNG, see-through outside the ${pl?.shape === 'circle' ? 'circle' : 'frame'} · ${pl?.dpi ?? '—'} DPI` : 'Not made yet — press “Looks good” in Step 3.'}</div></li>
            <li><span className={`dot ${hasPrint ? 'ok' : 'wait'}`}>{hasPrint ? '✓' : '·'}</span><div><b>Within Printrove limits</b><br />
              {area ? `Print area ${fmtIn(area.w)} × ${fmtIn(area.h)} in · ` : ''}file under 5000 × 5000 px · RGB</div></li>
          </ul></div>
        <div className="panel"><div className="foot" style={{ margin: '0 0 12px' }}><h2>Words</h2>
          <button className="btn ghost sm" type="button" disabled={aiBusy} onClick={() => void writeAi()}>{aiBusy ? 'Writing…' : 'Write with AI'}</button></div>
          <label className="lbl">Product name<input className="fld" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
          <label className="lbl" style={{ marginTop: 12 }}>Description<textarea className="fld" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></label>
          <div className="g2" style={{ marginTop: 12 }}>
            <label className="lbl">Collection
              <select className="fld" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="">Choose…</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="lbl">Badge
              <select className="fld" value={badge} onChange={(e) => setBadge(e.target.value)}>
                {BADGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label></div></div>
      </div>

      <div className="panel"><div className="foot" style={{ margin: '0 0 6px' }}><h2>Sizes and prices</h2>
        <button className="btn ghost sm" type="button" disabled={!suggestable} onClick={suggest}>Suggest prices</button></div>
        <p className="lead">Shipping is free for the buyer and included in your price; GST 18% is added at checkout.</p>
        {unsold.length > 0 && (
          <p className="errtxt" role="alert" style={{ margin: '0 0 12px' }}>
            {unsold.join(', ')} {unsold.length === 1 ? 'is' : 'are'} not sold by Printrove. <a href={stepHref(design.id, 'product')}>Pick the colours again in the Product step</a> before publishing.
          </p>
        )}
        {builtin && (
          <p className="note" role="status" style={{ marginBottom: 12 }}>
            Printrove catalogue unavailable — showing estimates. {design.catalog_reason ?? ''} Printrove&apos;s costs cannot be shown until it is back, so set prices with care.
          </p>
        )}
        {!builtin && !costs && <p className="note" style={{ marginBottom: 12 }}>Place the print in Step 3 to see what Printrove charges for it.</p>}
        <div style={{ overflowX: 'auto', borderRadius: 20 }}>
          <table className="tbl">
            <thead><tr><th>Size</th><th>Printrove cost</th><th>Printrove GST</th><th>Shipping</th><th>Your cost</th><th>Your price ₹</th><th>Profit</th><th>GST 18%</th><th>Buyer pays</th></tr></thead>
            <tbody>
              {sizes.map((sz) => {
                const n = priceNum(sz);
                const c = builtin ? undefined : costBySize.get(sz);
                const total = c && typeof c.total_rupees === 'number' ? up(c.total_rupees) : null;
                const profit = n && total !== null ? n - total : null;
                const gst = c ? gstAmount(c) : null;
                return (
                  <tr key={sz}>
                    <td><b>{sz}</b></td>
                    <td>{c && c.garment_rupees && c.print_rupees ? `${rangeText(c.garment_rupees)} + ${rangeText(c.print_rupees)}` : '—'}</td>
                    <td>{c && gst !== null ? `${inr(up(gst))} (${c.partner_gst_pct}%)` : '—'}</td>
                    <td>{c && c.shipping_rupees !== null ? inr(up(c.shipping_rupees)) : '—'}</td>
                    <td><b>{total !== null ? inr(total) : '—'}</b></td>
                    <td><input className="fld" style={{ minHeight: 38, width: 110 }} inputMode="numeric" aria-label={`Price for ${sz}`} value={prices[sz] ?? ''}
                      onChange={(e) => setPrices((p) => ({ ...p, [sz]: e.target.value.replace(/[^\d]/g, '') }))} /></td>
                    <td>{profit !== null ? <b style={{ color: profit > 0 ? '#1e7a44' : '#b3261e' }}>{profit < 0 ? '−' : ''}{inr(Math.abs(profit))}</b> : '—'}</td>
                    <td>{n ? inr(gstOn(n)) : '—'}</td><td><b>{n ? inr(n + gstOn(n)) : '—'}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ font: '600 14px Nunito', color: '#6b4a2b', margin: '12px 0 0' }}>
          Costs are Printrove&apos;s prices today for this print size; GST and shipping are estimates until the first real order.
        </p>
        {bigDiffer && <p className="note" style={{ marginTop: 12 }}>2XL and larger are priced the same for now — the shop charges one price per product, so {inr(base)} applies to every size.</p>}
      </div>

      <div className="panel"><h2>Publish</h2>
        <p className="lead">Each step can be retried on its own. Nothing goes live until all are green.</p>
        <div className="g2">
          {[rows.slice(0, half), rows.slice(half)].map((col, ci) => (
            <ul className="list" key={ci}>
              {col.map((r, i) => (
                <li key={`${ci}-${i}`}><span className={`dot ${r.cls}`}>{r.mark}</span><div><b>{r.title}</b>{r.sub ? <><br />{r.sub}</> : null}</div></li>
              ))}
            </ul>
          ))}
        </div>
        {problem && <p className="errtxt" role="alert">{problem}</p>}
        {busy && <p className="lead" role="status" style={{ margin: '12px 0 0' }}>{busy}</p>}
        {!hasPrint && <p className="errtxt">Make the print file in Step 3 first. <a href={stepHref(design.id, 'design')}>Open Step 3</a></p>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn red" type="button" disabled={!canPublish} onClick={() => void publish()}>{failed > 0 ? 'Retry failed steps' : published ? 'Publish again' : 'Publish now'}</button>
          <button className="btn ghost" type="button" disabled={!!busy} onClick={() => void saveDraft()}>Save as draft</button>
          {published && <a className="btn teal" href="/admin/shop/products">See it in Products</a>}
        </div></div>
    </Page>
  );
}
