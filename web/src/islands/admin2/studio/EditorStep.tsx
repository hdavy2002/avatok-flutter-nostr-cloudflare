/* EditorStep — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] Step 3, replica of Specs/studio-mockup/Editor.dc.html with the REAL artwork.
 * Geometry/maths are the mockup's script block, ported to lib/studioGeometry.ts (shared with printFile.ts and composite.ts).
 * Additions beyond the mockup: pointer-drag of the art inside the frame, non-square art, the print area of the chosen
 * product/side from the catalogue, and the actual 300 DPI export on "Looks good →" (lib/printFile.ts, loaded on demand). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { capture, captureException } from '../../../lib/analytics';
import {
  DEFAULT_COLOURS, areaFor, errMessage, getFits, hexForColour, newVersion, putPlacement, putProducts, stepHref,
  uploadPrint, uploadPrintPreview, type ChosenProduct, type Fits,
} from '../../../lib/studioApi';
import {
  EXPORT_DPI, EXPORT_MAX_PX, NECK_PATH, SHIRT_PATH, STAGE_H, STAGE_PX_PER_IN as P, STAGE_W, areaRectPx, computeLayout, dpiQuality,
  isLightColour, printRectIn, type EditorState, type FrameShape, type PrintSide,
} from '../../../lib/studioGeometry';
import { LoadError, Loading, Page, Steps, TopBar, go, useDesign } from './StudioKit';

const SHAPES: [FrameShape, string][] = [['none', 'No frame'], ['rect', 'Rectangle'], ['square', 'Square'], ['circle', 'Circle']];
const px = (inches: number): number => Math.min(EXPORT_MAX_PX, Math.round(inches * EXPORT_DPI));
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export default function EditorStep({ designId }: { designId: string }) {
  const { design, error, reload } = useDesign(designId);
  const [fits, setFits] = useState<Fits | null>(null);
  const [fitErr, setFitErr] = useState<string | null>(null);
  const [s, setS] = useState<EditorState>({ shape: 'circle', frame: 11, zoom: 100, nudgeX: 0, nudgeY: 0, top: 2.5 });
  const [side, setSide] = useState<PrintSide>('front');
  const [colour, setColour] = useState<string>('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; nx: number; ny: number } | null>(null);

  useEffect(() => { capture('studio_viewed', { step: 'design' }); }, []);
  useEffect(() => {
    let live = true;
    getFits(designId).then((f) => { if (live) setFits(f); }).catch((e) => {
      captureException(e, { where: 'studio_fits' });
      if (live) setFitErr(errMessage(e, 'Could not load the print areas.'));
    });
    return () => { live = false; };
  }, [designId]);

  const product: ChosenProduct | null = design?.products[0] ?? null;
  const kind = product?.kind ?? '';
  const areaOf = (sd: PrintSide): { w: number; h: number; label: string } => {
    const it = fits?.items.find((i) => i.kind === kind && i.side === sd);
    const base = areaFor(kind, sd);
    return it ? { w: it.area_in[0], h: it.area_in[1], label: it.label } : base;
  };
  const area = areaOf(side);

  const colours = useMemo(() => {
    const names = design?.colours.length ? design.colours : DEFAULT_COLOURS.map((c) => c.name);
    return names.map((n) => ({ name: n, hex: hexForColour(n, fits) }));
  }, [design, fits]);

  // One-time setup from the saved placement (or the mockup defaults).
  useEffect(() => {
    if (!design || !fits || ready || !product) return;
    const pl = design.placement;
    const sd: PrintSide = pl?.side ?? product.side ?? 'front';
    const a = areaOf(sd);
    setSide(sd);
    if (pl) {
      setS({ shape: pl.shape, frame: pl.frame_w_in, zoom: pl.zoom_pct, nudgeX: pl.nudge_x_in, nudgeY: pl.nudge_y_in, top: pl.frame_top_in });
    } else {
      setS({ shape: 'circle', frame: Math.min(11, a.w), zoom: 100, nudgeX: 0, nudgeY: 0, top: Math.min(2.5, Math.max(0, a.h - Math.min(11, a.w))) });
    }
    setColour(colours[0]?.name ?? '');
    setReady(true);
    // areaOf/colours derive from design+fits which are in the deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, fits, ready, product, colours]);

  if (error && !design) return <Page><LoadError message={error} onRetry={() => void reload()} /></Page>;
  if (fitErr) return <Page><LoadError message={fitErr} onRetry={() => window.location.reload()} /></Page>;
  if (!design || !fits) return <Page><Loading what="Opening the editor…" /></Page>;
  if (!product) {
    return (
      <Page><TopBar design={design} /><Steps id={design.id} current="design" design={design} />
        <div className="panel"><h2>Choose a product first</h2><p className="lead">The editor needs to know which shirt and print area to use.</p>
          <a className="btn teal sm" href={stepHref(design.id, 'product')}>Go to Product</a></div></Page>
    );
  }
  if (!ready) return <Page><Loading what="Opening the editor…" /></Page>;

  const artDim = { w: design.art_w ?? 1000, h: design.art_h ?? 1000 };
  const L = computeLayout(s, artDim, area);
  const ar = areaRectPx(area);
  const q = dpiQuality(L.dpi);
  const colourHex = colours.find((c) => c.name === colour)?.hex ?? colours[0]?.hex ?? '#1f1b1a';
  const light = isLightColour(colourHex);
  const guide = light ? '#7a4a1e' : '#F6B93B';
  const frameLine = s.shape === 'none' ? 'transparent' : light ? '#173f3f' : '#ffffff';
  const fl = ar.left + L.frameLeft * P; const ft = ar.top + L.frameTop * P;
  const fw = L.frameW * P; const fh = L.frameH * P;
  const aw = L.artW * P; const ah = L.artH * P;
  const al = L.artLeft * P; const at = L.artTop * P;
  const radius = s.shape === 'circle' ? '50%' : s.shape === 'none' ? '0' : '6px';
  const artUrl = design.art_url ?? design.art_preview_url;
  const set = (o: Partial<EditorState>): void => setS((cur) => ({ ...cur, ...o }));
  const blocked = q.blocks || L.empty || !!busy;

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = { x: e.clientX, y: e.clientY, nx: s.nudgeX, ny: s.nudgeY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    set({ nudgeX: clamp(d.nx + (e.clientX - d.x) / P, -60, 60), nudgeY: clamp(d.ny + (e.clientY - d.y) / P, -60, 60) });
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const looksGood = async (): Promise<void> => {
    if (blocked) return;
    if (design.locked_at && !window.confirm('This design is already live. Saving makes a new version of its print file. Continue?')) return;
    setProblem(null); setBusy('Making your print file…');
    try {
      if (!design.art_url) throw new Error('Your artwork is not available. Go back to Step 1 and upload it again.');
      const pf = await import('../../../lib/printFile');
      const bmp = await pf.loadBitmap(design.art_url);
      const out = await pf.renderPrintFile(bmp, L, s.shape);
      bmp.close();
      const pr = printRectIn(L);
      if (design.locked_at) await newVersion(design.id);
      setBusy('Saving the placement…');
      await putPlacement(design.id, {
        kind, side, shape: s.shape, frame_w_in: Math.round(L.frameW * 100) / 100, frame_h_in: Math.round(L.frameH * 100) / 100,
        frame_top_in: Math.round(L.frameTop * 100) / 100, zoom_pct: s.zoom, nudge_x_in: Math.round(s.nudgeX * 100) / 100, nudge_y_in: Math.round(s.nudgeY * 100) / 100,
        print_w_in: Math.round(pr.w * 100) / 100, print_h_in: Math.round(pr.h * 100) / 100, dpi: out.dpi,
        print_left_in: Math.round(pr.left * 100) / 100, print_top_in: Math.round(pr.top * 100) / 100,
      });
      setBusy('Uploading your print file…');
      await uploadPrint(design.id, out.blob);
      try { await uploadPrintPreview(design.id, out.preview); } catch (e) { captureException(e, { where: 'studio_print_preview' }); }
      if (side !== product.side) await putProducts(design.id, design.products.map((p, i) => (i === 0 ? { ...p, side } : p)));
      capture('studio_placement_saved', { shape: s.shape, dpi: out.dpi });
      go(stepHref(design.id, 'photos'));
    } catch (e) {
      captureException(e, { where: 'studio_print_file' });
      setProblem(errMessage(e, e instanceof Error && e.message ? e.message : 'Could not make the print file.'));
      toast.error('Could not make the print file.');
      setBusy(null);
    }
  };

  const visW = L.visW; const visH = L.visH;
  const hasBack = fits.items.some((i) => i.kind === kind && i.side === 'back');
  const sides: [PrintSide, string][] = hasBack ? [['front', 'Front'], ['back', 'Back']] : [['front', 'Front']];

  return (
    <Page>
      <TopBar design={design} />
      <Steps id={design.id} current="design" design={design} />
      <div className="ed-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 20, alignItems: 'start' }}>
        <div className="panel" style={{ padding: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="tabs" style={{ margin: 0 }}>
              {sides.map(([k, l]) => <button key={k} type="button" className={`opt${side === k ? ' on' : ''}`} onClick={() => setSide(k)}>{l}</button>)}
            </div>
            <span className="chip info">{area.label} · print area {area.w.toFixed(1)} × {area.h.toFixed(1)} in</span>
          </div>
          <div className="stage-wrap">
            <div className="stage" style={{ width: STAGE_W, height: STAGE_H }}>
              <svg viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} width={STAGE_W} height={STAGE_H} style={{ position: 'absolute', left: 0, top: 0 }} role="img" aria-label="T-shirt">
                <path d={SHIRT_PATH} fill={colourHex} stroke="#00000033" strokeWidth="3" />
                <path d={NECK_PATH} fill="none" stroke="#00000040" strokeWidth="10" />
              </svg>
              <div style={{ position: 'absolute', left: ar.left, top: ar.top, width: ar.w, height: ar.h, border: `2px dashed ${guide}`, borderRadius: 4 }} />
              {artUrl && <img className="art-img" alt="" src={artUrl} draggable={false} style={{ position: 'absolute', left: fl + al, top: ft + at, width: aw, height: ah, opacity: 0.22, pointerEvents: 'none' }} />}
              <div className="frame-drag" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                style={{ position: 'absolute', left: fl, top: ft, width: fw, height: fh, borderRadius: radius, overflow: 'hidden', outline: `2px solid ${frameLine}`, outlineOffset: 2 }}>
                {artUrl && <img className="art-img" alt="Your artwork" src={artUrl} draggable={false} style={{ position: 'absolute', left: al, top: at, width: aw, height: ah }} />}
              </div>
              <span style={{ position: 'absolute', left: ar.left, top: ar.top + ar.h + 8, font: '800 13px Nunito', color: guide }}>Printrove print area · faded art = cut off, will not print</span>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className={`chip ${q.tone}`}>{q.text} · {L.dpi} DPI</span>
            <span className="chip">Prints at {visW.toFixed(1)} × {visH.toFixed(1)} in</span>
            <span className="chip">Print file {px(visW)} × {px(visH)} px</span>
          </div>
        </div>
        <div className="panel" style={{ padding: 18 }}>
          <div className="ctl"><h3>Frame shape</h3>
            <div className="row">{SHAPES.map(([k, l]) => <button key={k} type="button" className={`opt${s.shape === k ? ' on' : ''}`} onClick={() => set({ shape: k })}>{l}</button>)}</div></div>
          <div className="ctl"><h3>Frame size</h3>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="big">{s.shape === 'none' ? 'Whole print area' : `${L.frameW.toFixed(1)} × ${L.frameH.toFixed(1)} in`}</span></div>
            <input className="rng" type="range" min={3} max={area.w} step={0.2} value={clamp(s.frame, 3, area.w)} onChange={(e) => set({ frame: Number(e.target.value) })} aria-label="Frame size" /></div>
          <div className="ctl"><h3>Zoom artwork</h3>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn ghost sm" onClick={() => set({ zoom: Math.max(40, s.zoom - 10) })} aria-label="Zoom out">−</button>
              <span className="big">{s.zoom}%</span>
              <button type="button" className="btn ghost sm" onClick={() => set({ zoom: Math.min(300, s.zoom + 10) })} aria-label="Zoom in">+</button></div>
            <input className="rng" type="range" min={40} max={300} step={5} value={s.zoom} onChange={(e) => set({ zoom: Number(e.target.value) })} aria-label="Zoom artwork" /></div>
          <div className="ctl"><h3>Move artwork inside the frame</h3>
            <div className="row" style={{ gap: 16 }}>
              <div className="pad"><span></span>
                <button type="button" className="btn ghost" onClick={() => set({ nudgeY: s.nudgeY - 0.5 })} aria-label="Move up">↑</button><span></span>
                <button type="button" className="btn ghost" onClick={() => set({ nudgeX: s.nudgeX - 0.5 })} aria-label="Move left">←</button>
                <button type="button" className="btn teal" onClick={() => set({ nudgeX: 0, nudgeY: 0 })} aria-label="Centre">•</button>
                <button type="button" className="btn ghost" onClick={() => set({ nudgeX: s.nudgeX + 0.5 })} aria-label="Move right">→</button><span></span>
                <button type="button" className="btn ghost" onClick={() => set({ nudgeY: s.nudgeY + 0.5 })} aria-label="Move down">↓</button><span></span></div>
              <p style={{ font: '700 14px/1.5 Nunito', color: '#6b4a2b', margin: 0 }}>Each tap moves ½ inch. The dot puts it back in the middle. You can also drag the art with your finger or mouse.</p></div></div>
          <div className="ctl"><h3>Frame height on the shirt</h3>
            <div className="row">
              <button type="button" className="btn ghost sm" onClick={() => set({ top: Math.max(0, L.frameTop - 0.5) })}>Higher</button>
              <button type="button" className="btn ghost sm" onClick={() => set({ top: Math.min(area.h - L.frameH, L.frameTop + 0.5) })}>Lower</button>
              <span className="chip">{L.frameTop.toFixed(1)} in from top of print area</span></div></div>
          <div className="ctl"><h3>Shirt colour</h3>
            <div className="row">{colours.map((c) => (
              <button key={c.name} type="button" className={`sw${colour === c.name ? ' on' : ''}`} onClick={() => setColour(c.name)}><i style={{ background: c.hex }}></i>{c.name}</button>
            ))}</div></div>
          <div className="note">We cut your art to the frame and send Printrove a see-through PNG of only that part. The circle is printed exactly as you see it.</div>
          {busy && <p className="lead" style={{ margin: '12px 0 0' }} role="status">{busy}</p>}
          {problem && <p className="errtxt" role="alert">{problem}</p>}
          {L.empty && <p className="errtxt">None of your art is inside the frame. Move it back or make the frame bigger.</p>}
          <div className="foot" style={{ marginTop: 14 }}>
            <a className="btn ghost" href={stepHref(design.id, 'product')}>Back</a>
            <button type="button" className="btn red" disabled={blocked} onClick={() => void looksGood()}>Looks good →</button>
          </div>
        </div>
      </div>
    </Page>
  );
}
