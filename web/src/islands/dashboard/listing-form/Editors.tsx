/* [LIST-WIZ-1] Small reusable add/remove list editors shared by steps 5 and 6 —
 * every one of these backs an `attrs.content_*` array the server validates in
 * contentAttrsError (worker/src/routes/listings.ts). Kept generic (not typed to
 * one shape) so the same editor backs how-it-works {label,body}, house rules
 * {heading,body}, FAQ {q,a}, sample Q&A {q,a} and sample chat {who,line}. */
import type { ReactNode } from 'react';

const labelCls = 'mb-2 block font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft';
const inputCls = 'w-full rounded-zineField border-zine border-ink bg-card px-3 py-2.5 font-body font-bold text-[15px] text-ink outline-none shadow-zine-xs';
const textareaCls = `${inputCls} resize-none`;

export function charCount(value: string, max: number) {
  const over = value.length > max;
  return (
    <span className={['ml-auto font-mono text-[11px]', over ? 'text-coral' : 'text-inkMute'].join(' ')}>
      {value.length}/{max}
    </span>
  );
}

export function SectionHeader({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="font-display font-semibold text-[18px] text-ink">{title}</h3>
        {hint && <p className="mt-0.5 font-body font-bold text-[12px] text-inkSoft">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** Two-field {a,b} card list — how-it-works {label,body}, house rules
 *  {heading,body}, FAQ / sample Q&A {q,a}. `aKey`/`bKey` name the object
 *  properties so the SAME component backs every shape above. */
/** Not generic over the item shape on purpose: `HowItWorksStep`, `HouseRule`
 *  and `Qa` are all plain `{stringKey: string; stringKey: string}` closed
 *  interfaces with no index signature, and TS won't treat a closed interface
 *  as assignable to/from a generic `Record<string,string>` in both directions
 *  at once. Callers cast at the boundary (see steps.tsx) — a few `as` casts
 *  at 4 call sites is simpler than fighting the type system over a component
 *  that is, at runtime, genuinely shape-agnostic. */
export function TwoFieldListEditor({
  items, onChange, aKey, bKey, aLabel, bLabel, aMax, bMax, aPlaceholder, bPlaceholder, min, max, addLabel, itemNoun,
}: {
  items: Record<string, string>[];
  onChange: (next: Record<string, string>[]) => void;
  aKey: string; bKey: string;
  aLabel: string; bLabel: string;
  aMax: number; bMax: number;
  aPlaceholder?: string; bPlaceholder?: string;
  min: number; max: number;
  addLabel: string; itemNoun: string;
}) {
  function update(i: number, key: string, value: string) {
    const next = items.slice();
    next[i] = { ...next[i], [key]: value };
    onChange(next);
  }
  function remove(i: number) { onChange(items.filter((_, idx) => idx !== i)); }
  function add() { onChange([...items, { [aKey]: '', [bKey]: '' }]); }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-zine border-zine border-ink bg-card p-3 shadow-zine-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono font-bold uppercase text-[11px] tracking-[0.08em] text-inkSoft">{itemNoun} {i + 1}</span>
            <button type="button" onClick={() => remove(i)} className="font-body font-bold text-[12px] text-coral">Remove</button>
          </div>
          <label className="mb-2 block">
            <span className={labelCls}>{aLabel}</span>
            <input className={inputCls} value={String(item[aKey] ?? '')} maxLength={aMax} placeholder={aPlaceholder}
              onChange={(e) => update(i, aKey, e.target.value)} />
            <div className="mt-1 flex">{charCount(String(item[aKey] ?? ''), aMax)}</div>
          </label>
          <label className="block">
            <span className={labelCls}>{bLabel}</span>
            <textarea className={textareaCls} rows={2} value={String(item[bKey] ?? '')} maxLength={bMax} placeholder={bPlaceholder}
              onChange={(e) => update(i, bKey, e.target.value)} />
            <div className="mt-1 flex">{charCount(String(item[bKey] ?? ''), bMax)}</div>
          </label>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={add}
          className="rounded-zine border-zine border-dashed border-ink bg-card px-3 py-2.5 font-body font-bold text-[13px] text-inkSoft">
          + {addLabel}
        </button>
      )}
      <p className="font-body font-bold text-[11px] text-inkMute">{items.length}/{max} · minimum {min}</p>
    </div>
  );
}

/** Plain string list — what-you-get, who-for, not-for, can-do, cant-do. */
export function StringListEditor({
  items, onChange, itemMax, min, max, placeholder, addLabel,
}: {
  items: string[]; onChange: (next: string[]) => void;
  itemMax: number; min: number; max: number; placeholder?: string; addLabel: string;
}) {
  function update(i: number, value: string) {
    const next = items.slice(); next[i] = value; onChange(next);
  }
  function remove(i: number) { onChange(items.filter((_, idx) => idx !== i)); }
  function add() { onChange([...items, '']); }
  return (
    <div className="flex flex-col gap-2">
      {items.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className={inputCls} value={v} maxLength={itemMax} placeholder={placeholder}
            onChange={(e) => update(i, e.target.value)} />
          <button type="button" onClick={() => remove(i)} className="font-body font-bold text-[12px] text-coral">✕</button>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={add}
          className="rounded-zine border-zine border-dashed border-ink bg-card px-3 py-2 font-body font-bold text-[13px] text-inkSoft">
          + {addLabel}
        </button>
      )}
      <p className="font-body font-bold text-[11px] text-inkMute">{items.length}/{max}{min ? ` · minimum ${min}` : ''}</p>
    </div>
  );
}

/** {who, line} sample-chat editor for AI listings. */
export function ChatLineEditor({ items, onChange, max }: { items: { who: string; line: string }[]; onChange: (next: { who: string; line: string }[]) => void; max: number }) {
  function update(i: number, key: 'who' | 'line', value: string) {
    const next = items.slice(); next[i] = { ...next[i], [key]: value }; onChange(next);
  }
  function remove(i: number) { onChange(items.filter((_, idx) => idx !== i)); }
  function add() { onChange([...items, { who: items.length % 2 === 0 ? 'You' : 'AI Bestie', line: '' }]); }
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className={`${inputCls} w-28 flex-none`} value={item.who} maxLength={40} placeholder="Who"
            onChange={(e) => update(i, 'who', e.target.value)} />
          <input className={inputCls} value={item.line} maxLength={300} placeholder="Line"
            onChange={(e) => update(i, 'line', e.target.value)} />
          <button type="button" onClick={() => remove(i)} className="font-body font-bold text-[12px] text-coral">✕</button>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={add}
          className="rounded-zine border-zine border-dashed border-ink bg-card px-3 py-2 font-body font-bold text-[13px] text-inkSoft">
          + Add line
        </button>
      )}
      <p className="font-body font-bold text-[11px] text-inkMute">{items.length}/{max}</p>
    </div>
  );
}

export { labelCls, inputCls, textareaCls };
