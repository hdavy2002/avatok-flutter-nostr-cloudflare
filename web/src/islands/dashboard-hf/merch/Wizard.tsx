/* [HF-MERCH-CREATOR-WEB-1] "+ New product": 1 Upload art, 2 Pick shirt, 3 Place art (clipped 300 DPI print file), 4 Price and publish.
 * Reuses the admin Studio's pure logic (artAnalysis, lib/studioGeometry, lib/printFile, lib/composite); nothing there is admin-coupled. */
import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import {
  EXPORT_DPI, EXPORT_MAX_PX, NECK_PATH, SHIRT_PATH, STAGE_H, STAGE_PX_PER_IN as P, STAGE_W, areaRectPx, computeLayout, dpiQuality, isLightColour,
  printRectIn, type EditorState, type FrameShape, type SavedPlacement,
} from '../../../lib/studioGeometry';
import type { ArtAnalysis } from '../../admin2/studio/artAnalysis';
import { Dialog, Ic, Marigold } from '../v3/ui';
import {
  MARKUP_MAX, createProduct, fanPaysPaise, getQuote, rupees, uploadArt, uploadMockup, uploadPrintFile, youEarnPaise,
  type ArtUpload, type CatalogInfo, type CatalogItem, type Product,
} from './api';

const STEPS = ['Upload art', 'Pick shirt', 'Place art', 'Price & publish'];
const STEP_KEY = ['upload_art', 'pick_shirt', 'place_art', 'price_publish'];
const SHAPES: [FrameShape, string][] = [['none', 'No frame'], ['rect', 'Rectangle'], ['square', 'Square'], ['circle', 'Circle']];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const MAX_ART_BYTES = 15 * 1024 * 1024;
type Side = 'front' | 'back';
interface Placed { w: number; h: number; x: number; y: number; zoom: number; frame: FrameShape; dpi: number; printFileId: string; mockupUrls: string[]; previewUrl: string; key: string }

const qLabel = (dpi: number) => {
  const q = dpiQuality(dpi);
  return { ...q, text: q.tone === 'ok' ? 'Sharp' : q.tone === 'info' ? 'Good' : q.tone === 'warn' ? 'Soft' : 'Too blurry' };
};

export default function Wizard({ info, minMarkup, onClose, onPublished }: { info: CatalogInfo; minMarkup: number; onClose: () => void; onPublished: (p: Product) => void }) {
  const [step, setStep] = useState(0);
  const [analysis, setAnalysis] = useState<ArtAnalysis | null>(null);
  const [art, setArt] = useState<ArtUpload | null>(null);
  const [own, setOwn] = useState(false);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [colours, setColours] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [side, setSide] = useState<Side>('front');
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [leave, setLeave] = useState(false);
  const [done, setDone] = useState<Product | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => { capture('merch_studio_step', { step: done ? 'published' : STEP_KEY[step] }); topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [step, done]);
  useEffect(() => () => { if (analysis) URL.revokeObjectURL(analysis.previewUrl); }, [analysis]);

  if (done) return <div className="h3-card"><div className="mc-done" ref={topRef}>
    <Marigold size={72} />
    <h2 style={{ justifyContent: 'center' }}>{done.status === 'live' ? 'Your product is live' : 'Sent for review'}</h2>
    <p className="muted" style={{ maxWidth: '34rem' }}>{done.status === 'live' ? 'Fans can buy it now. Share the link from your products page.' : 'Our team will check your art, then it goes on sale. You will see the status on your products page.'}</p>
    <button type="button" className="h3-btn rani mc-big" onClick={() => onPublished(done)}>Back to my products</button>
  </div></div>;

  const pickItem = (c: CatalogItem) => {
    setItem(c); setColours(c.colours.slice(0, 1).map(x => x.name)); setSizes(c.sizes.map(s => s.size)); setSide('front'); setPlaced(null);
  };

  return <div className="h3-card" ref={topRef}>
    <div className="top"><div><h2><Marigold size={20} />New product</h2><div className="note">Put your art on a T-shirt and set your price.</div></div>
      <button type="button" className="h3-btn sm ghost" onClick={() => (analysis || art ? setLeave(true) : onClose())}>Close</button></div>
    <ol className="mc-steps" aria-label="Steps">{STEPS.map((s, i) => <li key={s} className={i === step ? 'cur' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span className="n">{i + 1}</span>{s}</li>)}</ol>
    <p className="small muted" style={{ marginBottom: 14 }}>Step {step + 1} of 4</p>

    {step === 0 && <UploadStep analysis={analysis} art={art} own={own} setOwn={setOwn}
      onUploaded={(a, u) => { setAnalysis(a); setArt(u); setPlaced(null); }} onNext={() => setStep(1)} />}
    {step === 1 && <ShirtStep info={info} item={item} colours={colours} sizes={sizes} side={side} pick={pickItem} setColours={setColours} setSizes={setSizes} setSide={s => { setSide(s); setPlaced(null); }}
      onBack={() => setStep(0)} onNext={() => setStep(2)} />}
    {step === 2 && item && analysis && art && <PlaceStep item={item} colours={colours} side={side} analysis={analysis} art={art} initial={placed}
      onBack={() => setStep(1)} onPlaced={p => { setPlaced(p); setStep(3); }} />}
    {step === 3 && item && art && placed && <PriceStep info={info} item={item} colours={colours} sizes={sizes} side={side} art={art} placed={placed} minMarkup={minMarkup}
      onBack={() => setStep(2)} onDone={setDone} />}

    <Dialog open={leave} onClose={() => setLeave(false)} label="Leave without saving">
      <h2>Leave without publishing?</h2><p className="muted" style={{ marginTop: 8 }}>Your art is saved with us, but this product is not made yet.</p>
      <div className="acts"><button type="button" className="h3-btn ghost mc-big" onClick={() => setLeave(false)}>Keep working</button><button type="button" className="h3-btn rani mc-big" onClick={onClose}>Leave</button></div>
    </Dialog>
  </div>;
}

/* ── 1 · Upload art ───────────────────────────────────────────────────── */
function UploadStep({ analysis, art, own, setOwn, onUploaded, onNext }: { analysis: ArtAnalysis | null; art: ArtUpload | null; own: boolean; setOwn: (v: boolean) => void; onUploaded: (a: ArtAnalysis, u: ArtUpload) => void; onNext: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function take(file: File | undefined) {
    if (!file || busy) return;
    setErr(null); setBusy('Checking your art…');
    try {
      const { analyseArtwork } = await import('../../admin2/studio/artAnalysis');
      const a = await analyseArtwork(file);
      if (a.w < 300 || a.h < 300) { URL.revokeObjectURL(a.previewUrl); throw new Error('This image is too small to print well. Use one that is at least 300 × 300 pixels.'); }
      if (a.bytes > MAX_ART_BYTES) { URL.revokeObjectURL(a.previewUrl); throw new Error('This file is bigger than 15 MB. Please save a smaller copy.'); }
      setBusy('Uploading and checking it with our safety check…');
      const r = await uploadArt(a.blob, a.fileName);
      if (!r.ok) { URL.revokeObjectURL(a.previewUrl); setErr(r.message || 'Upload failed.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_art_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'upload_art' }); }
      else onUploaded(a, r.data);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'We could not read that image.');
      captureException(e, { area: 'hf_merch_creator', step: 'upload_art' });
    } finally { setBusy(null); if (input.current) input.current.value = ''; }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files?.[0]); };
  const warns = art?.checks.warnings ?? [];
  const review = warns.some(w => /checked by our team/i.test(w));
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div className={`mc-drop${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
      onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }} aria-label="Choose your art">
      {analysis ? <img className="mc-artprev" src={analysis.previewUrl} alt="Your art" /> : <Ic name="plus" className="" size={44} />}
      <b>{analysis ? 'Choose a different picture' : 'Drop your art here, or tap to choose'}</b>
      <span className="small muted">PNG or JPG, at least 300 × 300 pixels, up to 15 MB. A PNG with a see-through background prints best.</span>
      <input ref={input} type="file" accept="image/png,image/jpeg" hidden onChange={e => void take(e.target.files?.[0])} />
    </div>
    {busy && <p role="status" className="muted">{busy}</p>}
    {err && <p role="alert" className="mc-err">{err}</p>}
    {analysis && art && <div className="mc-ok-box" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="mc-ok">Art check passed{review ? ', and our team will look at it before it goes on sale' : ''}.</div>
      <div className="small muted">{art.width} × {art.height} px{analysis.has_alpha ? ' · see-through background' : ' · solid background'}{analysis.trimmed_px ? ' · empty edges trimmed' : ''}</div>
      {warns.filter(w => !/checked by our team/i.test(w)).map(w => <div key={w} className="small mc-warn">{w}</div>)}
      {analysis.soft_edge_pct > 25 && <div className="small mc-warn">Edges look soft. It may print a little fuzzy.</div>}
    </div>}
    <label className="mc-check"><input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)} /><span>I own this art, or I have the right to sell it on a T-shirt.</span></label>
    <div className="mc-foot"><span /><button type="button" className="h3-btn rani mc-big" disabled={!art || !own || !!busy} onClick={onNext}>Next: pick a shirt →</button></div>
  </div>;
}

/* ── 2 · Pick shirt ───────────────────────────────────────────────────── */
function ShirtStep({ info, item, colours, sizes, side, pick, setColours, setSizes, setSide, onBack, onNext }: {
  info: CatalogInfo; item: CatalogItem | null; colours: string[]; sizes: string[]; side: Side; pick: (c: CatalogItem) => void;
  setColours: (c: string[]) => void; setSizes: (s: string[]) => void; setSide: (s: Side) => void; onBack: () => void; onNext: () => void;
}) {
  const tog = (arr: string[], v: string, max = 99) => (arr.includes(v) ? arr.filter(x => x !== v) : arr.length >= max ? arr : [...arr, v]);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    {info.items.length === 0 && <p className="muted">No shirts are available right now. Please try again in a little while.</p>}
    <div className="mc-cats" role="radiogroup" aria-label="Shirt">{info.items.map(c => {
      const from = Math.min(...c.sizes.map(s => s.basePaise));
      return <button key={c.id} type="button" role="radio" aria-checked={item?.id === c.id} className={`mc-cat${item?.id === c.id ? ' on' : ''}`} onClick={() => pick(c)}>
        <Ic name="shirt" className="" size={36} /><b>{c.name}</b>
        <span className="small muted">Base price from {rupees(from)}</span>
        <span className="mc-sw" aria-hidden="true" style={{ gap: 4 }}>{c.colours.slice(0, 8).map(x => <i key={x.name} style={{ width: 18, height: 18, borderRadius: '50%', background: x.hex, border: '1px solid rgba(0,0,0,.2)', display: 'block' }} />)}</span>
      </button>;
    })}</div>
    {item && <>
      <div className="mc-ctl"><h3>Where does the print go?</h3><div className="mc-sw">{item.side.map(s => <button key={s} type="button" className={side === s ? 'on' : ''} aria-pressed={side === s} onClick={() => setSide(s)}>{s === 'front' ? 'Front' : 'Back'}</button>)}</div></div>
      <div className="mc-ctl"><h3>Colours <span className="small muted">(pick up to 8)</span></h3><div className="mc-sw">{item.colours.map(c =>
        <button key={c.name} type="button" className={colours.includes(c.name) ? 'on' : ''} aria-pressed={colours.includes(c.name)} onClick={() => setColours(tog(colours, c.name, 8))}><i style={{ background: c.hex }} />{c.name}</button>)}</div></div>
      <div className="mc-ctl"><h3>Sizes and base price</h3>
        <div className="mc-sw">{item.sizes.map(s => <button key={s.size} type="button" className={sizes.includes(s.size) ? 'on' : ''} aria-pressed={sizes.includes(s.size)} onClick={() => setSizes(tog(sizes, s.size))}>{s.size} · {rupees(s.basePaise)}</button>)}</div>
        <p className="small muted">The base price covers printing and delivery. Your markup is added on top in the last step. The exact base for your print size is shown there.</p></div>
    </>}
    <div className="mc-foot"><button type="button" className="h3-btn ghost mc-big" onClick={onBack}>← Back</button>
      <button type="button" className="h3-btn rani mc-big" disabled={!item || !colours.length || !sizes.length} onClick={onNext}>Next: place your art →</button></div>
  </div>;
}

/* ── 3 · Place art ────────────────────────────────────────────────────── */
function PlaceStep({ item, colours, side, analysis, art, initial, onBack, onPlaced }: {
  item: CatalogItem; colours: string[]; side: Side; analysis: ArtAnalysis; art: ArtUpload; initial: Placed | null; onBack: () => void; onPlaced: (p: Placed) => void;
}) {
  const area = useMemo(() => ({ w: item.printArea.wIn, h: item.printArea.hIn }), [item]);
  const swatches = useMemo(() => item.colours.filter(c => colours.includes(c.name)), [item, colours]);
  const [s, setS] = useState<EditorState>(() => {
    const zoom = clamp(Math.round((11 / area.w) * 100), 40, 100);
    const artH = ((area.w * zoom) / 100) * (art.height / art.width);
    return { shape: 'none', frame: Math.min(11, area.w), zoom, nudgeX: 0, nudgeY: clamp(2 - (area.h - artH) / 2, -60, 60), top: Math.min(2.5, Math.max(0, area.h - Math.min(11, area.w))) };
  });
  const [colour, setColour] = useState(swatches[0]?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; nx: number; ny: number } | null>(null);

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const fit = () => setScale(Math.min(1, Math.max(0.3, (el.clientWidth - 16) / STAGE_W)));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  void initial;

  const L = computeLayout(s, { w: art.width, h: art.height }, area);
  const ar = areaRectPx(area);
  const q = qLabel(L.dpi);
  const hex = swatches.find(c => c.name === colour)?.hex ?? swatches[0]?.hex ?? '#ffffff';
  const light = isLightColour(hex);
  const guide = light ? '#7a4a1e' : '#F6B93B';
  const frameLine = s.shape === 'none' ? 'transparent' : light ? '#173f3f' : '#ffffff';
  const fl = ar.left + L.frameLeft * P, ft = ar.top + L.frameTop * P, fw = L.frameW * P, fh = L.frameH * P;
  const radius = s.shape === 'circle' ? '50%' : s.shape === 'none' ? '0' : '8px';
  const set = (o: Partial<EditorState>) => setS(c => ({ ...c, ...o }));
  const blocked = q.blocks || L.empty || !!busy;

  const down = (e: PointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, y: e.clientY, nx: s.nudgeX, ny: s.nudgeY }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent<HTMLDivElement>) => { const d = drag.current; if (d) set({ nudgeX: clamp(d.nx + (e.clientX - d.x) / (P * scale), -60, 60), nudgeY: clamp(d.ny + (e.clientY - d.y) / (P * scale), -60, 60) }); };
  const up = (e: PointerEvent<HTMLDivElement>) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); };

  async function looksGood() {
    if (blocked) return;
    setProblem(null); setBusy('Making your print file…');
    const bmps: ImageBitmap[] = [];
    try {
      const [pf, comp] = await Promise.all([import('../../../lib/printFile'), import('../../../lib/composite')]);
      const artBmp = await createImageBitmap(analysis.blob); bmps.push(artBmp);
      const out = await pf.renderPrintFile(artBmp, L, s.shape);
      const pr = printRectIn(L);
      setBusy('Saving your print file…');
      const up = await uploadPrintFile(art.artId, out.blob);
      if (!up.ok) { setProblem(up.message || 'Could not save the print file.'); if (up.status >= 500 || up.status === 0) captureException(new Error(`merch_print_${up.status}_${up.code}`), { area: 'hf_merch_creator', step: 'place_art' }); setBusy(null); return; }
      setBusy('Making pictures of your shirt…');
      const printBmp = await createImageBitmap(out.blob); bmps.push(printBmp);
      const sp: SavedPlacement = {
        kind: item.kind, side, shape: s.shape, frame_w_in: L.frameW, frame_h_in: L.frameH, frame_top_in: L.frameTop, zoom_pct: s.zoom, nudge_x_in: s.nudgeX, nudge_y_in: s.nudgeY,
        print_w_in: pr.w, print_h_in: pr.h, dpi: out.dpi, print_left_in: pr.left, print_top_in: pr.top,
      };
      const urls: string[] = [];
      for (const c of swatches.slice(0, 4)) {
        try {
          const blob = await comp.flatShirtPicture(printBmp, sp, area, c.hex, 900);
          const m = await uploadMockup(blob);
          if (m.ok) urls.push(m.data.url);
        } catch (e) { captureException(e, { area: 'hf_merch_creator', step: 'mockup' }); }
      }
      onPlaced({ w: r2(pr.w), h: r2(pr.h), x: r2(pr.left), y: r2(pr.top), zoom: s.zoom, frame: s.shape, dpi: out.dpi, printFileId: up.data.printFileId, mockupUrls: urls, previewUrl: URL.createObjectURL(out.preview), key: `${Date.now()}` });
    } catch (e) {
      captureException(e, { area: 'hf_merch_creator', step: 'place_art' });
      setProblem(e instanceof Error && e.message ? e.message : 'Could not make the print file.');
      setBusy(null);
    } finally { bmps.forEach(b => b.close()); }
  }

  return <div className="h3-row c21" style={{ alignItems: 'start' }}>
    <div>
      <div className="mc-chips" style={{ marginBottom: 8 }}>
        <span className={`mc-q ${q.tone}`}>{q.text} · {L.dpi} DPI</span>
        <span className="h3-chip lav">Prints {L.visW.toFixed(1)} × {L.visH.toFixed(1)} in</span>
        <span className="h3-chip dec">{side === 'front' ? 'Front' : 'Back'} print area {area.w.toFixed(1)} × {area.h.toFixed(1)} in</span>
      </div>
      <div className="mc-stage-wrap" ref={wrap}>
        <div style={{ width: STAGE_W * scale, height: STAGE_H * scale, margin: '0 auto', position: 'relative' }}>
          <div className="mc-stage" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}>
            <svg viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} width={STAGE_W} height={STAGE_H} style={{ position: 'absolute', left: 0, top: 0 }} role="img" aria-label="T-shirt">
              <path d={SHIRT_PATH} fill={hex} stroke="#00000033" strokeWidth="3" />
              {side === 'front' && <path d={NECK_PATH} fill="none" stroke="#00000040" strokeWidth="10" />}
            </svg>
            <div style={{ position: 'absolute', left: ar.left, top: ar.top, width: ar.w, height: ar.h, border: `2px dashed ${guide}`, borderRadius: 6 }} />
            <img alt="" src={analysis.previewUrl} draggable={false} style={{ position: 'absolute', left: fl + L.artLeft * P, top: ft + L.artTop * P, width: L.artW * P, height: L.artH * P, opacity: 0.22, pointerEvents: 'none' }} />
            <div className="mc-frame" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              style={{ position: 'absolute', left: fl, top: ft, width: fw, height: fh, borderRadius: radius, overflow: 'hidden', outline: `2px solid ${frameLine}`, outlineOffset: 2 }}>
              <img alt="Your art" src={analysis.previewUrl} draggable={false} style={{ position: 'absolute', left: L.artLeft * P, top: L.artTop * P, width: L.artW * P, height: L.artH * P }} />
            </div>
            <span style={{ position: 'absolute', left: ar.left, top: ar.top + ar.h + 8, fontWeight: 800, fontSize: 14, color: guide }}>Dashed box = print area · faded art is cut off and will not print</span>
          </div>
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>Drag the art with your finger or mouse to move it.</p>
    </div>
    <div>
      <div className="mc-ctl"><h3>Frame</h3><div className="mc-sw">{SHAPES.map(([k, l]) => <button key={k} type="button" className={s.shape === k ? 'on' : ''} aria-pressed={s.shape === k} onClick={() => set({ shape: k })}>{l}</button>)}</div></div>
      {s.shape !== 'none' && <div className="mc-ctl"><h3>Frame size: {L.frameW.toFixed(1)} × {L.frameH.toFixed(1)} in</h3>
        <input type="range" min={3} max={area.w} step={0.2} value={clamp(s.frame, 3, area.w)} onChange={e => set({ frame: Number(e.target.value) })} aria-label="Frame size" />
        <div className="mc-sw"><button type="button" onClick={() => set({ top: Math.max(0, L.frameTop - 0.5) })}>Higher</button><button type="button" onClick={() => set({ top: Math.min(area.h - L.frameH, L.frameTop + 0.5) })}>Lower</button></div></div>}
      <div className="mc-ctl"><h3>Zoom art: {s.zoom}%</h3>
        <div className="mc-sw"><button type="button" aria-label="Zoom out" onClick={() => set({ zoom: Math.max(40, s.zoom - 10) })}>−</button><button type="button" aria-label="Zoom in" onClick={() => set({ zoom: Math.min(300, s.zoom + 10) })}>+</button><button type="button" onClick={() => set({ nudgeX: 0, nudgeY: 0 })}>Centre</button></div>
        <input type="range" min={40} max={300} step={5} value={s.zoom} onChange={e => set({ zoom: Number(e.target.value) })} aria-label="Zoom art" /></div>
      <div className="mc-ctl"><h3>Shirt colour</h3><div className="mc-sw">{swatches.map(c => <button key={c.name} type="button" className={colour === c.name ? 'on' : ''} aria-pressed={colour === c.name} onClick={() => setColour(c.name)}><i style={{ background: c.hex }} />{c.name}</button>)}</div></div>
      <p className="small muted">We cut your art to the frame and print exactly that part, at {EXPORT_DPI} DPI (up to {EXPORT_MAX_PX} px).</p>
      {q.blocks && <p className="mc-err small" role="alert">This is too blurry to print. Make the art smaller on the shirt, or go back and upload a bigger picture.</p>}
      {L.empty && <p className="mc-err small" role="alert">None of your art is inside the frame. Move it back or make the frame bigger.</p>}
      {busy && <p role="status" className="muted">{busy}</p>}
      {problem && <p role="alert" className="mc-err">{problem}</p>}
    </div>
    <div className="mc-foot" style={{ gridColumn: '1 / -1' }}><button type="button" className="h3-btn ghost mc-big" onClick={onBack} disabled={!!busy}>← Back</button>
      <button type="button" className="h3-btn rani mc-big" disabled={blocked} onClick={() => void looksGood()}>{busy ? 'Please wait…' : 'Looks good →'}</button></div>
  </div>;
}

/* ── 4 · Price and publish ────────────────────────────────────────────── */
function PriceStep({ info, item, colours, sizes, side, art, placed, minMarkup, onBack, onDone }: {
  info: CatalogInfo; item: CatalogItem; colours: string[]; sizes: string[]; side: Side; art: ArtUpload; placed: Placed; minMarkup: number; onBack: () => void; onDone: (p: Product) => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [markup, setMarkup] = useState(String(Math.max(100, minMarkup)));
  const [quote, setQuote] = useState<Record<string, number> | null>(null);
  const [quoteErr, setQuoteErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setQuote(null); setQuoteErr(false);
    void getQuote({ catalogId: item.id, colours, side, w: placed.w, h: placed.h, sizes }).then(r => {
      if (!live) return;
      if (r.ok) setQuote(Object.fromEntries(r.data.sizes.map(x => [x.size, x.basePaise])));
      else { setQuoteErr(true); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_quote_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'price_publish' }); }
    });
    return () => { live = false; };
  }, [item.id, colours, side, placed.w, placed.h, sizes]);

  const m = Math.floor(Number(markup) || 0);
  const okM = m >= minMarkup && m <= MARKUP_MAX;
  const rows = sizes.map(sz => ({ size: sz, base: quote?.[sz] ?? item.sizes.find(x => x.size === sz)?.basePaise ?? 0 }));
  const earn = youEarnPaise(m, info.platformShareBps);
  const ready = title.trim().length >= 2 && okM && !!quote && !busy;

  async function publish() {
    if (!ready) return;
    setBusy(true); setErr(null);
    const square = placed.frame === 'square' || placed.frame === 'circle';
    // The server checks a square/circle frame against the printed rectangle; a clipped print is not square, so say "rect" then (the file is already cut to the shape).
    const frame: FrameShape = square && Math.abs(placed.w - placed.h) > 0.04 ? 'rect' : placed.frame;
    const r = await createProduct({
      title: title.trim(), description: desc.trim() || undefined, catalogId: item.id, colours, sizes, side,
      placement: { frame, x: placed.x, y: placed.y, w: placed.w, h: placed.h, zoom: placed.zoom },
      artId: art.artId, printFileId: placed.printFileId, markupRupees: m, ownArtConfirmed: true, mockupUrls: placed.mockupUrls,
    });
    setBusy(false);
    if (r.ok) { capture('merch_studio_step', { step: 'publish_ok', status: r.data.product.status }); onDone(r.data.product); }
    else { setErr(r.message || 'Could not publish.'); captureException(new Error(`merch_publish_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'price_publish', status: r.status }); }
  }

  return <div className="h3-row c2" style={{ alignItems: 'start' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <img src={placed.mockupUrls[0] ?? placed.previewUrl} alt="Your shirt" style={{ width: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 28, background: 'var(--cream)' }} />
      <label className="f">Product name<input value={title} maxLength={80} placeholder="e.g. Sunrise Chai Tee" onChange={e => setTitle(e.target.value)} /></label>
      <label className="f">Description (optional)<textarea rows={3} maxLength={600} value={desc} onChange={e => setDesc(e.target.value)} /></label>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label className="f">Your markup per shirt (₹{minMarkup} – ₹{MARKUP_MAX})<input inputMode="numeric" value={markup} onChange={e => setMarkup(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} aria-label="Markup in rupees" /></label>
      <div className="mc-sw">{[50, 100, 150, 200, 300].filter(v => v >= minMarkup).map(v => <button key={v} type="button" className={m === v ? 'on' : ''} onClick={() => setMarkup(String(v))}>₹{v}</button>)}</div>
      <table className="mc-sizes" aria-label="Price per size"><thead><tr><th>Size</th><th>Base</th><th>Fan pays</th><th>You earn</th></tr></thead><tbody>
        {rows.map(r => <tr key={r.size}><td>{r.size}</td><td>{quote ? rupees(r.base) : '…'}</td><td>{okM && quote ? rupees(fanPaysPaise(r.base, m)) : '—'}</td><td className="mc-earn">{okM ? rupees(earn) : '—'}</td></tr>)}
      </tbody></table>
      <p className="small muted">Base price = printing and delivery for your print size. Free delivery for the fan. You keep {Math.round((10_000 - info.platformShareBps) / 100)}% of your markup, and it can be withdrawn {info.holdDays} days after delivery.</p>
      {quoteErr && <p className="mc-err small" role="alert">We could not get the exact base price. Go back and try again in a moment.</p>}
      {!okM && <p className="mc-err small">Enter a markup between ₹{minMarkup} and ₹{MARKUP_MAX}.</p>}
      {err && <p className="mc-err" role="alert">{err}</p>}
    </div>
    <div className="mc-foot" style={{ gridColumn: '1 / -1' }}><button type="button" className="h3-btn ghost mc-big" onClick={onBack} disabled={busy}>← Back</button>
      <button type="button" className="h3-btn rani mc-big" disabled={!ready} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish'}</button></div>
  </div>;
}
