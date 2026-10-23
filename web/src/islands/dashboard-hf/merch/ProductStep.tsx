/* [HF-MERCH-STUDIO-2] Wizard step 2 "Product": category tabs, tall product cards with the product silhouette, then side / colours / sizes. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ic } from '../v3/ui';
import { rupees, type CatalogInfo, type CatalogItem } from './api';
import { ProductSilhouette, familyOf } from './studio/silhouettes';
import type { Side } from './studio/types';

const tog = (arr: string[], v: string, max = 99) => (arr.includes(v) ? arr.filter(x => x !== v) : arr.length >= max ? arr : [...arr, v]);
const fromPaise = (c: CatalogItem) => Math.min(...c.sizes.map(s => s.basePaise));

export default function ProductStep({ info, item, colours, sizes, side, pick, setColours, setSizes, setSide, onBack, onNext }: {
  info: CatalogInfo; item: CatalogItem | null; colours: string[]; sizes: string[]; side: Side; pick: (c: CatalogItem) => void;
  setColours: (c: string[]) => void; setSizes: (s: string[]) => void; setSide: (s: Side) => void; onBack: () => void; onNext: () => void;
}) {
  const [cat, setCat] = useState('all');
  const panel = useRef<HTMLDivElement>(null);
  const cats = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of info.items) { const k = c.category || 'other'; if (!m.has(k)) m.set(k, c.categoryLabel || 'More'); }
    return [...m.entries()];
  }, [info.items]);
  const shown = cat === 'all' ? info.items : info.items.filter(c => (c.category || 'other') === cat);

  useEffect(() => { // on phones the options sit below the grid: bring them into view after a pick
    if (item && panel.current && matchMedia('(max-width: 1099px)').matches) panel.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="mc-col">
    {info.items.length === 0 && <p className="mc-empty">No products are available right now. Please try again in a little while.</p>}
    {cats.length > 1 && <div className="mc-tabs" role="tablist" aria-label="Product type">
      {[['all', 'All'] as [string, string], ...cats].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={cat === k} className={cat === k ? 'on' : ''} onClick={() => setCat(k)}>{l}</button>)}
    </div>}
    <div className="mc-pgrid">
      <ul className="mc-pcards" aria-label="Products">{shown.map(c => {
        const on = item?.id === c.id; const cols = c.colours;
        return <li key={c.id}><button type="button" className={`mc-pcard${on ? ' on' : ''}`} aria-pressed={on} onClick={() => pick(c)}>
          <span className="stage"><ProductSilhouette family={familyOf(c)} hex={cols[0]?.hex ?? '#ffffff'} size={170} /></span>
          {on && <span className="tick" aria-hidden="true"><Ic name="shield" className="" size={22} /></span>}
          <b>{c.name}</b>
          <span className="from">from {rupees(fromPaise(c))}</span>
          <span className="small muted">incl. printing, GST &amp; delivery</span>
          <span className="dots" aria-hidden="true">{cols.slice(0, 8).map(x => <i key={x.name} style={{ background: x.hex }} />)}{cols.length > 8 && <em>+{cols.length - 8}</em>}</span>
        </button></li>;
      })}</ul>

      <aside className="mc-opts" ref={panel} aria-label="Product options">
        {!item ? <div className="mc-opts-empty"><Ic name="bag" className="" size={40} /><p>Pick a product to choose its colours and sizes.</p></div> : <>
          <h3 className="mc-h3">{item.name}</h3>
          {item.side.length > 1 && <div className="mc-ctl"><h4>Where does the print go?</h4><div className="mc-seg" role="radiogroup" aria-label="Print side">
            {item.side.map(s => <button key={s} type="button" role="radio" aria-checked={side === s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s === 'front' ? 'Front' : 'Back'}</button>)}</div></div>}
          <div className="mc-ctl"><h4>Colours <span className="small muted">(up to 8)</span></h4><div className="mc-rounds">{item.colours.map(c => {
            const on = colours.includes(c.name);
            return <button key={c.name} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => setColours(tog(colours, c.name, 8))}><i style={{ background: c.hex }} />{c.name}</button>;
          })}</div></div>
          <div className="mc-ctl"><h4>Sizes and base price</h4><div className="mc-sizes-pick">{item.sizes.map(s => {
            const on = sizes.includes(s.size);
            return <button key={s.size} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => setSizes(tog(sizes, s.size))}><b>{s.size}</b><span>{rupees(s.basePaise)}</span></button>;
          })}</div>
            <p className="small muted">The base price covers printing (incl. GST) and delivery, shown for the largest print. Smaller prints cost less. You see the exact base in the last step.</p></div>
        </>}
      </aside>
    </div>
    <div className="mc-foot"><button type="button" className="h3-btn ghost mc-big" onClick={onBack}>← Back</button>
      <button type="button" className="h3-btn rani mc-big" disabled={!item || !colours.length || !sizes.length} onClick={onNext}>Next: design it →</button></div>
  </div>;
}
