/* ProductStep — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Step 2, replica of Specs/studio-mockup/Product.dc.html.
 * Data: GET designs/:id/fits (every catalogue product checked against the file + the best-match text),
 * ticks → PUT products. Deliberate addition: a "Colours you will sell" row (the mockup has no place to
 * choose them, but Photos/Publish need the list). */
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { capture, captureException } from '../../../lib/analytics';
import {
  DEFAULT_COLOURS, errMessage, fmtIn, getFits, putProducts, stepHref, updateDesign,
  type ChosenProduct, type Fits, type FitItem,
} from '../../../lib/studioApi';
import { advanceTo } from './UploadStep';
import { LoadError, Loading, Page, Steps, TopBar, go, useDesign } from './StudioKit';

interface Row { key: string; items: FitItem[]; item: FitItem; sideLabel: string }

const keyOf = (kind: string, side: string): string => `${kind}|${side}`;
const verdictChip = (v: FitItem['verdict']): string => (v === 'great' ? 'ok' : v === 'good' ? 'warn' : v === 'small_only' ? 'info' : 'bad');
const verdictText = (v: FitItem['verdict']): string => (v === 'great' ? 'Great' : v === 'good' ? 'Good — just under 300' : v === 'small_only' ? 'Fits as a chest logo' : 'Too small');

/** One row per product; front and back are merged when they print the same (mockup: "Front / Back"). */
function buildRows(items: FitItem[]): Row[] {
  const rows: Row[] = [];
  const done = new Set<string>();
  for (const it of items) {
    const k = keyOf(it.kind, it.side);
    if (done.has(k)) continue;
    const twin = items.find((o) => o.kind === it.kind && o.side !== it.side && !done.has(keyOf(o.kind, o.side)));
    const same = twin && twin.area_in[0] === it.area_in[0] && twin.area_in[1] === it.area_in[1] && twin.verdict === it.verdict;
    if (twin && same) {
      const front = it.side === 'front' ? it : twin;
      done.add(k); done.add(keyOf(twin.kind, twin.side));
      rows.push({ key: keyOf(front.kind, 'front'), items: [it, twin], item: front, sideLabel: 'Front / Back' });
    } else {
      done.add(k);
      rows.push({ key: k, items: [it], item: it, sideLabel: it.side === 'front' ? 'Front' : 'Back' });
    }
  }
  return rows;
}

export default function ProductStep({ designId }: { designId: string }) {
  const { design, error, reload } = useDesign(designId);
  const [fits, setFits] = useState<Fits | null>(null);
  const [fitErr, setFitErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [colours, setColours] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { capture('studio_viewed', { step: 'product' }); }, []);
  useEffect(() => {
    let live = true;
    getFits(designId).then((f) => { if (live) setFits(f); }).catch((e) => {
      captureException(e, { where: 'studio_fits' });
      if (live) setFitErr(errMessage(e, 'Could not check the products against your file.'));
    });
    return () => { live = false; };
  }, [designId]);

  const rows = useMemo(() => (fits ? buildRows(fits.items) : []), [fits]);

  // Initial selection: what was saved, else the best match.
  useEffect(() => {
    if (!design || !fits || picked) return;
    const saved = design.products.map((p) => rows.find((r) => r.items.some((i) => i.kind === p.kind && i.side === p.side))?.key ?? keyOf(p.kind, p.side));
    if (saved.length) setPicked(new Set(saved));
    else if (fits.best) setPicked(new Set([keyOf(fits.best.kind, fits.best.side ?? 'front')]));
    else setPicked(new Set());
    // Colours Printrove does not sell on this product are not carried over: the owner picks again from the real list below.
    const sold = design.colour_info.filter((c) => !c.unavailable).map((c) => c.name);
    setColours(design.colours.length ? sold : (fits.best?.colours ?? []));
  }, [design, fits, picked, rows]);

  const offered = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (!picked?.has(r.key)) continue;
      for (const c of r.item.catalog?.colours ?? []) if (!map.has(c.name)) map.set(c.name, c.hex ?? DEFAULT_COLOURS.find((d) => d.name === c.name)?.hex ?? '#888888');
    }
    if (map.size === 0) for (const d of DEFAULT_COLOURS) map.set(d.name, d.hex);
    return [...map.entries()].map(([name, hex]) => ({ name, hex }));
  }, [rows, picked]);

  if (error && !design) return <Page><LoadError message={error} onRetry={() => void reload()} /></Page>;
  if (fitErr) return <Page><LoadError message={fitErr} onRetry={() => window.location.reload()} /></Page>;
  if (!design || !fits || !picked || !colours) return <Page><Loading what="Checking every product against your file…" /></Page>;

  const toggle = (k: string): void => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleColour = (n: string): void => setColours((c) => { const cur = c ?? []; return cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]; });
  const usable = colours.filter((c) => offered.some((o) => o.name === c));
  const ready = picked.size > 0 && usable.length > 0;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const chosen: ChosenProduct[] = [];
      for (const r of rows) {
        if (!picked.has(r.key)) continue;
        // A merged "Front / Back" row keeps the side the owner already chose in the editor.
        const keep = design.products.find((p) => p.kind === r.item.kind && r.items.some((i) => i.side === p.side));
        chosen.push({ kind: r.item.kind, provider_product_id: r.item.catalog?.provider_product_id ?? r.item.kind, side: keep?.side ?? r.item.side });
      }
      await putProducts(design.id, chosen);
      await updateDesign(design.id, { colours: usable });
      await advanceTo(design, 'design');
      go(stepHref(design.id, 'design'));
    } catch (e) {
      captureException(e, { where: 'studio_put_products' });
      toast.error(errMessage(e, 'Could not save your choice.'));
      setBusy(false);
    }
  };

  const best = fits.best;
  const bestItem = best ? fits.items.find((i) => i.kind === best.kind) : undefined;
  const artImg = design.art_preview_url;

  return (
    <Page>
      <TopBar design={design} />
      <Steps id={design.id} current="product" design={design} />
      {design.catalog_source === 'builtin' && (
        <p className="note" role="status" style={{ marginBottom: 18 }}>
          Printrove catalogue unavailable — showing estimates{design.catalog_reason ? `. ${design.catalog_reason}` : ''} Colours and sizes here are not Printrove&apos;s own, so check again once it is back.
        </p>
      )}
      {best && (
        <div className="panel" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="ph chk" style={{ width: 140, height: 140, borderStyle: 'solid', padding: 10 }}>
            {artImg && <img src={artImg} alt="" style={{ maxWidth: 110, maxHeight: 110, objectFit: 'contain' }} />}
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <span className="chip ok">Best match</span>
            <h2 style={{ marginTop: 8 }}>{bestItem?.label ?? best.kind}{best.colours.length ? ` · ${best.colours.join(', ')}` : ''}</h2>
            <p style={{ font: '700 15px/1.6 Nunito', color: '#3c4a4c', margin: '6px 0 0' }}>{best.text}</p>
          </div>
        </div>
      )}
      <div className="panel">
        <h2>All Printrove products, checked against your file</h2>
        <p className="lead">Tick each product you want to sell this design on. Each one becomes its own listing.</p>
        <div style={{ overflowX: 'auto', borderRadius: 20 }}>
          <table className="tbl">
            <thead><tr><th>Product</th><th>Side</th><th>Max print area</th><th>Sharp at 300 DPI</th><th>Fit</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const it = r.item;
                const sharpText = it.sharp_w_in < it.area_in[0] - 0.05 ? `Up to ${fmtIn(it.sharp_w_in)} in wide` : `Full width (${Math.round(it.full_area_dpi)} DPI)`;
                return (
                  <tr key={r.key}>
                    <td><label className="row" style={{ font: '800 15px Nunito', color: '#5a1f14' }}>
                      <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r.key)} /> {it.label}
                    </label></td>
                    <td>{r.sideLabel}</td>
                    <td>{fmtIn(it.area_in[0])} × {fmtIn(it.area_in[1])} in</td>
                    <td>{sharpText}</td>
                    <td><span className={`chip ${verdictChip(it.verdict)}`}>{it.note || verdictText(it.verdict)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ font: '600 14px Nunito', color: '#6b4a2b', margin: '12px 0 0' }}>
          Sizes, colours and Printrove&apos;s prices come from Printrove&apos;s own catalogue. What each size costs you is on the Publish step.
        </p>
      </div>
      <div className="panel">
        <h2>Colours you will sell</h2>
        <p className="lead">Tick every shirt colour this design is sold in. Your photos and the plain-shirt pictures follow this list.</p>
        {design.colour_info.some((c) => c.unavailable) && (
          <div className="note" role="alert" style={{ marginBottom: 14 }}>
            <b>Not sold by Printrove — pick again:</b>{' '}
            {design.colour_info.filter((c) => c.unavailable).map((c, i) => (
              <span key={c.name} style={{ marginRight: 10 }}><i style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', background: c.hex, border: '2px solid #0002', verticalAlign: '-2px', marginRight: 4 }}></i>{c.name}{i < design.colour_info.filter((x) => x.unavailable).length - 1 ? ',' : ''}</span>
            ))}
            <br />Choose from the colours below, which are the ones Printrove really prints this product in.
          </div>
        )}
        <div className="row">
          {offered.map((c) => (
            <button key={c.name} type="button" className={`sw${usable.includes(c.name) ? ' on' : ''}`} aria-pressed={usable.includes(c.name)} onClick={() => toggleColour(c.name)}>
              <i style={{ background: c.hex }}></i>{c.name}
            </button>
          ))}
        </div>
        {picked.size > 0 && usable.length === 0 && <p className="errtxt">Pick at least one colour.</p>}
      </div>
      <div className="foot">
        <a className="btn ghost" href={stepHref(design.id, 'upload')}>Back</a>
        <button type="button" className="btn red" disabled={!ready || busy} onClick={() => void save()}>Design on the shirt →</button>
      </div>
    </Page>
  );
}
