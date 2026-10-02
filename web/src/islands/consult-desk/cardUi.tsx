/* [AUMFE-CONSULT-F3-1 2026-10-02] Building blocks for the prepared-file cards. EVERY value is editable:
 * Edit -> inline input -> PATCH /desk/bookings/:id/cards/:key {override}; an edited leaf shows "edited by <name> · was <api value>"
 * and Undo puts the API value back (override null when nothing differs any more). Missing cards say so and can be written by hand.
 * Unknown card keys render as readable JSON (JsonCard). */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { DeskFileDTO, FileCard } from '../../lib/consultTypes';
import { captureException } from '../../lib/analytics';
import { fetchDeskPhoto } from '../../lib/consultDeskApi';
import { effective, clone, getAt, humanize, leafLabel, leafText, leaves, loadingNote, parseLike, same, setAt, textOf } from './cardData';
import type { J, Leaf, Path } from './cardData';

export interface RevealCard { id: number; reversed: boolean; position: string }
export interface FileCtxValue {
  file: DeskFileDTO;
  cards: Record<string, FileCard>;
  save: (key: string, override: J | null) => Promise<boolean>;
  rerun: (tob: string) => Promise<boolean>;
  /** call is connected: Reveal is meaningful */
  connected: boolean;
  reveal: (c: RevealCard) => boolean;
  customerFirst: string;
}
export const FileCtx = createContext<FileCtxValue | null>(null);
export function useFile(): FileCtxValue {
  const v = useContext(FileCtx);
  if (!v) throw new Error('useFile outside FileCtx');
  return v;
}

const pathKey = (p: Path) => p.join('.');

export function Badge({ card, was }: { card: FileCard; was?: string }) {
  return <span className="edited">edited by {card.edited_by ?? 'you'}{was !== undefined ? ` · was ${was}` : ''}</span>;
}

/** Card chrome: heading, edited badge + "Undo all", and the "not available" state with manual entry. */
export function Section({ cardKey, title, hint, frame, right, children, style }: { cardKey?: string; title: ReactNode; hint?: ReactNode; frame?: boolean; right?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  const { cards, save } = useFile();
  const card = cardKey ? cards[cardKey] : undefined;
  const cur = effective(card);
  const missing = !!cardKey && (cur === undefined || cur === null || cur === '');
  const [busy, setBusy] = useState(false);
  return (
    <section className={`card${frame ? ' frame' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3>{title}{card && card.override !== null && card.override !== undefined ? <Badge card={card} /> : null}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hint ? <span className="hint">{hint}</span> : null}
          {right}
          {card && card.override !== null && card.override !== undefined ? (
            <button type="button" className="edit" disabled={busy} onClick={async () => { setBusy(true); await save(card.key, null); setBusy(false); }}>Undo all edits</button>
          ) : null}
        </div>
      </div>
      {missing && cardKey ? <ManualEntry cardKey={cardKey} note={loadingNote(card)} /> : children}
    </section>
  );
}

export function ManualEntry({ cardKey, note }: { cardKey: string; note: string }) {
  const { save } = useFile();
  const [open, setOpen] = useState(false);
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="muted" style={{ fontSize: 15 }}>Not available: {note}</p>
      {open ? (
        <>
          <textarea className="cd-ta" aria-label="Write this card yourself" value={t} onChange={(e) => setT(e.target.value)} />
          <div className="cd-row"><button type="button" className="btn small" disabled={busy || !t.trim()} onClick={async () => { setBusy(true); const ok = await save(cardKey, t.trim()); setBusy(false); if (ok) setOpen(false); }}>Save</button><button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button></div>
        </>
      ) : <button type="button" className="edit" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Write it yourself</button>}
    </div>
  );
}

/** A small inline editor: input + Save/Cancel. */
export function InlineEdit({ initial, onSave, onCancel, label, multiline }: { initial: string; onSave: (t: string) => Promise<void>; onCancel: () => void; label: string; multiline?: boolean }) {
  const [t, setT] = useState(initial);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onSave(t); } finally { setBusy(false); } };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: multiline ? 'stretch' : 'center', flexDirection: multiline ? 'column' : 'row', width: '100%' }}>
      {multiline
        ? <textarea className="cd-ta" aria-label={label} value={t} autoFocus onChange={(e) => setT(e.target.value)} />
        : <input className="cd-in" aria-label={label} value={t} autoFocus onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); if (e.key === 'Escape') onCancel(); }} />}
      <div className="cd-row"><button type="button" className="btn small" disabled={busy} onClick={() => void go()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

/** Editable key/value list for one card (optionally only some leaves). */
export function Kv({ cardKey, filter, labelOf }: { cardKey: string; filter?: (l: Leaf) => boolean; labelOf?: (l: Leaf) => string }) {
  const { cards, save } = useFile();
  const card = cards[cardKey];
  const cur = effective(card);
  const [editing, setEditing] = useState<string | null>(null);
  if (cur === undefined || cur === null) return null;
  let ls = leaves(cur);
  if (filter) ls = ls.filter(filter);
  if (!ls.length) return null;
  const hasOverride = !!card && card.override !== null && card.override !== undefined;
  const write = async (path: Path, orig: Leaf['value'], text: string) => {
    const next = setAt(clone(cur), path, parseLike(orig, text));
    if (await save(cardKey, next)) setEditing(null);
  };
  const undo = async (path: Path) => {
    const apiVal = getAt(card?.api, path);
    const next = setAt(clone(cur), path, apiVal);
    await save(cardKey, same(next, card?.api) ? null : next);
  };
  return (
    <div className="kv">
      {ls.map((l) => {
        const k = pathKey(l.path);
        const apiVal = hasOverride ? getAt(card.api, l.path) : l.value;
        const edited = hasOverride && !same(apiVal, l.value);
        return (
          <div key={k} className="cd-kv-row">
            <span className="k">{labelOf ? labelOf(l) : leafLabel(l.path)}</span>
            {editing === k ? (
              <div style={{ gridColumn: '2 / 4' }}>
                <InlineEdit label={`Edit ${leafLabel(l.path)}`} initial={Array.isArray(l.value) ? l.value.join(', ') : l.value === null ? '' : String(l.value)} onSave={(t) => write(l.path, l.value, t)} onCancel={() => setEditing(null)} />
              </div>
            ) : (
              <>
                <span className="v">{leafText(l.value)}{edited && card ? <Badge card={card} was={leafText(apiVal as Leaf['value'])} /> : null}</span>
                <span style={{ display: 'flex', gap: 2 }}>
                  <button type="button" className="edit" aria-label={`Edit ${leafLabel(l.path)}`} onClick={() => setEditing(k)}>Edit</button>
                  {edited && apiVal !== undefined ? <button type="button" className="edit" aria-label={`Undo ${leafLabel(l.path)}`} onClick={() => void undo(l.path)}>Undo</button> : null}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function KvCard({ cardKey, title, hint, frame }: { cardKey: string; title: string; hint?: ReactNode; frame?: boolean }) {
  return <Section cardKey={cardKey} title={title} hint={hint} frame={frame}><Kv cardKey={cardKey} /></Section>;
}

/** Reading text with tabs optional: edits the string at `path`. */
export function TextBlock({ cardKey, path, empty }: { cardKey: string; path: Path; empty?: string }) {
  const { cards, save } = useFile();
  const card = cards[cardKey];
  const cur = effective(card);
  const [open, setOpen] = useState(false);
  const text = textOf(getAt(cur, path));
  const apiText = card ? textOf(getAt(card.api, path)) : '';
  const edited = !!card && card.override !== null && card.override !== undefined && text !== apiText;
  const write = async (t: string) => { if (await save(cardKey, setAt(clone(cur ?? {}), path, t))) setOpen(false); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', width: '100%' }}>
      {open ? <InlineEdit multiline label="Edit reading" initial={text} onSave={write} onCancel={() => setOpen(false)} /> : (
        <>
          <p style={{ fontSize: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text || empty || 'No text for this one yet. Tap Edit reading to write it.'}{edited && card ? <Badge card={card} /> : null}</p>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" className="edit" onClick={() => setOpen(true)}>Edit reading</button>
            {edited ? <button type="button" className="edit" onClick={async () => { const next = setAt(clone(cur), path, getAt(card?.api, path)); await save(cardKey, same(next, card?.api) ? null : next); }}>Undo</button> : null}
          </div>
        </>
      )}
    </div>
  );
}

/** Table over an array of flat objects; every cell editable. */
export function ArrayTable({ cardKey, path = [], columns }: { cardKey: string; path?: Path; columns?: string[] }) {
  const { cards, save } = useFile();
  const card = cards[cardKey];
  const cur = effective(card);
  const rows = getAt(cur, path);
  const [editing, setEditing] = useState<string | null>(null);
  if (!Array.isArray(rows) || !rows.length) return null;
  const objs = rows as Record<string, J>[];
  const cols = columns ?? Object.keys(objs[0] ?? {}).filter((k) => !k.startsWith('_') && objs.some((r) => ['string', 'number', 'boolean'].includes(typeof r[k]))).slice(0, 6);
  const hasOv = !!card && card.override !== null && card.override !== undefined;
  return (
    <div className="cd-table-wrap">
      <table className="t">
        <thead><tr>{cols.map((c) => <th key={c}>{humanize(c)}</th>)}</tr></thead>
        <tbody>
          {objs.map((r, ri) => (
            <tr key={ri}>
              {cols.map((c) => {
                const p: Path = [...path, ri, c];
                const k = pathKey(p);
                const v = r[c];
                const orig = hasOv ? getAt(card.api, p) : v;
                const edited = hasOv && !same(orig, v);
                return (
                  <td key={c} style={edited ? { background: '#f6e7c4' } : undefined}>
                    {editing === k ? (
                      <InlineEdit label={`Edit ${humanize(c)}`} initial={v === null || v === undefined ? '' : String(v)} onCancel={() => setEditing(null)}
                        onSave={async (t) => { const lf = parseLike(v as Leaf['value'], t); if (await save(cardKey, setAt(clone(cur), p, lf))) setEditing(null); }} />
                    ) : (
                      <button type="button" className="edit" style={{ color: 'var(--ink)', textDecoration: 'none', fontWeight: 700, fontSize: 15, textAlign: 'left' }} aria-label={`Edit ${humanize(c)}, now ${leafText(v as Leaf['value'])}`} onClick={() => setEditing(k)}>
                        {leafText(v as Leaf['value'])}
                      </button>
                    )}
                    {edited && card ? <div><Badge card={card} was={leafText(orig as Leaf['value'])} /></div> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Unknown card key: readable JSON, editable as JSON. */
export function JsonCard({ card }: { card: FileCard }) {
  const { save } = useFile();
  const cur = effective(card);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Section cardKey={card.key} title={card.title || humanize(card.key)}>
      {open ? (
        <>
          <InlineEdit multiline label="Edit JSON" initial={JSON.stringify(cur, null, 2)} onCancel={() => { setOpen(false); setErr(null); }}
            onSave={async (t) => { try { const v = JSON.parse(t) as J; if (await save(card.key, v)) { setOpen(false); setErr(null); } } catch { setErr('That is not valid JSON.'); } }} />
          {err ? <p role="alert" style={{ color: '#9a1f19', fontWeight: 800 }}>{err}</p> : null}
        </>
      ) : (
        <>
          <pre className="cd-json">{JSON.stringify(cur, null, 2)}</pre>
          <button type="button" className="edit" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Edit</button>
        </>
      )}
    </Section>
  );
}

/** Private photo as a blob URL (the endpoint needs the bearer token). */
export function usePhoto(kind: string): { url: string | null; state: 'none' | 'loading' | 'ok' | 'error' } {
  const { file } = useFile();
  const src = file.photos.find((p) => p.kind === kind)?.url ?? null;
  const [r, setR] = useState<{ url: string | null; state: 'none' | 'loading' | 'ok' | 'error' }>({ url: null, state: src ? 'loading' : 'none' });
  useEffect(() => {
    if (!src) { setR({ url: null, state: 'none' }); return undefined; }
    let dead = false; let made: string | null = null;
    setR({ url: null, state: 'loading' });
    fetchDeskPhoto(src).then((u) => { if (dead) { URL.revokeObjectURL(u); return; } made = u; setR({ url: u, state: 'ok' }); })
      .catch((e) => { captureException(e, { where: 'consult_desk_photo', kind }); if (!dead) setR({ url: null, state: 'error' }); });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [src, kind]);
  return r;
}

export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="cd-tabs" role="tablist" aria-label={label}>
      {items.map((i) => <button key={i.id} type="button" role="tab" aria-selected={value === i.id} className={`slot${value === i.id ? ' on' : ''}`} onClick={() => onChange(i.id)}>{i.label}</button>)}
    </div>
  );
}
