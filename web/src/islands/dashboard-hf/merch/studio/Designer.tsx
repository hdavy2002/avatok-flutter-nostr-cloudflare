/* [HF-MERCH-STUDIO-2] Step 3 "Design": the merch design studio (layers of pictures + text on the product, built on Konva).
 * React `layers` is the source of truth; engine.ts draws it. "Looks good" exports one 300 DPI transparent PNG (exportPrint.ts), uploads it and the product pictures,
 * then hands everything to the wizard through `onDone` (contract: ./types.ts). Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { capture, captureException } from '../../../../lib/analytics';
import { dpiQuality } from '../../../../lib/studioGeometry';
import { removeBackground, uploadArt, uploadMockup, uploadPrintFile } from '../api';
import { StudioEngine } from './engine';
import { ExportError, UNREADABLE, exportDesign, loadPicture, renderMockup, sourceFor } from './exportPrint';
import { DEFAULT_FONT, loadMerchFonts } from './fonts';
import { History } from './history';
import { SI } from './icons';
import { designBounds, dpiOf, getKonva, layerBoundsIn, type KonvaLib } from './nodes';
import { ArrangePanel, EditPanel, LayersPanel, PicturesPanel, TextPanel, type AlignHow, type BgState, type StudioCtx } from './panels';
import { familyOf } from './silhouettes';
import type { DesignerProps, ImageLayer, Layer, StudioArt, TextLayer } from './types';
import './studio.css';

type Tool = 'pictures' | 'text' | 'edit' | 'arrange' | 'layers';
const TOOLS: { id: Tool; label: string; icon: string; small?: boolean }[] = [
  { id: 'pictures', label: 'Pictures', icon: 'image' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'edit', label: 'Edit', icon: 'wand' },
  { id: 'arrange', label: 'Arrange', icon: 'arrange' },
  { id: 'layers', label: 'Layers', icon: 'layers', small: true },
];
const STEP = 'design';
const r2 = (v: number): number => Math.round(v * 100) / 100;
const uid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`);

/** Wide = the studio itself (not the window) has room for the 4-column layout with the layers column. Matches the @container rule in studio.css. */
const WIDE_PX = 1240;
function useWide(el: RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const node = el.current; if (!node) return;
    const f = (): void => setWide(node.clientWidth >= WIDE_PX);
    f(); const ro = new ResizeObserver(f); ro.observe(node);
    return () => ro.disconnect();
  }, [el]);
  return wide;
}

export default function Designer(props: DesignerProps) {
  const { item, side, colours, arts } = props;
  const family = useMemo(() => familyOf(item), [item]);
  const areaIn = useMemo(() => {
    const a = item.printAreas?.[side];
    return a ? { w: a.wIn, h: a.hIn } : { w: item.printArea.wIn, h: item.printArea.hIn };
  }, [item, side]);
  const swatches = useMemo(() => (colours.length ? colours : item.colours.slice(0, 1)), [colours, item]);
  const [colourName, setColourName] = useState(swatches[0]?.name ?? '');
  const hex = swatches.find(c => c.name === colourName)?.hex ?? swatches[0]?.hex ?? '#ffffff';
  const rootEl = useRef<HTMLDivElement>(null);
  const wide = useWide(rootEl);

  /* ── state ──────────────────────────────────────────────────────────── */
  const initial = useMemo<Layer[]>(() => props.initialLayers ?? [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const [layers, setLayersState] = useState<Layer[]>(initial);
  const layersRef = useRef(layers); layersRef.current = layers;
  const hist = useRef<History<Layer[]> | null>(null);
  if (!hist.current) hist.current = new History<Layer[]>(initial);
  const [selId, setSelId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('pictures');
  const [zoom, setZoomState] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [bg, setBg] = useState<BgState>(null);
  const [broken, setBroken] = useState<Record<string, string>>({});
  const [fontTick, setFontTick] = useState(0);
  const [K, setK] = useState<KonvaLib | null>(null);
  const [loadFail, setLoadFail] = useState(false);
  const stageEl = useRef<HTMLDivElement>(null);
  const engineRef = useRef<StudioEngine | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const liveRef = useRef(true);
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);

  const commit = useCallback((next: Layer[], key?: string): void => {
    hist.current?.push(next, key);
    layersRef.current = next;
    setLayersState(next);
    propsRef.current.onLayersChange?.(next);
  }, []);
  const patchLayer = useCallback((id: string, p: Partial<ImageLayer> | Partial<TextLayer>, key?: string): void => {
    commit(layersRef.current.map(l => (l.id === id ? ({ ...l, ...p } as Layer) : l)), key);
  }, [commit]);

  const sel = useMemo(() => layers.find(l => l.id === selId) ?? null, [layers, selId]);
  useEffect(() => { if (selId && !layers.some(l => l.id === selId)) setSelId(null); }, [layers, selId]);

  /** Layers as the stage and panels see them: pictures point at the original bytes when the tray has them. */
  const shown = useMemo<Layer[]>(() => layers.map(l => (l.type === 'image' ? { ...l, src: sourceFor(l, arts) || l.src } : l)), [layers, arts]);

  /* ── engine lifecycle ───────────────────────────────────────────────── */
  const cbRef = useRef({
    select: (_id: string | null, _fromStage: boolean): void => undefined,
    patch: (_id: string, _p: Record<string, number>): void => undefined,
    imageError: (_id: string, _src: string): void => undefined,
    fontError: (_f: string, _e: unknown): void => undefined,
    fontLoaded: (_f: string): void => undefined,
  });
  cbRef.current = {
    select: (id, fromStage) => {
      setSelId(id);
      if (fromStage && id) {
        const l = layersRef.current.find(x => x.id === id);
        if (l?.type === 'text') setTool(t => (t === 'text' ? t : 'text'));
        else if (l) setTool(t => (t === 'edit' || t === 'arrange' ? t : 'edit'));
      }
    },
    patch: (id, p) => patchLayer(id, p as Partial<ImageLayer>),
    imageError: (id, src) => {
      if (id === 'product') { captureException(new Error('merch_studio_product_image'), { area: 'hf_merch_creator', step: STEP }); return; }
      setBroken(b => ({ ...b, [id]: src }));
      captureException(new Error('merch_studio_picture_load'), { area: 'hf_merch_creator', step: STEP });
    },
    fontError: (family, e) => { captureException(e, { area: 'hf_merch_creator', step: STEP, font: family }); },
    fontLoaded: () => setFontTick(n => n + 1),
  };

  useEffect(() => {
    let dead = false; let ro: ResizeObserver | undefined; let eng: StudioEngine | null = null;
    (async () => {
      try {
        const lib = await getKonva();
        const el = stageEl.current;
        if (dead || !el) return;
        eng = new StudioEngine(lib, el, {
          select: (id, fs) => cbRef.current.select(id, fs), patch: (id, p) => cbRef.current.patch(id, p),
          imageError: (id, s) => cbRef.current.imageError(id, s), fontError: (f, e) => cbRef.current.fontError(f, e), fontLoaded: f => cbRef.current.fontLoaded(f),
        });
        engineRef.current = eng;
        ro = new ResizeObserver(() => eng?.resize()); ro.observe(el);
        setK(lib);
      } catch (e) {
        captureException(e, { area: 'hf_merch_creator', step: STEP });
        if (!dead) setLoadFail(true);
      }
    })();
    return () => { dead = true; ro?.disconnect(); eng?.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setProduct({ family, side, hex, areaIn }); }, [K, family, side, hex, areaIn]);
  useEffect(() => { engineRef.current?.sync(shown, selId); }, [K, shown, selId, fontTick]);

  /* start: telemetry, fonts used by the layers, first picture */
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    capture('merch_studio_step', { step: 'design_open', family, side });
    void loadMerchFonts([DEFAULT_FONT, ...initial.flatMap(l => (l.type === 'text' ? [l.font] : []))]).then(f => f.forEach(x => captureException(x.error, { area: 'hf_merch_creator', step: STEP, font: x.family })));
    if (!initial.length && arts.length) addArt(arts[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── actions ────────────────────────────────────────────────────────── */
  const nextName = (base: string): string => {
    const n = layersRef.current.filter(l => l.name.startsWith(base)).length;
    return n ? `${base} ${n + 1}` : base;
  };
  function addArt(a: StudioArt): void {
    const aspect = a.height / Math.max(1, a.width);
    // ~70% of the print area, but never so big that it prints soft (keep at least 220 DPI when the picture is small).
    let w = Math.min(areaIn.w * 0.7, a.width / 220); let h = w * aspect;
    if (h > areaIn.h * 0.7) { h = areaIn.h * 0.7; w = h / aspect; }
    w = Math.max(w, Math.min(2, areaIn.w)); h = w * aspect;
    const l: ImageLayer = {
      id: uid(), type: 'image', name: nextName(a.label || 'Picture'), visible: true, locked: false, x: areaIn.w / 2, y: Math.min(areaIn.h / 2, h / 2 + 1), rotation: 0, opacity: 1, flipX: false, flipY: false,
      artId: a.artId, src: a.localUrl ?? a.url, pxW: a.width, pxH: a.height, w, h,
    };
    commit([...layersRef.current, l]); setSelId(l.id);
    capture('merch_studio_step', { step: 'design_add_picture', source: a.source });
  }
  function addText(hindi = false): void {
    const dark = parseInt(hex.slice(1, 3) || 'ff', 16) * 0.3 + parseInt(hex.slice(3, 5) || 'ff', 16) * 0.59 + parseInt(hex.slice(5, 7) || 'ff', 16) * 0.11 < 128;
    const l: TextLayer = {
      id: uid(), type: 'text', name: nextName('Text'), visible: true, locked: false, x: areaIn.w / 2, y: areaIn.h / 2, rotation: 0, opacity: 1, flipX: false, flipY: false,
      text: hindi ? 'नमस्ते' : 'Your text', font: DEFAULT_FONT, sizeIn: Math.min(3, Math.max(0.6, areaIn.w * 0.12)), fill: dark ? '#ffffff' : '#1a1a1a', align: 'center',
      letterSpacing: 0, lineHeight: 1.1, stroke: null, strokeIn: 0.04, shadow: false, bold: false, italic: false,
    };
    commit([...layersRef.current, l]); setSelId(l.id); setTool('text');
    capture('merch_studio_step', { step: 'design_add_text', hindi });
  }
  const remove = (id: string): void => { commit(layersRef.current.filter(l => l.id !== id)); setSelId(s => (s === id ? null : s)); };
  const duplicate = (id: string): void => {
    const cur = layersRef.current; const i = cur.findIndex(l => l.id === id); if (i < 0) return;
    const copy = { ...cur[i], id: uid(), name: `${cur[i].name} copy`, x: cur[i].x + 0.3, y: cur[i].y + 0.3, locked: false } as Layer;
    commit([...cur.slice(0, i + 1), copy, ...cur.slice(i + 1)]); setSelId(copy.id);
  };
  const reorder = (from: number, to: number): void => {
    const cur = [...layersRef.current]; if (from === to || from < 0 || from >= cur.length) return;
    const [m] = cur.splice(from, 1); cur.splice(Math.max(0, Math.min(cur.length, to)), 0, m); commit(cur);
  };
  const order = (id: string, how: 'up' | 'down' | 'front' | 'back'): void => {
    const i = layersRef.current.findIndex(l => l.id === id); if (i < 0) return;
    reorder(i, how === 'up' ? i + 1 : how === 'down' ? i - 1 : how === 'front' ? layersRef.current.length - 1 : 0);
  };
  const align = (how: AlignHow): void => {
    if (!sel || !K) return;
    const b = layerBoundsIn(K, sel);
    let dx = 0; let dy = 0;
    if (how === 'left') dx = -b.left; else if (how === 'right') dx = areaIn.w - b.right; else if (how === 'centerH') dx = areaIn.w / 2 - (b.left + b.right) / 2;
    else if (how === 'top') dy = -b.top; else if (how === 'bottom') dy = areaIn.h - b.bottom; else dy = areaIn.h / 2 - (b.top + b.bottom) / 2;
    patchLayer(sel.id, { x: sel.x + dx, y: sel.y + dy });
  };
  const undo = (): void => { const p = hist.current?.undo(); if (p) { layersRef.current = p; setLayersState(p); propsRef.current.onLayersChange?.(p); } };
  const redo = (): void => { const p = hist.current?.redo(); if (p) { layersRef.current = p; setLayersState(p); propsRef.current.onLayersChange?.(p); } };

  const swapArt = (id: string, art: StudioArt): void => {
    commit(layersRef.current.map(x => (x.id === id && x.type === 'image'
      ? { ...x, artId: art.artId, src: art.localUrl ?? art.url, pxW: art.width, pxH: art.height, h: (x.w * art.height) / Math.max(1, art.width) } : x)));
    setBroken(b => { const n = { ...b }; delete n[id]; return n; });
  };

  async function removeBg(l: ImageLayer): Promise<void> {
    setBg({ id: l.id, state: 'working' }); setProblem(null);
    capture('merch_studio_step', { step: 'design_bg_remove' });
    const r = await removeBackground(l.artId);
    if (!liveRef.current) return;
    if (!r.ok) {
      const off = r.status === 502 || r.code === 'bg_remove_failed';
      setBg({ id: l.id, state: 'failed', message: r.message || 'Could not remove the background.', offerErase: off });
      if (!off && (r.status >= 500 || r.status === 0)) captureException(new Error(`merch_bgremove_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: STEP });
      return;
    }
    const a = r.data.art;
    let localUrl: string | undefined;
    try {
      const res = await fetch(a.url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) localUrl = URL.createObjectURL(await res.blob());
    } catch (e) { captureException(e, { area: 'hf_merch_creator', step: STEP, note: 'bg_local_copy' }); }
    if (!liveRef.current) { if (localUrl) URL.revokeObjectURL(localUrl); return; }
    const art: StudioArt = { ...a, localUrl, source: 'bg_removed', label: `${l.name} (no background)` };
    propsRef.current.onArtAdded(art);
    swapArt(l.id, art); setBg(null);
  }

  async function applyErase(l: ImageLayer, blob: Blob, w: number, h: number): Promise<string | null> {
    capture('merch_studio_step', { step: 'design_erase_colour' });
    const up = await uploadArt(blob, 'erased.png');
    if (!up.ok) {
      if (up.status >= 500 || up.status === 0) captureException(new Error(`merch_erase_upload_${up.status}_${up.code}`), { area: 'hf_merch_creator', step: STEP });
      return up.message || 'Could not save the picture.';
    }
    const art: StudioArt = { ...up.data, width: up.data.width || w, height: up.data.height || h, localUrl: URL.createObjectURL(blob), source: 'bg_removed', label: `${l.name} (cleaned)` };
    propsRef.current.onArtAdded(art);
    swapArt(l.id, art);
    return null;
  }

  /* ── keyboard ───────────────────────────────────────────────────────── */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (busy) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (!sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(sel.id); return; }
    const step = e.shiftKey ? 0.5 : 0.1;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key] && !sel.locked) { e.preventDefault(); patchLayer(sel.id, { x: sel.x + d[e.key][0], y: sel.y + d[e.key][1] }, `nudge:${sel.id}`); }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent): void => keyRef.current(e);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  /* ── numbers shown to the owner ─────────────────────────────────────── */
  const bounds = useMemo(() => (K ? designBounds(K, layers, areaIn) : null), [K, layers, areaIn, fontTick]);
  const images = layers.filter((l): l is ImageLayer => l.type === 'image' && l.visible);
  const worst = images.reduce<ImageLayer | null>((a, l) => (!a || dpiOf(l) < dpiOf(a) ? l : a), null);
  const shownPic = sel?.type === 'image' ? sel : worst;
  const q = shownPic ? dpiQuality(dpiOf(shownPic)) : null;
  const brokenHere = images.some(l => broken[l.id] !== undefined && broken[l.id] === sourceFor(l, arts));
  let blocked: string | null = null;
  const blurry = images.find(l => dpiQuality(dpiOf(l)).blocks);
  if (!K) blocked = null;
  else if (!bounds) blocked = layers.some(l => l.visible) ? 'Nothing is inside the dashed box yet. Move your picture or text into it.' : 'Add a picture or some text to begin.';
  else if (blurry) blocked = `“${blurry.name}” is too blurry to print (${dpiOf(blurry)} DPI). Make it smaller on the product, or add a bigger picture.`;
  else if (brokenHere) blocked = 'A picture could not be loaded. Delete it and add it again.';

  /* ── Looks good ─────────────────────────────────────────────────────── */
  async function looksGood(): Promise<void> {
    if (busy || blocked || !K) return;
    setProblem(null); setBusy('Making your print file…');
    capture('merch_studio_step', { step: 'design_export_start', layers: layersRef.current.length });
    try {
      const snapshot = layersRef.current;
      const out = await exportDesign({ layers: snapshot, areaIn, arts });
      if (!liveRef.current) return;
      setBusy('Saving…');
      let artId = snapshot.find((l): l is ImageLayer => l.type === 'image' && l.visible)?.artId ?? '';
      if (!artId) {
        const up = await uploadArt(out.blob, 'text-design.png');
        if (!up.ok) { setProblem(up.message || 'Could not save your design.'); if (up.status >= 500 || up.status === 0) captureException(new Error(`merch_composite_${up.status}_${up.code}`), { area: 'hf_merch_creator', step: STEP }); setBusy(null); return; }
        artId = up.data.artId;
        propsRef.current.onArtAdded({ ...up.data, localUrl: URL.createObjectURL(out.blob), source: 'composite', label: 'Text design' });
      }
      const pf = await uploadPrintFile(artId, out.blob);
      if (!pf.ok) { setProblem(pf.message || 'Could not save the print file.'); if (pf.status >= 500 || pf.status === 0) captureException(new Error(`merch_print_${pf.status}_${pf.code}`), { area: 'hf_merch_creator', step: STEP }); setBusy(null); return; }
      setBusy('Making product pictures…');
      const left = r2(out.leftIn); const top = r2(out.topIn);
      const wIn = Math.min(r2(out.wIn), r2(areaIn.w - left)); const hIn = Math.min(r2(out.hIn), r2(areaIn.h - top));
      const urls: string[] = [];
      for (const c of swatches.slice(0, 4)) {
        try {
          const blob = await renderMockup({ family, side, hex: c.hex, areaIn, print: out.canvas, leftIn: out.leftIn, topIn: out.topIn, wIn: out.wIn, hIn: out.hIn, size: 900 });
          const m = await uploadMockup(blob);
          if (m.ok) urls.push(m.data.url);
          else if (m.status >= 500 || m.status === 0) captureException(new Error(`merch_mockup_${m.status}_${m.code}`), { area: 'hf_merch_creator', step: STEP });
        } catch (e) { captureException(e, { area: 'hf_merch_creator', step: STEP, note: 'mockup' }); }
      }
      if (!liveRef.current) return;
      capture('merch_studio_step', { step: 'design_export_ok', dpi: out.dpi, mockups: urls.length, scaled_down: out.scaledDown });
      propsRef.current.onDone({ artId, printFileId: pf.data.printFileId, wIn, hIn, leftIn: left, topIn: top, dpi: out.dpi, mockupUrls: urls, previewUrl: URL.createObjectURL(out.preview), layers: snapshot });
    } catch (e) {
      captureException(e, { area: 'hf_merch_creator', step: STEP });
      setProblem(e instanceof ExportError ? e.message : e instanceof Error && e.message ? e.message : 'Could not make the print file. Please try again.');
      setBusy(null);
    }
  }

  /* ── view ───────────────────────────────────────────────────────────── */
  const setZoom = (z: number): void => { const eng = engineRef.current; if (!eng) return; eng.setZoom(z); setZoomState(eng.zoom); };
  const zoomArea = (): void => { const eng = engineRef.current; if (!eng) return; setZoomState(eng.zoomToArea()); };

  const ctx: StudioCtx = {
    layers: shown, sel: shown.find(l => l.id === selId) ?? null, area: areaIn, arts, busy: !!busy, bg,
    select: setSelId, patch: patchLayer, addText, addArt, wantMoreArt: () => propsRef.current.onWantMoreArt(),
    remove, duplicate, order, reorder, align, removeBg,
    loadPicture: async l => { const temp: string[] = []; try { return await loadPicture(sourceFor(l, arts) || l.src, temp); } finally { temp.forEach(u => URL.revokeObjectURL(u)); } },
    applyErase,
  };
  const activeTool: Tool = wide && tool === 'layers' ? 'pictures' : tool;
  const hist2 = hist.current;
  const chipTone = q ? q.tone : 'info';

  return <div className="ms-studio" ref={rootEl} data-busy={busy ? '1' : undefined}>
    <header className="ms-head">
      <button type="button" className="ms-btn ghost" onClick={props.onBack} disabled={!!busy}><SI name="back" /> Back</button>
      <div className="ms-title"><b>{item.name}</b><span>{side === 'front' ? 'Front' : 'Back'} print · {colourName}</span></div>
      <div className="ms-head-actions">
        <button type="button" className="ms-ibtn big" aria-label="Undo" onClick={undo} disabled={!hist2?.canUndo || !!busy}><SI name="undo" /></button>
        <button type="button" className="ms-ibtn big" aria-label="Redo" onClick={redo} disabled={!hist2?.canRedo || !!busy}><SI name="redo" /></button>
        <button type="button" className="ms-btn rani" disabled={!K || !!blocked || !!busy} onClick={() => void looksGood()}>{busy ? 'Please wait…' : 'Looks good →'}</button>
      </div>
    </header>

    <div className="ms-chips" aria-live="polite">
      {q && shownPic && <span className={`ms-q ${chipTone}`}>{q.text} · {dpiOf(shownPic)} DPI{sel?.type !== 'image' && images.length > 1 ? ' (lowest)' : ''}</span>}
      {bounds && <span className="ms-chip">Prints {bounds.w.toFixed(1)} × {bounds.h.toFixed(1)} in</span>}
      <span className="ms-chip soft">Print area {areaIn.w.toFixed(1)} × {areaIn.h.toFixed(1)} in</span>
    </div>
    {blocked && !busy && <p className="ms-note warn" role="status">{blocked}</p>}
    {loadFail && <p className="ms-note bad" role="alert">The design studio could not start. Please reload the page.</p>}
    {problem && <p className="ms-note bad" role="alert">{problem === UNREADABLE ? UNREADABLE : problem}</p>}
    {busy && <p className="ms-note busy" role="status"><span className="ms-spin" /> {busy}</p>}

    <div className="ms-grid">
      <nav className="ms-rail" aria-label="Design tools">
        {TOOLS.map(t => <button key={t.id} type="button" className={`ms-tool${activeTool === t.id ? ' on' : ''}${t.small ? ' small-only' : ''}`} aria-pressed={activeTool === t.id} onClick={() => setTool(t.id)}><SI name={t.icon} size={24} /><span>{t.label}</span></button>)}
      </nav>
      <section className="ms-panel" aria-label="Tool options">
        {activeTool === 'pictures' && <PicturesPanel c={ctx} />}
        {activeTool === 'text' && <TextPanel c={ctx} />}
        {activeTool === 'edit' && <EditPanel c={ctx} />}
        {activeTool === 'arrange' && <ArrangePanel c={ctx} />}
        {activeTool === 'layers' && <LayersPanel c={ctx} />}
      </section>
      <div className="ms-centre">
        <div className="ms-stagebox">
          <div className="ms-stage" ref={stageEl} onContextMenu={e => e.preventDefault()} />
          {!K && !loadFail && <div className="ms-loading" role="status"><span className="ms-spin big" /> Opening the studio…</div>}
          {K && layers.length === 0 && <div className="ms-empty-stage"><b>Start with a picture or some text</b><span>Use the tools next to the product.</span></div>}
          {zoom <= 1.01 && <i className="ms-areatag">Dashed box = print area</i>}
        </div>
        <div className="ms-foot">
          <div className="ms-swatches" role="group" aria-label="Product colour">
            {swatches.map(c => <button key={c.name} type="button" className={`ms-pc${colourName === c.name ? ' on' : ''}`} aria-pressed={colourName === c.name} aria-label={c.name} title={c.name} onClick={() => setColourName(c.name)}><i style={{ background: c.hex }} /></button>)}
            <span className="ms-pcname">{colourName}</span>
          </div>
          <div className="ms-zoom" role="group" aria-label="Zoom">
            <button type="button" className="ms-ibtn" aria-label="Zoom out" onClick={() => setZoom(zoom - 0.25)} disabled={zoom <= 1}><SI name="minus" /></button>
            <output>{Math.round(zoom * 100)}%</output>
            <button type="button" className="ms-ibtn" aria-label="Zoom in" onClick={() => setZoom(zoom + 0.25)} disabled={zoom >= 4}><SI name="plus" /></button>
            <button type="button" className="ms-tbtn flat" onClick={() => setZoom(1)}><SI name="fit" size={18} /><span>Fit</span></button>
            <button type="button" className="ms-tbtn flat" onClick={zoomArea}><SI name="area" size={18} /><span>Print box</span></button>
          </div>
        </div>
      </div>
      <aside className="ms-side" aria-label="Layers"><LayersPanel c={ctx} /></aside>
    </div>
  </div>;
}
