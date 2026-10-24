/* [HF-MERCH-STUDIO-2] Tool panels of the studio: Pictures, Text, Edit picture, Arrange, Layers. Pure UI: all changes go through the `StudioCtx` Designer.tsx provides. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dpiQuality } from '../../../../lib/studioGeometry';
import { SI } from './icons';
import { ERASE_MAX_PX, canvasToPng, eraseBackground, imageToCanvas } from './erase';
import { MERCH_FONTS, loadMerchFonts } from './fonts';
import { dpiOf } from './nodes';
import type { ImageLayer, Layer, StudioArt, TextLayer } from './types';

export type AlignHow = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';
export type BgState = { id: string; state: 'working' } | { id: string; state: 'failed'; message: string; offerErase: boolean } | null;
/** [HF-MERCH-AI-HIRES-1] "Make it sharper" progress for one picture layer. */
export type SharpState = { id: string; state: 'working' } | { id: string; state: 'failed'; message: string } | null;

export interface StudioCtx {
  layers: Layer[]; sel: Layer | null; area: { w: number; h: number }; arts: StudioArt[]; busy: boolean; bg: BgState;
  select(id: string | null): void;
  patch(id: string, p: Partial<ImageLayer> | Partial<TextLayer>, key?: string): void;
  addText(hindi?: boolean): void; addArt(a: StudioArt): void; wantMoreArt(): void;
  remove(id: string): void; duplicate(id: string): void;
  order(id: string, how: 'up' | 'down' | 'front' | 'back'): void; reorder(fromIdx: number, toIdx: number): void;
  align(how: AlignHow): void;
  removeBg(l: ImageLayer): Promise<void>;
  /** [HF-MERCH-AI-HIRES-1] */ sharp: SharpState; canSharpen(l: ImageLayer): boolean; sharpen(l: ImageLayer): Promise<void>;
  loadPicture(l: ImageLayer): Promise<HTMLImageElement>;
  applyErase(l: ImageLayer, blob: Blob, w: number, h: number): Promise<string | null>;
}

/** Curated palette (no green): Indian dyes and metals. */
export const PALETTE = ['#ffffff', '#fff1d6', '#fbbf24', '#f59e0b', '#ea6a12', '#e4572e', '#c8102e', '#d81b72', '#f8c8dc', '#7a1f3d', '#4a1747', '#6d4fd0', '#3d2c8d', '#1a237e', '#0e7c86', '#8b5e34', '#c9a227', '#111111'];

/* ── small controls ───────────────────────────────────────────────────── */
export function Slider({ label, value, min, max, step, onChange, show }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; show?: string }) {
  return <label className="ms-slider">
    <span className="ms-slider-top"><b>{label}</b><output>{show ?? String(Math.round(value * 100) / 100)}</output></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
  </label>;
}

export function ColourRow({ value, onChange, label }: { value: string | null; onChange: (hex: string) => void; label: string }) {
  const cur = value ?? '';
  return <div className="ms-colours" role="group" aria-label={label}>
    {PALETTE.map(c => <button key={c} type="button" className={`ms-sw${cur.toLowerCase() === c ? ' on' : ''}${c === '#ffffff' || c === '#fff1d6' ? ' pale' : ''}`} style={{ background: c }} aria-label={`${label} ${c}`} aria-pressed={cur.toLowerCase() === c} onClick={() => onChange(c)} />)}
    <label className="ms-custom"><input type="color" value={/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#d81b72'} onChange={e => onChange(e.target.value)} aria-label={`${label}: custom colour`} /><span>Custom</span></label>
  </div>;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="ms-card"><h3>{title}</h3>{hint && <p className="ms-hint">{hint}</p>}{children}</section>;
}
const Btn = ({ icon, label, onClick, disabled, on, tone }: { icon: string; label: string; onClick: () => void; disabled?: boolean; on?: boolean; tone?: 'danger' }) =>
  <button type="button" className={`ms-tbtn${on ? ' on' : ''}${tone ? ` ${tone}` : ''}`} onClick={onClick} disabled={disabled} aria-pressed={on}><SI name={icon} /><span>{label}</span></button>;

/** Opacity / flip / rotate: the same for pictures and text. */
function LookControls({ c, l }: { c: StudioCtx; l: Layer }) {
  return <Card title="Look">
    <Slider label="Opacity" value={Math.round(l.opacity * 100)} min={10} max={100} step={1} show={`${Math.round(l.opacity * 100)}%`} onChange={v => c.patch(l.id, { opacity: v / 100 }, `op:${l.id}`)} />
    <div className="ms-btnrow">
      <Btn icon="flipH" label="Flip left-right" on={l.flipX} onClick={() => c.patch(l.id, { flipX: !l.flipX })} />
      <Btn icon="flipV" label="Flip up-down" on={l.flipY} onClick={() => c.patch(l.id, { flipY: !l.flipY })} />
      <Btn icon="rotate" label="Turn 90°" onClick={() => c.patch(l.id, { rotation: (Math.round(l.rotation / 90) * 90 + 90) % 360 })} />
    </div>
  </Card>;
}

/* ── Pictures ─────────────────────────────────────────────────────────── */
export function PicturesPanel({ c }: { c: StudioCtx }) {
  return <div className="ms-panel-in">
    <Card title="Your pictures" hint="Tap a picture to put it on the product.">
      {c.arts.length === 0 && <p className="ms-empty">No pictures yet. Add one to begin.</p>}
      <div className="ms-tray">
        {c.arts.map(a => <button key={a.artId} type="button" className="ms-thumb" onClick={() => c.addArt(a)} aria-label={`Add ${a.label || 'picture'} to the product`}>
          <img src={a.localUrl ?? a.url} alt="" draggable={false} loading="lazy" />
          {a.source === 'ai' && <i className="ms-badge">AI</i>}
          <span><SI name="plus" size={16} /> Add</span>
        </button>)}
      </div>
      <button type="button" className="ms-btn gold wide" onClick={c.wantMoreArt}><SI name="plus" /> Add picture</button>
    </Card>
  </div>;
}

/* ── Text ─────────────────────────────────────────────────────────────── */
export function TextPanel({ c }: { c: StudioCtx }) {
  const t = c.sel?.type === 'text' ? c.sel : null;
  const [fontsAsked, setFontsAsked] = useState(false);
  useEffect(() => { if (!fontsAsked) { setFontsAsked(true); void loadMerchFonts(MERCH_FONTS.map(f => f.family)); } }, [fontsAsked]);
  const cur = t ? MERCH_FONTS.find(f => f.family === t.font) : undefined;
  return <div className="ms-panel-in">
    <Card title="Add text">
      <div className="ms-btnrow two">
        <button type="button" className="ms-btn gold" onClick={() => c.addText(false)}><SI name="text" /> Add text</button>
        <button type="button" className="ms-btn ghost" onClick={() => c.addText(true)}><SI name="text" /> हिंदी text</button>
      </div>
    </Card>
    {!t && <p className="ms-empty">Tap a text on the product to change its words, font and colour.</p>}
    {t && <>
      <Card title="Words">
        <textarea className="ms-textarea" rows={3} value={t.text} maxLength={240} aria-label="Your text" onChange={e => c.patch(t.id, { text: e.target.value }, `txt:${t.id}`)} />
      </Card>
      <Card title="Font" hint={cur?.devanagari ? 'This font can show Hindi letters.' : 'This font shows English letters only.'}>
        <div className="ms-fonts" role="listbox" aria-label="Fonts">
          {MERCH_FONTS.map(f => <button key={f.family} type="button" role="option" aria-selected={t.font === f.family} className={`ms-font${t.font === f.family ? ' on' : ''}`} onClick={() => c.patch(t.id, { font: f.family })}>
            <span className="ms-font-name" style={{ fontFamily: `'${f.family}', sans-serif` }}>{f.label}</span>
            <span className="ms-font-sample" style={{ fontFamily: `'${f.family}', sans-serif` }}>{f.sample}</span>
            {f.devanagari && <i className="ms-badge">हिंदी</i>}
          </button>)}
        </div>
        {(cur?.bold || cur?.italic) && <div className="ms-btnrow">
          {cur.bold && <Btn icon="text" label="Bold" on={t.bold} onClick={() => c.patch(t.id, { bold: !t.bold })} />}
          {cur.italic && <Btn icon="text" label="Italic" on={t.italic} onClick={() => c.patch(t.id, { italic: !t.italic })} />}
        </div>}
      </Card>
      <Card title="Size and colour">
        <Slider label="Size" value={t.sizeIn} min={0.3} max={Math.max(4, c.area.w * 1.2)} step={0.05} show={`${t.sizeIn.toFixed(2)} in`} onChange={v => c.patch(t.id, { sizeIn: v }, `sz:${t.id}`)} />
        <ColourRow label="Text colour" value={t.fill} onChange={v => c.patch(t.id, { fill: v }, `fill:${t.id}`)} />
      </Card>
      <Card title="Outline and shadow">
        <div className="ms-btnrow two">
          <Btn icon="check" label={t.stroke ? 'Outline on' : 'Outline off'} on={!!t.stroke} onClick={() => c.patch(t.id, t.stroke ? { stroke: null } : { stroke: t.fill.toLowerCase() === '#111111' ? '#ffffff' : '#111111', strokeIn: Math.max(0.03, t.sizeIn * 0.06) })} />
          <Btn icon="check" label={t.shadow ? 'Shadow on' : 'Shadow off'} on={t.shadow} onClick={() => c.patch(t.id, { shadow: !t.shadow })} />
        </div>
        {t.stroke && <>
          <ColourRow label="Outline colour" value={t.stroke} onChange={v => c.patch(t.id, { stroke: v }, `st:${t.id}`)} />
          <Slider label="Outline width" value={t.strokeIn} min={0.01} max={Math.max(0.1, t.sizeIn * 0.25)} step={0.01} show={`${t.strokeIn.toFixed(2)} in`} onChange={v => c.patch(t.id, { strokeIn: v }, `sw:${t.id}`)} />
        </>}
      </Card>
      <Card title="Spacing">
        <Slider label="Letter spacing" value={t.letterSpacing} min={-0.1} max={0.8} step={0.01} show={t.letterSpacing.toFixed(2)} onChange={v => c.patch(t.id, { letterSpacing: v }, `ls:${t.id}`)} />
        <Slider label="Line height" value={t.lineHeight} min={0.8} max={2} step={0.05} show={t.lineHeight.toFixed(2)} onChange={v => c.patch(t.id, { lineHeight: v }, `lh:${t.id}`)} />
        <div className="ms-btnrow">
          {(['left', 'center', 'right'] as const).map(a => <Btn key={a} icon={a === 'left' ? 'alignL' : a === 'center' ? 'alignCH' : 'alignR'} label={a === 'center' ? 'Centre' : a === 'left' ? 'Left' : 'Right'} on={t.align === a} onClick={() => c.patch(t.id, { align: a })} />)}
        </div>
      </Card>
      <LookControls c={c} l={t} />
    </>}
  </div>;
}

/* ── Edit picture ─────────────────────────────────────────────────────── */
function EraseCard({ c, l }: { c: StudioCtx; l: ImageLayer }) {
  const [open, setOpen] = useState(false);
  const [tol, setTol] = useState(28);
  const [feather, setFeather] = useState(2);
  const [src, setSrc] = useState<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'applying'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const prev = useRef<HTMLCanvasElement>(null);
  const loadedFor = useRef<string>('');

  useEffect(() => { setOpen(false); setSrc(null); loadedFor.current = ''; setErr(null); }, [l.id, l.artId]);
  useEffect(() => {
    if (!open || loadedFor.current === l.artId) return;
    loadedFor.current = l.artId; setState('loading'); setErr(null);
    let live = true;
    c.loadPicture(l).then(img => { if (live) { setSrc(imageToCanvas(img, 720)); setState('idle'); } })
      .catch(e => { if (live) { setErr(e instanceof Error && e.message ? e.message : 'Could not read the picture.'); setState('idle'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, l.artId]);
  useEffect(() => {
    if (!src || !prev.current) return;
    const h = window.setTimeout(() => {
      const out = eraseBackground(src, tol, feather);
      const cv = prev.current; if (!cv) return;
      cv.width = out.width; cv.height = out.height;
      cv.getContext('2d')?.drawImage(out, 0, 0);
    }, 90);
    return () => window.clearTimeout(h);
  }, [src, tol, feather]);

  async function apply(): Promise<void> {
    setState('applying'); setErr(null);
    try {
      const img = await c.loadPicture(l);
      const full = imageToCanvas(img, ERASE_MAX_PX);
      const k = full.width / Math.max(1, src?.width ?? full.width);
      const out = eraseBackground(full, tol, Math.min(8, feather * k));
      const blob = await canvasToPng(out);
      const msg = await c.applyErase(l, blob, out.width, out.height);
      if (msg) setErr(msg); else setOpen(false);
    } catch (e) { setErr(e instanceof Error && e.message ? e.message : 'Could not erase the colour.'); }
    setState('idle');
  }

  return <Card title="Erase plain colour" hint="Best for pictures on a single flat colour (white, black, a plain wall). Free and instant.">
    {!open && <button type="button" className="ms-btn ghost wide" onClick={() => setOpen(true)} disabled={c.busy}><SI name="eraser" /> Erase plain colour</button>}
    {open && <>
      <div className="ms-erase-prev"><canvas ref={prev} aria-label="Preview with the colour erased" />{state === 'loading' && <span className="ms-spin big" />}</div>
      <Slider label="How much colour" value={tol} min={4} max={80} step={1} show={`${tol}`} onChange={setTol} />
      <Slider label="Soft edge" value={feather} min={0} max={6} step={1} show={`${feather} px`} onChange={setFeather} />
      <div className="ms-btnrow two">
        <button type="button" className="ms-btn ghost" onClick={() => setOpen(false)} disabled={state === 'applying'}>Cancel</button>
        <button type="button" className="ms-btn rani" onClick={() => void apply()} disabled={!src || state !== 'idle'}>{state === 'applying' ? 'Saving…' : 'Use this'}</button>
      </div>
    </>}
    {err && <p role="alert" className="ms-err">{err}</p>}
  </Card>;
}

/** [HF-MERCH-AI-HIRES-1] Shown when a picture is too blurry or only just OK at its size on the product. */
export function SharpenCard({ c, l }: { c: StudioCtx; l: ImageLayer }) {
  const working = c.sharp?.id === l.id && c.sharp.state === 'working';
  const failed = c.sharp?.id === l.id && c.sharp.state === 'failed' ? c.sharp : null;
  return <Card title="Make it sharper" hint="We make a bigger copy of this picture so it prints crisp, even across the whole shirt. Free, up to 10 a day.">
    <button type="button" className="ms-btn rani wide" onClick={() => void c.sharpen(l)} disabled={c.busy || working}><SI name="sparkle" /> {working ? 'Making it sharper…' : 'Make it sharper (free)'}</button>
    {working && <div className="ms-progress" role="status"><i /><span>Making it sharper… this takes about 20 seconds</span></div>}
    {failed && <p role="alert" className="ms-err">{failed.message}</p>}
  </Card>;
}

export function EditPanel({ c }: { c: StudioCtx }) {
  const l = c.sel?.type === 'image' ? c.sel : null;
  if (!l) return <div className="ms-panel-in"><p className="ms-empty">Tap a picture on the product to edit it. You can remove its background, flip it or fade it.</p></div>;
  const q = dpiQuality(dpiOf(l));
  const working = c.bg?.id === l.id && c.bg.state === 'working';
  const failed = c.bg?.id === l.id && c.bg.state === 'failed' ? c.bg : null;
  return <div className="ms-panel-in">
    <Card title={l.name}>
      <p className={`ms-q ${q.tone}`}>{q.text} · {dpiOf(l)} DPI</p>
      <p className="ms-hint">Printed {l.w.toFixed(1)} × {l.h.toFixed(1)} in</p>
    </Card>
    {q.tone !== 'ok' && q.tone !== 'info' && c.canSharpen(l) && <SharpenCard c={c} l={l} />}
    <Card title="Remove background" hint="Cuts out the main subject for you. Takes 10 to 20 seconds. Free.">
      <button type="button" className="ms-btn rani wide" onClick={() => void c.removeBg(l)} disabled={c.busy || working}><SI name="sparkle" /> {working ? 'Removing…' : 'Remove background'}</button>
      {working && <div className="ms-progress" role="status"><i /><span>Removing the background… please wait</span></div>}
      {failed && <p role="alert" className="ms-err">{failed.message}{failed.offerErase ? ' You can try “Erase plain colour” below instead.' : ''}</p>}
    </Card>
    <EraseCard c={c} l={l} />
    <LookControls c={c} l={l} />
    <Card title="Size">
      <div className="ms-btnrow two">
        <Btn icon="fit" label="Fit to box" onClick={() => {
          const k = Math.min(c.area.w / l.w, c.area.h / l.h);
          c.patch(l.id, { w: l.w * k, h: l.h * k, x: c.area.w / 2, y: c.area.h / 2 });
        }} />
        <Btn icon="area" label="Fill the box" onClick={() => {
          const k = Math.max(c.area.w / l.w, c.area.h / l.h);
          c.patch(l.id, { w: l.w * k, h: l.h * k, x: c.area.w / 2, y: c.area.h / 2 });
        }} />
      </div>
    </Card>
  </div>;
}

/* ── Arrange ──────────────────────────────────────────────────────────── */
export function ArrangePanel({ c }: { c: StudioCtx }) {
  const l = c.sel;
  if (!l) return <div className="ms-panel-in"><p className="ms-empty">Tap something on the product, or in the layers list, to line it up and arrange it.</p></div>;
  return <div className="ms-panel-in">
    <Card title="Line up in the box">
      <div className="ms-btngrid">
        <Btn icon="alignL" label="Left" onClick={() => c.align('left')} />
        <Btn icon="alignCH" label="Centre across" onClick={() => c.align('centerH')} />
        <Btn icon="alignR" label="Right" onClick={() => c.align('right')} />
        <Btn icon="alignT" label="Top" onClick={() => c.align('top')} />
        <Btn icon="alignCV" label="Centre up-down" onClick={() => c.align('centerV')} />
        <Btn icon="alignB" label="Bottom" onClick={() => c.align('bottom')} />
      </div>
    </Card>
    <Card title="Order">
      <div className="ms-btngrid two">
        <Btn icon="up" label="Bring forward" onClick={() => c.order(l.id, 'up')} />
        <Btn icon="down" label="Send back" onClick={() => c.order(l.id, 'down')} />
        <Btn icon="front" label="To front" onClick={() => c.order(l.id, 'front')} />
        <Btn icon="layers" label="To back" onClick={() => c.order(l.id, 'back')} />
      </div>
    </Card>
    <Card title="This layer">
      <div className="ms-btngrid two">
        <Btn icon="copy" label="Duplicate" onClick={() => c.duplicate(l.id)} />
        <Btn icon={l.locked ? 'unlock' : 'lock'} label={l.locked ? 'Unlock' : 'Lock'} on={l.locked} onClick={() => c.patch(l.id, { locked: !l.locked })} />
        <Btn icon={l.visible ? 'eyeoff' : 'eye'} label={l.visible ? 'Hide' : 'Show'} onClick={() => c.patch(l.id, { visible: !l.visible })} />
        <Btn icon="trash" label="Delete" tone="danger" onClick={() => c.remove(l.id)} />
      </div>
    </Card>
  </div>;
}

/* ── Layers ───────────────────────────────────────────────────────────── */
export function LayersPanel({ c }: { c: StudioCtx }) {
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const top = [...c.layers].reverse();
  return <div className="ms-layers">
    <div className="ms-layers-head"><h3>Layers</h3><span>{c.layers.length}</span></div>
    {c.layers.length === 0 && <p className="ms-empty">Nothing here yet. Add a picture or some text.</p>}
    <ul className="ms-layer-list">
      {top.map((l, di) => {
        const arrIdx = c.layers.length - 1 - di;
        return <li key={l.id} className={`ms-layer${c.sel?.id === l.id ? ' on' : ''}${!l.visible ? ' off' : ''}${over === l.id ? ' over' : ''}`}
          onDragOver={e => { if (drag.current) { e.preventDefault(); setOver(l.id); } }} onDragLeave={() => setOver(o => (o === l.id ? null : o))}
          onDrop={e => { e.preventDefault(); const from = c.layers.findIndex(x => x.id === drag.current); drag.current = null; setOver(null); if (from >= 0) c.reorder(from, arrIdx); }}>
          <span className="ms-grip" draggable onDragStart={e => { drag.current = l.id; e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { drag.current = null; setOver(null); }} aria-hidden="true"><SI name="drag" size={18} /></span>
          <button type="button" className="ms-layer-main" onClick={() => c.select(l.id)} aria-label={`Select ${l.name}`}>
            <span className="ms-lthumb">{l.type === 'image' ? <img src={l.src} alt="" draggable={false} /> : <b style={{ fontFamily: `'${l.font}', sans-serif`, color: l.fill }}>Aa</b>}</span>
            {editing === l.id ? null : <span className="ms-lname">{l.name}{l.locked && <SI name="lock" size={14} />}</span>}
          </button>
          {editing === l.id && <input className="ms-rename" autoFocus defaultValue={l.name} maxLength={40} aria-label="Layer name"
            onBlur={e => { c.patch(l.id, { name: e.target.value.trim() || l.name }); setEditing(null); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />}
          <div className="ms-lact">
            <button type="button" className="ms-ibtn" aria-label="Move up" disabled={arrIdx === c.layers.length - 1} onClick={() => c.order(l.id, 'up')}><SI name="up" size={20} /></button>
            <button type="button" className="ms-ibtn" aria-label="Move down" disabled={arrIdx === 0} onClick={() => c.order(l.id, 'down')}><SI name="down" size={20} /></button>
            <button type="button" className="ms-ibtn" aria-label="Rename" onClick={() => setEditing(l.id)}><SI name="pencil" size={20} /></button>
            <button type="button" className={`ms-ibtn${!l.visible ? ' dim' : ''}`} aria-label={l.visible ? 'Hide layer' : 'Show layer'} aria-pressed={!l.visible} onClick={() => c.patch(l.id, { visible: !l.visible })}><SI name={l.visible ? 'eye' : 'eyeoff'} size={20} /></button>
            <button type="button" className={`ms-ibtn${l.locked ? ' on' : ''}`} aria-label={l.locked ? 'Unlock layer' : 'Lock layer'} aria-pressed={l.locked} onClick={() => c.patch(l.id, { locked: !l.locked })}><SI name={l.locked ? 'lock' : 'unlock'} size={20} /></button>
            <button type="button" className="ms-ibtn danger" aria-label="Delete layer" onClick={() => c.remove(l.id)}><SI name="trash" size={20} /></button>
          </div>
        </li>;
      })}
    </ul>
  </div>;
}
