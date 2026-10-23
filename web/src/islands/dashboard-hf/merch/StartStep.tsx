/* [HF-MERCH-STUDIO-2] Wizard step 1 "Your art": upload a picture or make one with AI, then pick which pictures to use. Also the small "add a picture" dialog used from the studio. */
import { useRef, useState, type DragEvent } from 'react';
import { Dialog, Ic } from '../v3/ui';
import { rupees, type AiInfo } from './api';
import { artSrc, uploadMany } from './artUpload';
import type { StudioArt } from './studio/types';

const REVIEW = /checked by our team/i;
export const EARLIER = 'Earlier AI picture';

/** File picker + drag-drop + progress for one or more pictures. */
function useUploader(step: string, onArt: (a: StudioArt) => void) {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  async function take(list: FileList | File[] | null | undefined) {
    const files = list ? Array.from(list) : [];
    if (!files.length || busy) return;
    setBusy(true); setProblems([]);
    const p = await uploadMany(files, step, onArt);
    setProblems(p); setBusy(false);
    if (input.current) input.current.value = '';
  }
  return { busy, problems, input, take };
}

function Choices({ ai, up, onAi, compact }: { ai: AiInfo | null; up: ReturnType<typeof useUploader>; onAi: () => void; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void up.take(e.dataTransfer.files); };
  const showAi = !!ai?.enabled;
  return <div className={`mc-choices${showAi ? '' : ' one'}${compact ? ' compact' : ''}`}>
    <button type="button" className={`mc-choice up${over ? ' over' : ''}`} disabled={up.busy} onClick={() => up.input.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <span className="mc-badge" aria-hidden="true"><Ic name="plus" className="" size={34} /></span>
      <b>{up.busy ? 'Uploading…' : 'Upload your art or photo'}</b>
      <span className="mc-choice-sub">Your own drawing, logo or photo. PNG or JPG, at least 300 × 300 pixels, up to 15 MB. Drop files here or tap to choose.</span>
      <span className="mc-choice-go">Choose pictures</span>
    </button>
    {showAi && <button type="button" className="mc-choice ai" onClick={onAi}>
      <span className="mc-badge" aria-hidden="true"><Ic name="star" className="" size={34} /></span>
      <b>Create with AI</b>
      <span className="mc-choice-sub">Tell us what you want and we paint it for you. You can use your own photo as a guide.</span>
      <span className="mc-choice-go">{rupees(ai.chargePaise)} per picture</span>
    </button>}
    <input ref={up.input} type="file" accept="image/png,image/jpeg" multiple hidden onChange={e => void up.take(e.target.files)} />
  </div>;
}

export default function StartStep({ arts, sel, setSel, remove, addArt, ai, openAi, own, setOwn, needOwn, onNext }: {
  arts: StudioArt[]; sel: string[]; setSel: (s: string[]) => void; remove: (id: string) => void; addArt: (a: StudioArt) => void;
  ai: AiInfo | null; openAi: () => void; own: boolean; setOwn: (v: boolean) => void; needOwn: boolean; onNext: () => void;
}) {
  const up = useUploader('upload_art', a => addArt(a));
  const mine = arts.filter(a => a.label !== EARLIER);
  const earlier = arts.filter(a => a.label === EARLIER);
  const tog = (id: string) => setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const notes = arts.filter(a => sel.includes(a.artId)).flatMap(a => a.checks.warnings.map(w => ({ id: `${a.artId}${w}`, w, review: REVIEW.test(w), name: a.label })));
  const tile = (a: StudioArt) => {
    const on = sel.includes(a.artId);
    return <li key={a.artId} className={`mc-tile${on ? ' on' : ''}`}>
      <button type="button" className="pic" aria-pressed={on} aria-label={`${on ? 'Unselect' : 'Use'} ${a.label || 'picture'}`} onClick={() => tog(a.artId)}>
        <img src={artSrc(a)} alt={a.label || 'Your picture'} draggable={false} />
        {on && <span className="tick" aria-hidden="true"><Ic name="shield" className="" size={20} /></span>}
        {a.source === 'ai' && <span className="tag">AI</span>}
      </button>
      <button type="button" className="rm" aria-label={`Remove ${a.label || 'picture'} from my pictures`} onClick={() => remove(a.artId)}><Ic name="x" className="" size={18} /></button>
    </li>;
  };
  return <div className="mc-col">
    <Choices ai={ai} up={up} onAi={openAi} />
    {up.busy && <p role="status" className="mc-status">Checking and uploading your pictures…</p>}
    {up.problems.map(p => <p key={p} role="alert" className="mc-err">{p}</p>)}

    <section aria-label="My pictures" className="mc-tray">
      <h3 className="mc-h3">My pictures <span className="mc-count">{sel.length} chosen</span></h3>
      {mine.length === 0
        ? <p className="mc-empty">Nothing here yet. Upload a picture or create one with AI, then tap the pictures you want to put on your product.</p>
        : <ul className="mc-tiles">{mine.map(tile)}</ul>}
      {earlier.length > 0 && <>
        <h3 className="mc-h3 sub">Earlier AI pictures</h3>
        <ul className="mc-tiles">{earlier.map(tile)}</ul>
      </>}
    </section>

    {notes.length > 0 && <div className="mc-notes">{notes.map(n => <p key={n.id} className={n.review ? 'mc-note-info' : 'mc-note-warn'}>{n.review ? 'Our team will look at this art before it goes on sale.' : n.w}</p>)}</div>}

    {needOwn && <label className="mc-check own"><input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)} /><span>I own these pictures, or I have the right to sell them on products.</span></label>}
    <div className="mc-foot"><span /><button type="button" className="h3-btn rani mc-big" disabled={sel.length === 0 || (needOwn && !own) || up.busy} onClick={onNext}>Next: choose a product →</button></div>
  </div>;
}

/** Small dialog opened from the studio's "Add picture". */
export function AddArtDialog({ open, onClose, addArt, ai, openAi }: { open: boolean; onClose: () => void; addArt: (a: StudioArt) => void; ai: AiInfo | null; openAi: () => void }) {
  const up = useUploader('studio_upload', a => addArt(a));
  return <Dialog open={open} onClose={onClose} label="Add a picture">
    <h2>Add a picture</h2>
    <p className="muted" style={{ margin: '4px 0 14px' }}>Your design stays as it is. The new picture is added to your pictures.</p>
    <Choices ai={ai} up={up} onAi={() => { onClose(); openAi(); }} compact />
    {up.busy && <p role="status" className="mc-status">Checking and uploading…</p>}
    {up.problems.map(p => <p key={p} role="alert" className="mc-err">{p}</p>)}
    <div className="acts"><button type="button" className="h3-btn ghost mc-big" onClick={onClose}>Done</button></div>
  </Dialog>;
}
