/* [HF-MERCH-STUDIO-2] "Create with AI": reference pictures, prompt, style, cost box, progress and results (use / change / remove background).
 * Every picture costs the admin-set charge from the paid wallet; the server refunds failures. Worker: POST /api/hf/merch/ai/generate. */
import { useEffect, useRef, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { Dialog, Ic, Marigold } from '../v3/ui';
import { generateAi, newRequestKey, removeBackground, rupees, type AiInfo } from './api';
import { AI_STYLES, ASPECTS, EXAMPLES, WAIT_LINES } from './aiStyles';
import { artSrc, uploadMany } from './artUpload';
import type { StudioArt } from './studio/types';

type Aspect = (typeof ASPECTS)[number]['key'];
interface Failure { text: string; short?: number }

export default function AiPanel({ open, onClose, ai, setAi, arts, addArt, onUse, own, setOwn }: {
  open: boolean; onClose: () => void; ai: AiInfo | null; setAi: (f: (p: AiInfo | null) => AiInfo | null) => void;
  arts: StudioArt[]; addArt: (a: StudioArt, select: boolean) => void; onUse: (a: StudioArt) => void; own: boolean; setOwn: (v: boolean) => void;
}) {
  const [refs, setRefs] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string>('');
  const [aspect, setAspect] = useState<Aspect>('1:1');
  const [plain, setPlain] = useState(true);
  const [base, setBase] = useState<StudioArt | null>(null);
  const [results, setResults] = useState<StudioArt[]>([]);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState(0);
  const [fail, setFail] = useState<Failure | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [upBusy, setUpBusy] = useState(false);
  const [upErr, setUpErr] = useState<string[]>([]);
  const [bgBusy, setBgBusy] = useState<string | null>(null);
  const [bgErr, setBgErr] = useState<string | null>(null);
  const confirmedOnce = useRef(false);
  const keyRef = useRef<string | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!busy) return;
    setLine(0);
    const t = setInterval(() => setLine(n => Math.min(n + 1, WAIT_LINES.length - 1)), 6000);
    return () => clearInterval(t);
  }, [busy]);

  if (!ai || !ai.enabled) return <Dialog open={open} onClose={onClose} label="Create with AI"><h2>Create with AI</h2><p className="muted">AI pictures are not available right now.</p></Dialog>;

  const charge = ai.chargePaise;
  const short = Math.max(0, charge - ai.balancePaise);
  const canPay = short === 0;
  const needRight = refs.length > 0 && !own;
  const ready = prompt.trim().length >= 3 && canPay && !busy && !needRight;
  const verb = base ? 'Change picture' : 'Create picture';

  const toggleRef = (id: string) => setRefs(r => (r.includes(id) ? r.filter(x => x !== id) : r.length >= 3 ? r : [...r, id]));
  async function uploadRefs(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (!files.length || upBusy) return;
    setUpBusy(true); setUpErr([]);
    const added: string[] = [];
    const p = await uploadMany(files, 'ai_reference', a => { addArt(a, false); added.push(a.artId); });
    setRefs(r => [...r, ...added].slice(0, 3)); setUpErr(p); setUpBusy(false);
    if (fileIn.current) fileIn.current.value = '';
  }

  async function run() {
    setConfirm(false); setBusy(true); setFail(null);
    const key = (keyRef.current ??= newRequestKey());
    capture('merch_ai', { action: base ? 'change' : 'generate', refs: refs.length, style: style || 'none' });
    const r = await generateAi({
      requestKey: key, prompt: prompt.trim(), style: style || undefined, refArtIds: refs.length ? refs : undefined,
      baseArtId: base?.artId, plainBackground: plain, aspect,
    });
    setBusy(false);
    if (r.ok) {
      keyRef.current = null;
      const art: StudioArt = { ...r.data.art, source: 'ai', label: prompt.trim().slice(0, 40) };
      addArt(art, false);
      setResults(x => [art, ...x]);
      setAi(p => p && { ...p, balancePaise: r.data.balancePaise, canAfford: r.data.balancePaise >= p.chargePaise });
      setBase(null);
      capture('merch_ai', { action: 'done' });
      return;
    }
    const net = r.status === 0 || r.status >= 500;
    if (!net || r.code === 'generation_failed') keyRef.current = null;
    if (r.status === 402) {
      const bal = Number(r.body.balancePaise); const sh = Number(r.body.shortPaise);
      if (Number.isFinite(bal)) setAi(p => p && { ...p, balancePaise: bal, canAfford: bal >= p.chargePaise });
      setFail({ text: 'You do not have enough money in your wallet.', short: Number.isFinite(sh) ? sh : short });
      capture('merch_ai', { action: 'insufficient' });
    } else if (r.code === 'prompt_blocked') {
      setFail({ text: 'We can’t make that picture. Try different words. You were not charged.' });
      capture('merch_ai', { action: 'prompt_blocked' });
    } else {
      setFail({ text: r.message || 'We could not make the picture. If money was taken, it is given back to your wallet.' });
      capture('merch_ai', { action: r.code });
      if (net) captureException(new Error(`merch_ai_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'ai_generate' });
    }
  }

  async function removeBg(a: StudioArt) {
    if (bgBusy) return;
    setBgBusy(a.artId); setBgErr(null); capture('merch_ai', { action: 'remove_bg' });
    const r = await removeBackground(a.artId);
    setBgBusy(null);
    if (r.ok) { const n: StudioArt = { ...r.data.art, source: 'bg_removed', label: `${a.label || 'Picture'} (no background)` }; addArt(n, false); setResults(x => [n, ...x]); }
    else { setBgErr(r.message || 'We could not remove the background.'); if (r.status >= 500 || r.status === 0) captureException(new Error(`merch_bgremove_${r.status}_${r.code}`), { area: 'hf_merch_creator', step: 'ai_bg' }); }
  }
  const change = (a: StudioArt) => { setBase(a); setPrompt(a.label?.replace(/ \(no background\)$/, '') || prompt); setFail(null); promptRef.current?.focus(); promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  return <>
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} label="Create with AI">
      <div className="mc-aipanel">
        <header className="mc-aihead"><h2>Create a picture with AI</h2><p className="muted">Describe what you want. Pick a style. We paint it, then you put it on a product.</p></header>

        <section className="mc-aisec">
          <h3 className="mc-h3">1 · Guide pictures <span className="mc-opt-tag">optional, up to 3</span></h3>
          <p className="small muted">Add your photo or a drawing and the AI uses it as a guide.</p>
          <ul className="mc-tiles small">
            {arts.map(a => <li key={a.artId} className={`mc-tile${refs.includes(a.artId) ? ' on' : ''}`}>
              <button type="button" className="pic" aria-pressed={refs.includes(a.artId)} aria-label={`Use ${a.label || 'picture'} as a guide`} onClick={() => toggleRef(a.artId)}>
                <img src={artSrc(a)} alt={a.label || 'Picture'} draggable={false} />{refs.includes(a.artId) && <span className="tick" aria-hidden="true"><Ic name="shield" className="" size={20} /></span>}
              </button></li>)}
            <li className="mc-tile add"><button type="button" className="pic" disabled={upBusy || refs.length >= 3} onClick={() => fileIn.current?.click()} aria-label="Upload a guide picture">
              <Ic name="plus" className="" size={30} /><span>{upBusy ? 'Uploading…' : 'Upload'}</span></button></li>
          </ul>
          <input ref={fileIn} type="file" accept="image/png,image/jpeg" multiple hidden onChange={e => void uploadRefs(e.target.files)} />
          {upErr.map(p => <p key={p} role="alert" className="mc-err">{p}</p>)}
          {refs.length > 0 && <label className="mc-check own"><input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)} /><span>I have the right to use these pictures.</span></label>}
        </section>

        <section className="mc-aisec">
          <h3 className="mc-h3">2 · What should it look like?</h3>
          {base && <div className="mc-basebar"><img src={artSrc(base)} alt="" /><span>Changing this picture. The new one costs {rupees(charge)} again.</span><button type="button" className="h3-btn sm ghost" onClick={() => setBase(null)}>Start fresh instead</button></div>}
          <label className="f"><span className="mc-lbl">Your idea</span>
            <textarea ref={promptRef} rows={4} maxLength={800} value={prompt} onChange={e => setPrompt(e.target.value)}
              placeholder={base ? 'What should change? e.g. make the background pink and add jasmine flowers' : 'Describe the picture. e.g. A smiling chai seller in a bright hand-painted poster style, with the words “Chai Pe Charcha”'} /></label>
          <div className="mc-egs" aria-label="Example ideas">{EXAMPLES.map(x => <button key={x} type="button" className="mc-eg" onClick={() => setPrompt(x)}>{x}</button>)}</div>
        </section>

        <section className="mc-aisec">
          <h3 className="mc-h3">3 · Style <span className="mc-opt-tag">optional</span></h3>
          <div className="mc-styles" role="radiogroup" aria-label="Style">{AI_STYLES.map(s =>
            <button key={s.key} type="button" role="radio" aria-checked={style === s.key} className={`mc-style${style === s.key ? ' on' : ''}`} onClick={() => setStyle(style === s.key ? '' : s.key)}>
              <i style={{ background: s.bg }} aria-hidden="true">{s.mark}</i><span>{s.label}</span></button>)}</div>
          <div className="mc-aiopts">
            <div role="radiogroup" aria-label="Shape" className="mc-aspects">{ASPECTS.map(a =>
              <button key={a.key} type="button" role="radio" aria-checked={aspect === a.key} className={`mc-asp${aspect === a.key ? ' on' : ''}`} onClick={() => setAspect(a.key)}>
                <i style={{ width: a.w, height: a.h }} aria-hidden="true" />{a.label}</button>)}</div>
            <label className="mc-switch"><input type="checkbox" checked={plain} onChange={e => setPlain(e.target.checked)} /><span>Plain background <small>(best for printing)</small></span></label>
          </div>
        </section>

        <section className="mc-costbox" aria-live="polite">
          <div><b>This picture costs {rupees(charge)}</b><span className="small muted"> · Paid wallet balance {rupees(ai.balancePaise)}</span></div>
          {ai.testCreditPaise > 0 && <p className="small muted">Free credit can&apos;t pay for AI pictures.</p>}
          {!canPay && <p className="mc-err" role="alert">You need {rupees(short)} more. <a className="h3-link" href="/wallet" target="_blank" rel="noopener">Add money to your wallet</a></p>}
          {fail && <p className="mc-err" role="alert">{fail.text}{fail.short ? <> You need {rupees(fail.short)} more. <a className="h3-link" href="/wallet" target="_blank" rel="noopener">Add money to your wallet</a></> : null}</p>}
          {needRight && <p className="small mc-note-warn">Tick &ldquo;I have the right to use these pictures&rdquo; to continue.</p>}
          <button type="button" className="h3-btn rani mc-big mc-gen" disabled={!ready} onClick={() => (confirmedOnce.current ? void run() : setConfirm(true))}>
            {busy ? 'Making your picture…' : `${verb} · ${rupees(charge)}`}</button>
        </section>

        {busy && <div className="mc-wait" role="status"><span className="spin"><Marigold size={64} /></span><b>{WAIT_LINES[line]}</b><span className="small muted">This can take up to a minute. Please keep this window open.</span></div>}

        {results.length > 0 && <section className="mc-aisec"><h3 className="mc-h3">Your new pictures</h3>
          {bgErr && <p role="alert" className="mc-err">{bgErr}</p>}
          <ul className="mc-results">{results.map(a => <li key={a.artId} className="mc-result">
            <img src={artSrc(a)} alt={a.label || 'AI picture'} />
            <div className="acts">
              <button type="button" className="h3-btn rani sm" onClick={() => { capture('merch_ai', { action: 'use' }); onUse(a); onClose(); }}>Use this</button>
              <button type="button" className="h3-btn ghost sm" onClick={() => change(a)}>Change this · {rupees(charge)}</button>
              <button type="button" className="h3-btn ghost sm" disabled={!!bgBusy} onClick={() => void removeBg(a)}>{bgBusy === a.artId ? 'Working…' : 'Remove background · free'}</button>
            </div>
          </li>)}</ul></section>}
      </div>
    </Dialog>
    <Dialog open={confirm} onClose={() => setConfirm(false)} label="Confirm AI picture">
      <h2>Create this picture?</h2>
      <p className="muted" style={{ marginTop: 8 }}>{rupees(charge)} will be taken from your wallet. If the picture can&apos;t be made, you get it back.</p>
      <div className="acts"><button type="button" className="h3-btn ghost mc-big" onClick={() => setConfirm(false)}>Not now</button>
        <button type="button" className="h3-btn rani mc-big" onClick={() => { confirmedOnce.current = true; void run(); }}>Yes, create it</button></div>
    </Dialog>
  </>;
}
