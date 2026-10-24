/* [HF-MERCH-STUDIO-2] "+ New product": 1 Your art (upload or AI) · 2 Product · 3 Design (studio/Designer) · 4 Price & publish.
 * This file is the shell and the shared state; every step lives in its own file. Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { Dialog, Marigold } from '../v3/ui';
import AiPanel from './AiPanel';
import PriceStep from './PriceStep';
import ProductStep from './ProductStep';
import StartStep, { AddArtDialog, EARLIER } from './StartStep';
import { deleteAiPicture, fetchArtFile, getAi, type AiInfo, type CatalogInfo, type CatalogItem, type Product } from './api';
import Designer from './studio/Designer';
import type { DesignResult, Layer, Side, StudioArt } from './studio/types';

const STEPS = ['Your art', 'Product', 'Design', 'Price & publish'];
const STEP_KEY = ['your_art', 'product', 'design', 'price_publish'];

export default function Wizard({ info, minMarkup, onClose, onPublished, onSaved }: { info: CatalogInfo; minMarkup: number; onClose: () => void; onPublished: (p: Product) => void; /** [HF-MERCH-QA-1] Called the moment a product is saved, so the page can refresh its numbers. */ onSaved?: (p: Product) => void }) {
  const [step, setStep] = useState(0);
  const [arts, setArts] = useState<StudioArt[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [own, setOwn] = useState(false);
  const [ai, setAi] = useState<AiInfo | null>(null);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [colours, setColoursState] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [side, setSideState] = useState<Side>('front');
  const [layers, setLayers] = useState<Layer[]>([]);
  const [placed, setPlacedState] = useState<DesignResult | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [leave, setLeave] = useState(false);
  const [done, setDone] = useState<Product | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const artsRef = useRef(arts); artsRef.current = arts;
  const placedRef = useRef(placed); placedRef.current = placed;

  useEffect(() => { capture('merch_studio_step', { step: done ? 'published' : STEP_KEY[step] }); topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [step, done]);
  useEffect(() => () => { // free the object URLs when the wizard closes
    for (const a of artsRef.current) if (a.localUrl) URL.revokeObjectURL(a.localUrl);
    if (placedRef.current) URL.revokeObjectURL(placedRef.current.previewUrl);
  }, []);

  useEffect(() => { // AI info + the last pictures made earlier; AI stays hidden when it fails or is off
    let live = true;
    void getAi().then(r => {
      if (!live) return;
      if (!r.ok) { if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_ai_info_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'ai_info' }); return; }
      setAi(r.data);
      setArts(prev => {
        const have = new Set(prev.map(a => a.artId));
        // [HF-MERCH-ART-REUSE-1] One tile per picture, and only pictures that can be shown.
        const usable = (r.data.recent ?? []).filter(g => /^dsn-[a-f0-9]{8}$/.test(g.artId) && /^https?:\/\//.test(g.url) && g.width > 0 && g.height > 0 && !have.has(g.artId) && (have.add(g.artId), true));
        const more = usable.map((g): StudioArt => ({
          artId: g.artId, url: g.url, width: g.width, height: g.height, checks: { ok: true, dpiAtFullWidth: 0, warnings: [] }, source: 'ai', label: EARLIER,
        }));
        return more.length ? [...prev, ...more] : prev;
      });
    });
    return () => { live = false; };
  }, []);

  // Every tray picture gets a local copy (object URL) so the studio can draw, erase and export it without a tainted canvas.
  const fetching = useRef(new Set<string>());
  useEffect(() => {
    for (const a of arts) {
      if (a.localUrl || fetching.current.has(a.artId)) continue;
      fetching.current.add(a.artId);
      void fetchArtFile(a.artId).then(blob => {
        if (!blob) { fetching.current.delete(a.artId); captureException(new Error('merch_art_file_failed'), { area: 'hf_merch_creator', step: 'art_file' }); return; }
        const localUrl = URL.createObjectURL(blob);
        setArts(p => p.some(x => x.artId === a.artId && !x.localUrl) ? p.map(x => (x.artId === a.artId && !x.localUrl ? { ...x, localUrl } : x)) : (URL.revokeObjectURL(localUrl), p));
      });
    }
  }, [arts]);

  const setPlaced = useCallback((p: DesignResult | null) => {
    setPlacedState(old => { if (old && old.previewUrl !== p?.previewUrl) URL.revokeObjectURL(old.previewUrl); return p; });
  }, []);
  const addArt = useCallback((a: StudioArt, select = true) => {
    setArts(p => (p.some(x => x.artId === a.artId) ? p : [...p, a]));
    if (select) setSel(s => (s.includes(a.artId) ? s : [...s, a.artId]));
  }, []);
  const [rmErr, setRmErr] = useState<string | null>(null);
  const removeArt = (id: string) => {
    const gone = arts.find(a => a.artId === id);
    setArts(p => p.filter(a => a.artId !== id)); setSel(s => s.filter(x => x !== id)); setRmErr(null);
    if (layers.some(l => l.type === 'image' && l.artId === id)) { setLayers(l => l.filter(x => x.type !== 'image' || x.artId !== id)); setPlaced(null); }
    // [HF-MERCH-AI-DELETE-1] an AI picture comes back from the server on every load, so it is deleted there too (not just hidden here).
    if (gone?.source === 'ai') {
      setAi(x => (x ? { ...x, recent: x.recent.filter(g => g.artId !== id) } : x));
      capture('merch_ai', { action: 'delete_picture' });
      void deleteAiPicture(id).then(r => {
        if (r.ok) return;
        setArts(p => (p.some(a => a.artId === id) ? p : [...p, gone]));
        setRmErr(r.message || 'We could not delete that picture. Please try again.');
        captureException(new Error(`merch_ai_delete_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'ai_delete' });
      });
    }
  };

  const selected = useMemo(() => sel.map(id => arts.find(a => a.artId === id)).filter((a): a is StudioArt => !!a), [sel, arts]);
  const needOwn = selected.some(a => a.source === 'upload');
  const swatches = useMemo(() => (item ? item.colours.filter(c => colours.includes(c.name)) : []), [item, colours]);

  const pickItem = (c: CatalogItem) => {
    if (item?.id !== c.id) { setLayers([]); setPlaced(null); }
    setItem(c); setColoursState(c.colours.slice(0, 1).map(x => x.name)); setSizes(c.sizes.map(s => s.size)); setSideState(c.side.includes('front') ? 'front' : c.side[0]);
  };
  const setSide = (s: Side) => { if (s !== side) { setSideState(s); setLayers([]); setPlaced(null); } };
  const setColours = (c: string[]) => { setColoursState(c); setPlaced(null); };
  const dirty = arts.some(a => a.label !== EARLIER) || step > 0;
  const goTo = (i: number) => { if (i < step) setStep(i); };
  const again = () => { // "Make another": start clean, keep the AI info
    for (const a of arts) if (a.localUrl) URL.revokeObjectURL(a.localUrl);
    // [HF-MERCH-ART-REUSE-1] Keep the earlier AI pictures (fetched again, the old local copies are freed) so the same art can go on another product.
    fetching.current.clear();
    setPlaced(null); setArts(a => a.filter(x => x.label === EARLIER).map(x => ({ ...x, localUrl: undefined }))); setSel([]); setOwn(false); setItem(null); setColoursState([]); setSizes([]); setSideState('front'); setLayers([]); setStep(0); setDone(null);
  };

  if (done) return <div className="mc-wiz" ref={topRef}><div className="mc-done">
    <div className="mc-burst" aria-hidden="true"><span className="ring" /><span className="ring r2" /><Marigold size={96} /></div>
    <h2>{done.status === 'live' ? 'Your product is live!' : 'Sent for review'}</h2>
    <p className="muted">{done.status === 'live' ? 'Fans can buy it now. Share the link from your products page.' : 'Our team will check your art, then it goes on sale. You will see the status on your products page.'}</p>
    <div className="mc-donebtns">
      <button type="button" className="h3-btn rani mc-big" onClick={() => onPublished(done)}>Back to my products</button>
      <button type="button" className="h3-btn ghost mc-big" onClick={again}>Make another</button>
    </div>
  </div></div>;

  return <div className="mc-wiz" ref={topRef}>
    <header className="mc-hero">
      <div><h2>Make a new product</h2><p>Add your art, choose what to print it on, and set your price. We print and ship it.</p></div>
      <button type="button" className="h3-btn sm ghost" onClick={() => (dirty ? setLeave(true) : onClose())}>Close</button>
      <span className="mc-rangoli" aria-hidden="true" />
    </header>
    <nav aria-label="Steps" className="mc-toran">
      <ol>{STEPS.map((s, i) => (
        <li key={s} className={i === step ? 'cur' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
          <button type="button" disabled={i >= step} onClick={() => goTo(i)} aria-label={`Step ${i + 1}: ${s}${i < step ? ', done. Go back' : ''}`}>
            <span className="n">{i < step ? '✓' : i + 1}</span><span className="t">{s}</span></button></li>))}
      </ol>
    </nav>

    <div className="mc-body">
      {step === 0 && rmErr && <p role="alert" className="mc-err">{rmErr}</p>}
      {step === 0 && <StartStep arts={arts} sel={sel} setSel={setSel} remove={removeArt} addArt={a => addArt(a)} ai={ai} openAi={() => setAiOpen(true)}
        own={own} setOwn={setOwn} needOwn={needOwn} onNext={() => setStep(1)} />}
      {step === 1 && <ProductStep info={info} item={item} colours={colours} sizes={sizes} side={side} pick={pickItem} setColours={setColours} setSizes={setSizes} setSide={setSide}
        onBack={() => setStep(0)} onNext={() => setStep(2)} />}
      {step === 2 && item && <Designer item={item} side={side} colours={swatches} arts={selected}
        onArtAdded={a => addArt(a, true)} onWantMoreArt={() => setAddOpen(true)} initialLayers={layers} onLayersChange={setLayers}
        onBack={() => setStep(1)} onDone={r => { setPlaced(r); setLayers(r.layers); setStep(3); }} />}
      {step === 3 && item && placed && <PriceStep info={info} item={item} colours={colours} sizes={sizes} side={side} placed={placed} minMarkup={minMarkup}
        onBack={() => setStep(2)} onDone={p => { setDone(p); onSaved?.(p); }} />}
    </div>

    <AddArtDialog open={addOpen} onClose={() => setAddOpen(false)} addArt={a => addArt(a, true)} ai={ai} openAi={() => setAiOpen(true)} />
    <AiPanel open={aiOpen} onClose={() => setAiOpen(false)} ai={ai} setAi={f => setAi(f)} arts={arts} addArt={addArt} onUse={a => addArt(a, true)} own={own} setOwn={setOwn} />
    <Dialog open={leave} onClose={() => setLeave(false)} label="Leave without saving">
      <h2>Leave without publishing?</h2><p className="muted" style={{ marginTop: 8 }}>Your pictures are saved with us, but this product is not made yet.</p>
      <div className="acts"><button type="button" className="h3-btn ghost mc-big" onClick={() => setLeave(false)}>Keep working</button><button type="button" className="h3-btn rani mc-big" onClick={onClose}>Leave</button></div>
    </Dialog>
  </div>;
}
