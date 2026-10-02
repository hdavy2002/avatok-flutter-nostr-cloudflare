/* [AUMFE-CONSULT-F3-1 2026-10-02] File card renderers, part 1: astrology + numerology.
 * Astrology: birth details (+ re-run with edited time), North-Indian kundli (inline SVG, D1/D9), planets table, dasha bar, dosha tiles,
 * remedies chips. Numerology: core number tiles, Lo Shu 3x3 with Devanagari numerals + missing numbers, names, lucky, reports.
 * Shapes are read defensively (see cardData.ts); anything not recognised falls back to the generic editable key/value list. */
import { useState } from 'react';
import { chartFrom, clone, dashaItems, deva, effective, findKey, humanize, isObj, LO_SHU, loadingNote, loShuCounts, NORTH_SPOTS, PLANET_ABBR, same, str, textOf } from './cardData';
import type { ChartData, J } from './cardData';
import { ArrayTable, Badge, InlineEdit, Kv, ManualEntry, Section, TextBlock, useFile } from './cardUi';

/* ───────── astrology ───────── */

export function BirthDetails() {
  const { cards, file, rerun } = useFile();
  const cur = effective(cards.birth_details);
  const intakeTob = file.intake.kind === 'astrology' ? file.intake.birth.tob : null;
  const found = str(findKey(cur, ['tob', 'time', 'birth_time', 'time_of_birth']));
  const tob = (/^\d{1,2}:\d{2}/.test(found) ? found : intakeTob ?? '').slice(0, 5).padStart(5, '0');
  const [open, setOpen] = useState(false);
  const [t, setT] = useState(tob);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section cardKey="birth_details" title="Birth details" hint="tap any value to edit">
      <Kv cardKey="birth_details" />
      {open ? (
        <div className="cd-row" style={{ flexWrap: 'wrap' }}>
          <label className="label" htmlFor="rerun-tob">Birth time</label>
          <input id="rerun-tob" className="cd-in" type="time" value={t} onChange={(e) => setT(e.target.value)} style={{ maxWidth: 160 }} />
          <button type="button" className="btn small" disabled={busy || !t} onClick={async () => { setBusy(true); const ok = await rerun(t); setBusy(false); if (ok) { setOpen(false); setMsg('Chart re-run with the new time.'); } }}>{busy ? 'Running…' : 'Run'}</button>
          <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : <button type="button" className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Re-run chart with edited time</button>}
      {msg ? <span className="hint" role="status">{msg}</span> : null}
    </Section>
  );
}

function NorthChart({ data, label }: { data: ChartData; label: string }) {
  return (
    <svg width="300" height="300" viewBox="0 0 300 300" role="img" aria-label={label} style={{ fontFamily: "'Nunito', sans-serif", maxWidth: '100%', height: 'auto' }}>
      <rect x="4" y="4" width="292" height="292" fill="#fffdf6" stroke="#07545b" strokeWidth="2" />
      <path d="M4 4 296 296M296 4 4 296M150 4 296 150 150 296 4 150Z" fill="none" stroke="#07545b" strokeWidth="1.5" />
      {NORTH_SPOTS.map((s, i) => {
        const sign = ((data.asc - 1 + i) % 12) + 1;
        const pl = data.houses[i] ?? [];
        const lines: string[] = [];
        const per = s.corner ? 1 : 2;
        for (let k = 0; k < pl.length; k += per) lines.push(pl.slice(k, k + per).join(' '));
        const up = s.py < s.ny; // bottom houses draw planets above the number
        return (
          <g key={i}>
            <text x={s.nx} y={s.ny} textAnchor="middle" fontSize={i === 0 ? 14 : 13} fontWeight={i === 0 ? 800 : 400} fill={i === 0 ? '#c82c25' : '#4d6268'}>{i === 0 ? `${sign} Asc` : sign}</text>
            {lines.map((ln, k) => <text key={k} x={s.px} y={up ? s.py - k * 15 : s.py + k * 15} textAnchor="middle" fontSize="14" fill="#17343c">{ln}</text>)}
          </g>
        );
      })}
    </svg>
  );
}

export function ChartCard() {
  const { cards, save } = useFile();
  const [which, setWhich] = useState<'chart_d1' | 'chart_d9'>('chart_d1');
  const [pl, setPl] = useState('');
  const [house, setHouse] = useState(1);
  const card = cards[which];
  const data = chartFrom(effective(card), which === 'chart_d1' ? effective(cards.planets) : undefined);
  const edited = !!card && card.override !== null && card.override !== undefined;
  const present = data ? Array.from(new Set(data.houses.flat())) : [];
  const move = async () => {
    if (!data || !pl) return;
    const houses = data.houses.map((h) => h.filter((x) => x !== pl));
    houses[house - 1] = [...houses[house - 1], pl];
    await save(which, { asc: data.asc, houses });
  };
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3>{which === 'chart_d1' ? 'Lagna chart (D1)' : 'Navamsa chart (D9)'}{edited && card ? <Badge card={card} /> : null}</h3>
        <div style={{ display: 'flex', gap: 6 }} role="tablist" aria-label="Which chart">
          {(['chart_d1', 'chart_d9'] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={which === k} className={`slot${which === k ? ' on' : ''}`} style={{ padding: '0 12px', minHeight: 40 }} onClick={() => setWhich(k)}>{k === 'chart_d1' ? 'D1' : 'D9'}</button>)}
        </div>
      </div>
      {data ? (
        <>
          <NorthChart data={data} label={`North Indian ${which === 'chart_d1' ? 'lagna' : 'navamsa'} chart`} />
          <div className="cd-row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
            <select className="cd-in" aria-label="Planet to move" style={{ width: 'auto' }} value={pl} onChange={(e) => setPl(e.target.value)}>
              <option value="">Move a planet…</option>
              {present.sort((a, b) => PLANET_ABBR.indexOf(a) - PLANET_ABBR.indexOf(b)).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select className="cd-in" aria-label="To house" style={{ width: 'auto' }} value={house} onChange={(e) => setHouse(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>House {i + 1}</option>)}
            </select>
            <button type="button" className="btn small ghost" disabled={!pl} onClick={() => void move()}>Move</button>
            {edited ? <button type="button" className="edit" onClick={() => void save(which, null)}>Undo all edits</button> : null}
          </div>
          <span className="hint">Numbers are signs (1 Aries … 12 Pisces) · pick a planet to move it to another house</span>
        </>
      ) : (
        <div style={{ width: '100%' }}><ManualEntry cardKey={which} note={`${loadingNote(card)} The planets table below still has the positions.`} /></div>
      )}
    </section>
  );
}

const PLANET_COLS = ['name', 'planet', 'sign', 'house', 'normDegree', 'fullDegree', 'degree', 'nakshatra', 'nakshatraPad', 'isRetro'];
export function PlanetsCard() {
  const { cards } = useFile();
  const cur = effective(cards.planets);
  const arr = Array.isArray(cur) ? cur : isObj(cur) && Array.isArray(cur.planets) ? cur.planets : null;
  const path = Array.isArray(cur) ? [] : ['planets'];
  const first = arr && isObj(arr[0]) ? Object.keys(arr[0] as object) : [];
  const cols = PLANET_COLS.filter((c) => first.includes(c)).slice(0, 6);
  return (
    <Section cardKey="planets" title="Planets">
      {arr && cols.length ? <ArrayTable cardKey="planets" path={path} columns={cols} /> : <Kv cardKey="planets" />}
    </Section>
  );
}

const DASHA_FILL = ['#9aa9ad', '#c9b27a'];
export function DashaCard() {
  const { cards } = useFile();
  const cur = effective(cards.dasha);
  const items = dashaItems(cur);
  const now = Date.now();
  let idx = items.findIndex((i) => i.start <= now && now < i.end);
  if (idx < 0 && items.length) idx = items.findIndex((i) => i.start > now) - 1;
  const show = items.length ? items.slice(Math.max(0, idx - 1), Math.max(0, idx) + 2) : [];
  const yr = (ms: number) => new Date(ms).getUTCFullYear();
  const itemsPath = items[0] ? items[0].path.slice(0, -1) : [];
  return (
    <Section cardKey="dasha" title="Vimshottari dasha">
      {show.length ? (
        <div className="cd-bar" role="img" aria-label={`Dasha periods: ${show.map((s) => `${s.planet} ${yr(s.start)} to ${yr(s.end)}`).join(', ')}`}>
          {show.map((s, i) => {
            const cur2 = s.start <= now && now < s.end;
            return <span key={`${s.planet}${s.start}`} style={{ flex: Math.max(1, Math.round((s.end - s.start) / 3.15e10)), background: cur2 ? '#07545b' : DASHA_FILL[i % 2], color: !cur2 && i % 2 === 1 ? '#17343c' : '#fff' }}>{s.planet}{cur2 ? ' (now)' : ''}</span>;
          })}
        </div>
      ) : null}
      <Kv cardKey="dasha" filter={(l) => !items.some((it) => l.path.length >= itemsPath.length + 1 && same(l.path.slice(0, itemsPath.length), itemsPath) && l.path[itemsPath.length] === it.path[it.path.length - 1])} />
      {items.length ? (
        <details>
          <summary style={{ fontWeight: 800, cursor: 'pointer', minHeight: 36, display: 'flex', alignItems: 'center' }}>All periods ({items.length}) · tap to edit</summary>
          <ArrayTable cardKey="dasha" path={itemsPath} columns={['planet', 'start', 'end']} />
        </details>
      ) : null}
    </Section>
  );
}

const DOSHAS = [
  { re: /mangl/i, title: 'Manglik' },
  { re: /kal.?sarp|kaal/i, title: 'Kaal Sarp' },
  { re: /sade|sadhe/i, title: 'Sade Sati' },
  { re: /pitra|pitri|pitr/i, title: 'Pitra' },
];
function tone(sub: J): { bg: string; line: string; text: string } {
  const flag = findKey(sub, ['is_present', 'is_dosha_present', 'present', 'is_manglik', 'manglik_present', 'is_pitri_dosha_present', 'is_undergoing_sadhesati', 'is_kalsarpa_present', 'status', 'sadhesati_status'], 2);
  const s = (typeof flag === 'string' ? flag : flag === true ? 'present' : flag === false ? 'no' : '').toLowerCase();
  const textual = isObj(sub) ? str(findKey(sub, ['summary', 'description', 'one_line', 'report', 'text'], 1)).toLowerCase() : str(sub).toLowerCase();
  if (/partial|mild|low/.test(s) || /partial/.test(textual)) return { bg: '#f6e7c4', line: '#e8cf96', text: 'Partial' };
  if (s === 'present' || s === 'yes' || s === 'true' || /^(present|running|active)/.test(s) || (s === '' && /\bpresent\b|is undergoing|running/.test(textual) && !/not present|not running|absent/.test(textual))) return { bg: '#fbe1dc', line: '#f0b8ae', text: 'Present' };
  return { bg: '#f6ead0', line: '#e2cf9f', text: s ? 'Not present' : '' };
}
export function DoshaCard() {
  const { cards, save } = useFile();
  const card = cards.doshas;
  const cur = effective(card);
  const [edit, setEdit] = useState<string | null>(null);
  const tiles = isObj(cur) ? Object.entries(cur).map(([k, v]) => ({ k, v, d: DOSHAS.find((x) => x.re.test(k)) })).filter((x) => x.d) : [];
  return (
    <Section cardKey="doshas" title="Doshas">
      {tiles.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          {tiles.map(({ k, v, d }) => {
            const t = tone(v);
            const custom = isObj(v) ? str(v._summary) : '';
            const desc = custom || textOf(isObj(v) ? findKey(v, ['summary', 'description', 'one_line', 'report', 'text'], 1) ?? '' : v);
            const shown = desc ? (desc.length > 120 ? `${desc.slice(0, 117)}…` : desc) : t.text || 'No details returned';
            return (
              <div key={k} className="cd-dosha" style={{ background: t.bg, borderColor: t.line }}>
                <strong>{d?.title}</strong>
                {edit === k ? (
                  <InlineEdit label={`Edit ${d?.title}`} initial={custom || shown} onCancel={() => setEdit(null)}
                    onSave={async (txt) => { const next = clone(cur) as Record<string, J>; next[k] = isObj(v) ? { ...v, _summary: txt } : txt; if (await save('doshas', next)) setEdit(null); }} />
                ) : (
                  <>
                    <span style={{ fontSize: 15 }}>{shown}{custom && card ? <Badge card={card} /> : null}</span>
                    <button type="button" className="edit" style={{ alignSelf: 'flex-start' }} aria-label={`Edit ${d?.title}`} onClick={() => setEdit(k)}>Edit</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : <Kv cardKey="doshas" />}
    </Section>
  );
}

export function RemediesCard() {
  const { cards, save } = useFile();
  const cur = effective(cards.remedies);
  const [edit, setEdit] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const nameOf = (v: J): string => str(isObj(v) ? findKey(v, ['name', 'gem_name', 'rudraksha_name', 'puja_name', 'title', 'suggestion', 'stone', 'mukhi'], 2) : v) || textOf(v).slice(0, 60);
  const entries: { k: string; label: string; text: string }[] = isObj(cur)
    ? Object.entries(cur).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '').map(([k, v]) => ({ k, label: humanize(k.replace(/_?suggestion/i, '').replace(/^custom.*/i, '') || 'Note'), text: nameOf(v) }))
    : [];
  const write = async (next: Record<string, J>) => save('remedies', next);
  return (
    <Section cardKey="remedies" title={<>Suggested by the API <span className="muted" style={{ fontFamily: "'Nunito', sans-serif", fontSize: 15, fontWeight: 700 }}>(edit or remove before you say it)</span></> }>
      {isObj(cur) ? (
        <div className="cd-chips">
          {entries.map((e) => edit === e.k ? (
            <div key={e.k} style={{ width: '100%' }}>
              <InlineEdit label={`Edit ${e.label}`} initial={e.text} onCancel={() => setEdit(null)} onSave={async (t) => { if (await write({ ...(cur as Record<string, J>), [e.k]: t })) setEdit(null); }} />
            </div>
          ) : (
            <span key={e.k} className="chip gold">
              {e.label ? `${e.label}: ` : ''}{e.text}
              <button type="button" className="edit" aria-label={`Edit ${e.label} ${e.text}`} onClick={() => setEdit(e.k)}>Edit</button>
              <button type="button" className="edit" aria-label={`Remove ${e.label} ${e.text}`} onClick={() => { const n = { ...(cur as Record<string, J>) }; delete n[e.k]; void write(n); }}>✕</button>
            </span>
          ))}
          {adding ? (
            <div style={{ width: '100%' }}><InlineEdit label="Add a remedy" initial="" onCancel={() => setAdding(false)} onSave={async (t) => { if (!t.trim()) return; if (await write({ ...(cur as Record<string, J>), [`custom_${Date.now().toString(36)}`]: t.trim() })) setAdding(false); }} /></div>
          ) : <button type="button" className="edit" onClick={() => setAdding(true)}>+ Add</button>}
        </div>
      ) : <Kv cardKey="remedies" />}
    </Section>
  );
}

/* ───────── numerology ───────── */

export function CoreNumbers() {
  const { cards, save } = useFile();
  const card = cards.core_numbers;
  const cur = effective(card);
  const [edit, setEdit] = useState<string | null>(null);
  const tiles = isObj(cur) ? Object.entries(cur).filter(([, v]) => (typeof v === 'number' || (typeof v === 'string' && v.length <= 3 && v !== ''))) : [];
  return (
    <Section cardKey="core_numbers" title="Core numbers" hint="tap a number to change it">
      {tiles.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, textAlign: 'center' }}>
          {tiles.map(([k, v]) => {
            const apiV = isObj(card?.api) ? (card.api as Record<string, J>)[k] : v;
            const edited = !!card && card.override !== null && card.override !== undefined && !same(apiV, v);
            return (
              <div key={k} className="card" style={{ padding: '12px 6px', background: '#fff', borderColor: edited ? '#e8cf96' : undefined }}>
                {edit === k ? (
                  <InlineEdit label={`Edit ${humanize(k)}`} initial={String(v)} onCancel={() => setEdit(null)}
                    onSave={async (t) => { const n = Number(t); if (await save('core_numbers', { ...(cur as Record<string, J>), [k]: t.trim() !== '' && Number.isFinite(n) ? n : t.trim() })) setEdit(null); }} />
                ) : (
                  <>
                    <button type="button" aria-label={`Edit ${humanize(k)}, now ${String(v)}`} onClick={() => setEdit(k)} style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, fontFamily: "'Comfortaa', sans-serif", fontWeight: 700, fontSize: 34, color: edited ? '#b07d12' : '#07545b', minHeight: 44, minWidth: 44 }}>{String(v)}</button>
                    <br /><span style={{ fontSize: 14, fontWeight: 800 }}>{humanize(k.replace(/_?number$/i, ''))}{edited && card ? <span className="edited" style={{ marginLeft: 4 }}>edited</span> : null}</span>
                    {edited ? <div><button type="button" className="edit" onClick={() => { const n = { ...(cur as Record<string, J>), [k]: apiV }; void save('core_numbers', same(n, card?.api) ? null : n); }}>Undo</button></div> : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      <Kv cardKey="core_numbers" filter={(l) => !(l.path.length === 1 && tiles.some(([k]) => k === l.path[0]))} />
    </Section>
  );
}

export function LoShuCard() {
  const { cards, file, save } = useFile();
  const card = cards.lo_shu;
  const cur = effective(card);
  const dob = file.intake.kind === 'numerology' ? file.intake.dob : null;
  const counts = loShuCounts(cur, dob);
  const [edit, setEdit] = useState<number | null>(null);
  const missing = Object.entries(counts).filter(([, c]) => c === 0).map(([n]) => Number(n));
  const hasOv = !!card && card.override !== null && card.override !== undefined;
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3>Lo Shu grid{hasOv && card ? <Badge card={card} /> : null}</h3>
        {hasOv ? <button type="button" className="edit" onClick={() => void save('lo_shu', null)}>Undo all edits</button> : <span className="hint">{card && card.status === 'ok' ? 'tap a box to change how many' : 'worked out from the date of birth'}</span>}
      </div>
      <div className="cd-lo" role="group" aria-label="Lo Shu grid">
        {LO_SHU.flat().map((n) => {
          const c = counts[n];
          return (
            <button key={n} type="button" className={c === 0 ? 'miss' : ''} aria-label={`Number ${n}, appears ${c} time${c === 1 ? '' : 's'}. Edit`} onClick={() => setEdit(n)}>
              <span className="deva">{c === 0 ? deva(n) : Array.from({ length: c }, () => deva(n)).join('')}</span>
              <span style={{ fontSize: 13, fontWeight: 800 }}>{c === 0 ? 'missing' : n}</span>
            </button>
          );
        })}
      </div>
      {edit !== null ? (
        <InlineEdit label={`How many times does ${edit} appear`} initial={String(counts[edit])} onCancel={() => setEdit(null)}
          onSave={async (t) => { const v = Math.max(0, Math.min(9, Math.round(Number(t)))); if (!Number.isFinite(v)) return; if (await save('lo_shu', { counts: { ...counts, [edit]: v } })) setEdit(null); }} />
      ) : null}
      <p style={{ fontSize: 15 }}><strong>Missing numbers:</strong> {missing.length ? <span className="deva" style={{ fontSize: 18 }}>{missing.map(deva).join(', ')}</span> : 'none'}</p>
    </section>
  );
}

export function TextCard({ cardKey, title }: { cardKey: string; title: string }) {
  const { cards } = useFile();
  const cur = effective(cards[cardKey]);
  const multi = isObj(cur) && Object.values(cur).some((v) => typeof v === 'string' && v.length > 60);
  return (
    <Section cardKey={cardKey} title={title}>
      {multi ? (
        <>{Object.entries(cur as Record<string, J>).filter(([, v]) => typeof v === 'string').map(([k]) => (
          <div key={k}><span className="label">{humanize(k)}</span><TextBlock cardKey={cardKey} path={[k]} /></div>
        ))}</>
      ) : <TextBlock cardKey={cardKey} path={[]} />}
    </Section>
  );
}

