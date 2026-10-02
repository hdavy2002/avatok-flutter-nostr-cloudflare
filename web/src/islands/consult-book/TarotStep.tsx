/* [AUMFE-CONSULT-F2-1 2026-10-02] Step 2 for tarot — shuffle and draw (mockup BookTarot). Nine face-down cards fan out
 * (art: motifs/tarot-back.svg via .cardback); the customer taps three (Love / Work / Money) and optionally a fourth
 * yes-or-no card. Card ids are 1..78 (the yes/no card is a major arcana, 1..22) and are saved in intake.cards /
 * intake.yes_no exactly as drawn. Randomness is crypto.getRandomValues, never Math.random. */
import { useEffect, useRef, useState } from 'react';
import { capture } from '../../lib/analytics';
import { tarotDrawn } from './bookLogic';
import type { TarotForm } from './bookLogic';

const POS: [string, string][] = [['प्रेम', 'Love'], ['कार्य', 'Work'], ['धन', 'Money']];
const FAN = 9;

function rnd(n: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}
function shuffledFan(): number[] {
  const deck = Array.from({ length: 78 }, (_, i) => i + 1);
  for (let i = deck.length - 1; i > 0; i--) { const j = rnd(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck.slice(0, FAN);
}

export function TarotStep({ f, set, error, onContinue }: { f: TarotForm; set: (f: TarotForm) => void; error: string | null; onContinue: () => void }) {
  const [fan, setFan] = useState<number[]>([]);
  const [ynNum, setYnNum] = useState<number | null>(null);
  const sent = useRef(false);
  useEffect(() => { setFan(shuffledFan()); }, []);

  const got = f.picks.length + (f.yesNoCard != null ? 1 : 0);
  const need = 3 + (f.yesNo ? 1 : 0);
  const done = tarotDrawn(f);

  useEffect(() => {
    if (done && !sent.current) { sent.current = true; capture('consult_tarot_drawn', { discipline: 'tarot', yes_no: f.yesNo }); }
    if (!done) sent.current = false;
  }, [done, f.yesNo]);

  function pick(num: number) {
    if (f.picks.includes(num) || num === ynNum) return;
    if (f.picks.length < 3) {
      set({ ...f, picks: [...f.picks, num], reversed: [...f.reversed, rnd(4) === 0] });
    } else if (f.yesNo && f.yesNoCard == null) {
      setYnNum(num);
      set({ ...f, yesNoCard: ((num - 1) % 22) + 1 });
    }
  }
  function shuffle() {
    setFan(shuffledFan());
    setYnNum(null);
    set({ ...f, picks: [], reversed: [], yesNoCard: null });
  }
  function toggleYesNo(on: boolean) {
    if (!on) setYnNum(null);
    set({ ...f, yesNo: on, yesNoCard: on ? f.yesNoCard : null });
  }

  return (
    <>
      <div className="field">
        <label htmlFor="t-q">Your question</label>
        <input id="t-q" value={f.question} maxLength={200} placeholder="Should I take the new job?" onChange={(e) => set({ ...f, question: e.target.value })} />
      </div>
      <div className="preview cb-tarot">
        <span className="deva hd">पत्ते चुनें · tap {need === 4 ? 'four' : 'three'} cards</span>
        <div className="cb-tgrid">
          {POS.map((p, i) => (f.picks[i] != null ? (
            <div key={i} className={`icard${f.reversed[i] ? ' rev' : ''}`}><span className="pos">{p[0]}</span><span className="art" /><span className="nm">Card {f.picks[i]}{f.reversed[i] ? ' · reversed' : ''}</span></div>
          ) : (
            <div key={i} className="cb-empty"><span><span className="deva">{p[0]}</span><br />{p[1]}</span></div>
          )))}
          {f.yesNo && (f.yesNoCard != null ? (
            <div className="icard yn"><span className="pos">हाँ / ना</span><span className="art" /><span className="nm">Card {f.yesNoCard}</span></div>
          ) : (
            <div className="cb-empty yn"><span><span className="deva">हाँ / ना</span><br />Yes or no</span></div>
          ))}
        </div>
      </div>
      <div className="cb-fan" role="group" aria-label="Cards to draw from">
        {fan.map((num, i) => {
          const used = f.picks.includes(num) || num === ynNum;
          const rot = (i - 4) * 7;
          return (
            <button key={num} type="button" className="cardback" aria-label={used ? `Card ${i + 1}, already drawn` : `Card ${i + 1}`} disabled={used || got >= need}
              onClick={() => pick(num)}
              style={{ top: Math.abs(i - 4) * 5 + (used ? -18 : 0), left: `calc(50% - 40px + ${(i - 4) * 30}px)`, transform: `rotate(${rot}deg)`, opacity: used ? 0.35 : 1 }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}><button type="button" className="btn small ghost" onClick={shuffle}>Shuffle again</button></div>
      <label className="cb-check"><input type="checkbox" checked={f.yesNo} onChange={(e) => toggleYesNo(e.target.checked)} /> Add a yes-or-no card for my question</label>
      {error && <p className="cb-err" role="alert">{error}</p>}
      <button type="button" className="btn cat" disabled={!done} onClick={onContinue}>{done ? 'Continue — pick a time' : `Pick ${need - got} more`}</button>
      <p className="hint cb-center">These exact cards are saved for your consultant to read before your call.</p>
    </>
  );
}
