/* [AUMFE-CONSULT-F3-1 2026-10-02] File card renderers, part 2: palmistry, face reading, tarot.
 * Palmistry: photo with line legend (Lines / Photo / Left), what-the-API-sees list, reading tabs. Face: map / photo / side, features, reading tabs.
 * Tarot: the spread the customer drew on Indian card frames (each with Reveal -> shown on the customer's call screen), reading tabs,
 * yes/no card, and "Draw more, live" (shuffle / draw / flip from the 78-card deck, then Reveal). Photos are private blobs. */
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { effective, findKey, humanize, isObj, loadingNote, str, textOf } from './cardData';
import type { J } from './cardData';
import { Badge, Kv, ManualEntry, Section, Tabs, TextBlock, useFile, usePhoto } from './cardUi';
import { cardNameFallback, cardNumeral, FALLBACK_DECK } from './tarotDeck';

/* ───────── palmistry ───────── */

function HandOverlay() {
  return (
    <svg className="ov" viewBox="0 0 250 380" fill="none" aria-hidden="true">
      <path d="M70 370 C60 300 40 250 28 200 C20 170 34 160 46 178 L72 228 L66 70 C66 52 92 52 92 70 L98 190 L104 40 C104 20 132 20 132 40 L134 190 L142 52 C142 34 168 34 168 52 L166 200 L180 96 C182 80 206 82 204 100 L194 240 C190 300 180 340 172 370" stroke="#8a5a36" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M190 236 C160 226 120 224 84 232" stroke="#c82c25" strokeWidth="4" strokeLinecap="round" />
      <path d="M76 262 C110 252 150 256 182 270" stroke="#2f3a7a" strokeWidth="4" strokeLinecap="round" />
      <path d="M78 252 C96 290 100 330 110 362" stroke="#07545b" strokeWidth="4" strokeLinecap="round" />
      <path d="M136 360 C134 320 134 290 132 246" stroke="#b07d12" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function PhotoBox({ kind, overlay, label, children }: { kind: string; overlay?: 'hand' | 'face'; label: string; children?: React.ReactNode }) {
  const p = usePhoto(kind);
  return (
    <div className="cd-photo" style={overlay === 'face' ? { background: 'var(--c1,#7d1820)', minHeight: 330 } : undefined}>
      {p.url ? <img src={p.url} alt={label} /> : (
        <span style={{ position: 'absolute', top: 10, left: 12, right: 12, fontSize: 13, fontWeight: 800, color: overlay === 'face' ? '#f0c7c3' : '#5a3a22' }}>
          {p.state === 'loading' ? 'Loading photo…' : p.state === 'error' ? 'The photo could not be loaded.' : 'No photo for this one.'}
        </span>
      )}
      {overlay === 'hand' ? <HandOverlay /> : null}
      {overlay === 'face' ? <span className="wm face" style={{ position: p.url ? 'absolute' : 'relative', inset: p.url ? '4% 0' : undefined, margin: 'auto', width: 220, height: 282, maxHeight: '92%', opacity: p.url ? 0.45 : 1, backgroundPosition: 'center' }} aria-hidden="true" /> : null}
      {children}
    </div>
  );
}

export function PalmPhotos() {
  const [tab, setTab] = useState<'lines' | 'photo' | 'left'>('lines');
  const left = tab === 'left';
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3>{left ? 'Left palm' : 'Right palm'}</h3>
        <Tabs label="Palm view" value={tab} onChange={setTab} items={[{ id: 'lines', label: 'Lines' }, { id: 'photo', label: 'Photo' }, { id: 'left', label: 'Left' }]} />
      </div>
      <PhotoBox kind={left ? 'palm_left' : 'palm_right'} overlay={tab === 'photo' ? undefined : 'hand'} label={`${left ? 'Left' : 'Right'} palm photo`} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 14, fontWeight: 800 }}>
        <span style={{ color: '#c82c25' }}>● Heart</span><span style={{ color: '#2f3a7a' }}>● Head</span><span style={{ color: '#07545b' }}>● Life</span><span style={{ color: '#8a6410' }}>● Fate</span>
        {tab !== 'photo' ? <span className="hint" style={{ fontWeight: 400 }}>Guide only, not traced on the photo.</span> : null}
      </div>
    </section>
  );
}

export function SeesCard({ title, keys, frame }: { title: string; keys: string[]; frame?: boolean }) {
  const { cards } = useFile();
  const anyData = keys.some((k) => effective(cards[k]) !== undefined && effective(cards[k]) !== null);
  return (
    <section className={`card${frame ? ' frame' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <h3>{title}</h3>
      {keys.map((k) => <Kv key={k} cardKey={k} />)}
      {!anyData ? <p className="muted">{keys.map((k) => loadingNote(cards[k])).find(Boolean)}</p> : null}
      {!anyData ? keys.slice(0, 1).map((k) => <ManualEntry key={k} cardKey={k} note="nothing came back." />) : null}
    </section>
  );
}

export function ReadingsCard({ cardKey, title, frame, order }: { cardKey: string; title: string; frame?: boolean; order?: string[] }) {
  const { cards } = useFile();
  const cur = effective(cards[cardKey]);
  const keys = useMemo(() => {
    if (!isObj(cur)) return [] as string[];
    const all = Object.keys(cur).filter((k) => !k.startsWith('_') && textOf(cur[k]) !== '');
    return order ? [...order.filter((k) => all.includes(k)), ...all.filter((k) => !order.includes(k))] : all;
  }, [cur, order]);
  const [tab, setTab] = useState<string>('');
  const active = keys.includes(tab) ? tab : keys[0];
  return (
    <Section cardKey={cardKey} title={title} frame={frame}>
      {keys.length > 1 ? <Tabs label="Reading topic" value={active} onChange={setTab} items={keys.map((k) => ({ id: k, label: humanize(k) }))} /> : null}
      <TextBlock cardKey={cardKey} path={keys.length ? [active] : []} />
    </Section>
  );
}

/* ───────── face reading ───────── */

export function FacePhotos() {
  const [tab, setTab] = useState<'map' | 'photo' | 'side'>('map');
  return (
    <section className="card frame" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3>Face map</h3>
        <Tabs label="Face view" value={tab} onChange={setTab} items={[{ id: 'map', label: 'Map' }, { id: 'photo', label: 'Photo' }, { id: 'side', label: 'Side' }]} />
      </div>
      <PhotoBox kind={tab === 'side' ? 'face_side' : 'face_front'} overlay={tab === 'map' ? 'face' : undefined} label={tab === 'side' ? 'Side photo' : 'Front photo'} />
      {tab === 'map' ? <span className="hint">Guide zones only, not traced on the photo.</span> : null}
    </section>
  );
}

/* ───────── tarot ───────── */

const POS = [{ key: 'love', label: 'Love' }, { key: 'career', label: 'Career' }, { key: 'finance', label: 'Money' }] as const;
interface SpreadCard { position: string; id: number; name: string; reversed: boolean }

function useDeck(): string[] {
  const { cards } = useFile();
  const d = findKey(effective(cards.spread), ['deck', 'deck_names', 'tarot_deck', 'all_cards'], 3);
  if (Array.isArray(d) && d.length >= 78) return d.map((x, i) => str(isObj(x) ? x.name : x) || cardNameFallback(i));
  return FALLBACK_DECK;
}

function useSpread(deck: string[]): SpreadCard[] {
  const { cards, file } = useFile();
  const sp = effective(cards.spread);
  if (isObj(sp) && Array.isArray(sp.cards)) {
    return (sp.cards as J[]).filter(isObj).map((c, i) => {
      const id = Number(c.id ?? c.card ?? c.card_id ?? -1);
      return { position: str(c.position) || POS[i]?.label || `Card ${i + 1}`, id, name: str(c.name) || deck[id] || cardNameFallback(id), reversed: c.reversed === true };
    });
  }
  if (file.intake.kind !== 'tarot') return [];
  const it = file.intake;
  return POS.map((p) => ({ position: p.label, id: it.cards[p.key], name: deck[it.cards[p.key]] ?? cardNameFallback(it.cards[p.key]), reversed: it.reversed?.[p.key] === true }));
}

function Ic({ c, style }: { c: { name: string; id: number; reversed: boolean; label?: string }; style?: CSSProperties }) {
  const n = cardNumeral(c.id);
  return (
    <div className={`icard${c.reversed ? ' rev' : ''}`} style={style} role="img" aria-label={`${c.label ? `${c.label}: ` : ''}${c.name}${c.reversed ? ', reversed' : ''}`}>
      <span className="pos">{c.label ?? n}</span>
      <span className="art" />
      <span className="nm">{n && c.label ? `${n} · ` : ''}{c.name}</span>
    </div>
  );
}

function RevealButton({ card, label }: { card: { id: number; reversed: boolean; position: string; name: string }; label: string }) {
  const { connected, reveal, customerFirst } = useFile();
  const [shown, setShown] = useState(false);
  const go = () => { if (reveal({ id: card.id, reversed: card.reversed, position: `${label}|${card.name}` })) setShown(true); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      {shown ? <span style={{ fontSize: 13, fontWeight: 800 }}>✓ Shown to {customerFirst}</span> : null}
      <button type="button" className="edit" style={{ color: '#f6e7c4' }} disabled={!connected} title={connected ? undefined : 'Reveal works once the call is connected'} onClick={go}>{shown ? 'Show again' : 'Reveal'}</button>
    </div>
  );
}

export function SpreadCard() {
  const { cards, save, customerFirst } = useFile();
  const deck = useDeck();
  const spread = useSpread(deck);
  const card = cards.spread;
  const cur = effective(card);
  const [edit, setEdit] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const [rev, setRev] = useState(false);
  const hasOv = !!card && card.override !== null && card.override !== undefined;
  const write = async (idx: number) => {
    const next: SpreadCard[] = spread.map((c, i) => (i === idx ? { ...c, id: pick, name: deck[pick] ?? cardNameFallback(pick), reversed: rev } : c));
    if (await save('spread', { ...(isObj(cur) ? cur : {}), cards: next })) setEdit(null);
  };
  return (
    <section className="card cd-dark" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3>Spread {customerFirst} drew{hasOv && card ? <Badge card={card} /> : null}</h3>
        <span style={{ fontSize: 13, fontWeight: 800 }}>{spread.length} cards{hasOv ? <button type="button" className="edit" style={{ color: '#f6e7c4' }} onClick={() => void save('spread', null)}>Undo all</button> : null}</span>
      </div>
      {spread.length ? (
        <div className="cd-spread">
          {spread.map((c, i) => (
            <div key={`${c.position}${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', minWidth: 0 }}>
              <Ic c={{ ...c, label: c.position }} style={{ width: '100%' }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>{c.reversed ? 'Reversed' : 'Upright'}</span>
              <RevealButton card={c} label={c.position} />
              <button type="button" className="edit" style={{ color: '#f6e7c4' }} onClick={() => { setEdit(i); setPick(c.id); setRev(c.reversed); }}>Change card</button>
            </div>
          ))}
        </div>
      ) : <p>The spread was not recorded. {loadingNote(card)}</p>}
      {edit !== null ? (
        <div className="card" style={{ background: '#fff', color: 'var(--ink)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field"><label htmlFor="pick-card">Card for {spread[edit]?.position}</label>
            <select id="pick-card" value={pick} onChange={(e) => setPick(Number(e.target.value))}>{deck.map((n, i) => <option key={i} value={i}>{cardNumeral(i) ? `${cardNumeral(i)} · ` : ''}{n}</option>)}</select></div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 800 }}><input type="checkbox" checked={rev} onChange={(e) => setRev(e.target.checked)} style={{ width: 22, height: 22 }} /> Reversed</label>
          <div className="cd-row"><button type="button" className="btn small" onClick={() => void write(edit)}>Save</button><button type="button" className="btn small ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      ) : null}
    </section>
  );
}

export function TarotReadings() {
  const { cards } = useFile();
  const cur = effective(cards.readings);
  const keys = useMemo(() => {
    if (!isObj(cur)) return [] as { key: string; label: string }[];
    const out: { key: string; label: string }[] = [];
    for (const p of POS) {
      const real = Object.keys(cur).find((k) => k.toLowerCase() === p.key || (p.key === 'finance' && /^(money|finance|wealth)$/i.test(k)));
      if (real && textOf(cur[real])) out.push({ key: real, label: p.label });
    }
    for (const k of Object.keys(cur)) if (!k.startsWith('_') && !out.some((o) => o.key === k) && textOf(cur[k])) out.push({ key: k, label: humanize(k) });
    return out;
  }, [cur]);
  const [tab, setTab] = useState('');
  const active = keys.find((k) => k.key === tab) ?? keys[0];
  return (
    <Section cardKey="readings" title={`API reading${active ? ` · ${active.label}` : ''}`}>
      <TextBlock cardKey="readings" path={active ? [active.key] : []} />
      {keys.length > 1 ? <Tabs label="Reading card" value={active?.key ?? ''} onChange={setTab} items={keys.map((k) => ({ id: k.key, label: k.label }))} /> : null}
    </Section>
  );
}

export function YesNoCard() {
  const { cards, file } = useFile();
  const deck = useDeck();
  const card = cards.yes_no;
  const cur = effective(card);
  const q = file.intake.kind === 'tarot' ? file.intake.yes_no?.question ?? '' : '';
  const cid = file.intake.kind === 'tarot' && file.intake.yes_no ? file.intake.yes_no.card : Number(findKey(cur, ['card', 'card_id', 'id'], 2));
  const answer = str(findKey(cur, ['answer', 'yes_no', 'result', 'verdict', 'response'], 2));
  const desc = textOf(findKey(cur, ['description', 'text', 'prediction', 'reading', 'meaning'], 2) ?? '');
  const cardObj = Number.isFinite(cid) && cid >= 0 ? { id: cid, name: deck[cid] ?? cardNameFallback(cid), reversed: false } : null;
  if (!q && !card) return null;
  return (
    <Section cardKey="yes_no" title="Yes / no question">
      {q ? <p style={{ fontSize: 16, fontWeight: 700 }}>“{q}”</p> : null}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {cardObj ? <Ic c={cardObj} style={{ width: 96, height: 150, flexShrink: 0, padding: '14px 4px 8px' }} /> : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          {answer ? <span className="chip" style={{ background: '#f6e7c4', color: '#6b4e12', alignSelf: 'flex-start' }}>{answer}</span> : null}
          {desc ? <span style={{ fontSize: 15 }}>{desc}</span> : null}
        </div>
      </div>
      <details><summary style={{ fontWeight: 800, cursor: 'pointer', minHeight: 36, display: 'flex', alignItems: 'center' }}>Edit these details</summary><Kv cardKey="yes_no" /></details>
    </Section>
  );
}

interface Drawn { id: number; reversed: boolean; up: boolean; n: number }
export function DrawMore() {
  const { connected, reveal, customerFirst, file } = useFile();
  const deck = useDeck();
  const spread = useSpread(deck);
  const used = useMemo(() => new Set(spread.map((c) => c.id)), [spread]);
  const [order, setOrder] = useState<number[]>(() => deck.map((_, i) => i).filter((i) => !used.has(i)));
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const [shuffling, setShuffling] = useState(false);
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const shuffle = () => {
    setShuffling(true);
    const a = deck.map((_, i) => i).filter((i) => !used.has(i) && !drawn.some((d) => d.id === i));
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    setOrder(a);
    setTimeout(() => setShuffling(false), 1000);
  };
  const draw = () => {
    if (!order.length) return;
    const [id, ...rest] = order;
    setOrder(rest);
    setDrawn((d) => [...d, { id, reversed: Math.random() < 0.25, up: false, n: d.length + 1 }]);
  };
  const flip = () => setDrawn((d) => { const i = d.findIndex((x) => !x.up); return i < 0 ? d : d.map((x, k) => (k === i ? { ...x, up: true } : x)); });
  const hasDown = drawn.some((d) => !d.up);
  return (
    <Section title="Draw more, live">
      <div className={`cd-deckrow${shuffling ? ' cd-shuffle' : ''}`} aria-label={`${order.length} cards left in the deck`} role="img">
        {[0, 1, 2, 3].map((i) => <div key={i} className="cardback" />)}
        <span className="hint" style={{ marginLeft: 8 }}>{order.length} left</span>
      </div>
      <div className="cd-row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn small" onClick={shuffle}>Shuffle</button>
        <button type="button" className="btn small ghost" onClick={draw} disabled={!order.length}>Draw a card</button>
        <button type="button" className="btn small ghost" onClick={flip} disabled={!hasDown}>Flip</button>
      </div>
      {drawn.length ? (
        <div className="cd-deckrow" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 12 }}>
          {drawn.map((d) => {
            const name = deck[d.id] ?? cardNameFallback(d.id);
            return d.up ? (
              <div key={d.n} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 104 }}>
                <div className={`icard${d.reversed ? ' rev' : ''}`} style={{ width: 104, height: 160, padding: '14px 4px 8px' }}><span className="pos">Extra {d.n}</span><span className="art" /><span className="nm" style={{ fontSize: 13 }}>{name}</span></div>
                <span style={{ fontSize: 13, fontWeight: 800 }}>{d.reversed ? 'Reversed' : 'Upright'}</span>
                {shown[d.n] ? <span style={{ fontSize: 13, fontWeight: 800 }}>✓ Shown to {customerFirst}</span> : null}
                <button type="button" className="edit" disabled={!connected} title={connected ? undefined : 'Reveal works once the call is connected'}
                  onClick={() => { if (reveal({ id: d.id, reversed: d.reversed, position: `Extra ${d.n}|${name}` })) setShown((s) => ({ ...s, [d.n]: true })); }}>{shown[d.n] ? 'Show again' : 'Reveal'}</button>
              </div>
            ) : <div key={d.n} className="cardback" style={{ width: 70, height: 108 }} role="img" aria-label="Face-down card" />;
          })}
        </div>
      ) : null}
      <span className="hint">“Reveal” shows the card on {file.booking.customer.name.split(' ')[0]}’s call screen.{connected ? '' : ' Join the call first.'}</span>
    </Section>
  );
}

