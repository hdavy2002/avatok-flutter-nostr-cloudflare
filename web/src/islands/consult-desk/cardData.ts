/* [AUMFE-CONSULT-F3-1 2026-10-02] Pure helpers for the prepared-file cards: reading values out of API payloads whose exact
 * shape we do not control (AstrologyAPI et al.), editing any leaf, and shaping data for the visual components.
 * Everything here is defensive: an unknown shape degrades to a generic key/value list, never a crash. */
import type { FileCard } from '../../lib/consultTypes';

export type J = unknown;
export type Path = (string | number)[];
export const isObj = (v: J): v is Record<string, J> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isPrim = (v: J): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** The value the consultant sees: their edit when there is one, else what the API returned. */
export function effective(c: FileCard | undefined): J {
  if (!c) return undefined;
  return c.override !== null && c.override !== undefined ? c.override : c.api;
}
export const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
export const same = (a: J, b: J): boolean => JSON.stringify(a) === JSON.stringify(b);

export function humanize(k: string | number): string {
  const s = String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(k);
}

export function getAt(root: J, path: Path): J {
  let cur: J = root;
  for (const p of path) {
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (isObj(cur)) cur = cur[String(p)];
    else return undefined;
  }
  return cur;
}
/** Immutable set; creates containers as needed. */
export function setAt(root: J, path: Path, value: J): J {
  if (path.length === 0) return value;
  const [h, ...rest] = path;
  if (Array.isArray(root)) { const a = root.slice(); a[Number(h)] = setAt(a[Number(h)], rest, value); return a; }
  const o: Record<string, J> = isObj(root) ? { ...root } : {};
  o[String(h)] = setAt(o[String(h)], rest, value);
  return o;
}

export interface Leaf { path: Path; value: string | number | boolean | null | (string | number | boolean | null)[] }
/** Flattens a payload to editable leaves (primitives, and arrays of primitives as one comma list). */
export function leaves(v: J, limit = 80): Leaf[] {
  const out: Leaf[] = [];
  const walk = (x: J, path: Path) => {
    if (out.length >= limit) return;
    if (isPrim(x)) { out.push({ path, value: x }); return; }
    if (Array.isArray(x)) {
      if (x.every(isPrim)) { out.push({ path, value: x as (string | number | boolean | null)[] }); return; }
      x.forEach((y, i) => walk(y, [...path, i]));
      return;
    }
    if (isObj(x)) for (const [k, y] of Object.entries(x)) { if (!k.startsWith('_')) walk(y, [...path, k]); }
  };
  walk(v, []);
  return out;
}

export function leafText(v: Leaf['value'] | undefined): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
/** Turns the edited text back into the type the leaf had. */
export function parseLike(orig: Leaf['value'] | undefined, text: string): Leaf['value'] {
  const t = text.trim();
  if (Array.isArray(orig)) return t === '' ? [] : t.split(',').map((x) => { const s = x.trim(); return typeof orig[0] === 'number' && s !== '' && Number.isFinite(Number(s)) ? Number(s) : s; });
  if (typeof orig === 'number') return t !== '' && Number.isFinite(Number(t)) ? Number(t) : t;
  if (typeof orig === 'boolean') return /^(y|yes|true|1|present)/i.test(t);
  return t;
}
export function leafLabel(path: Path): string {
  if (path.length === 0) return 'Value';
  const last = path[path.length - 1];
  const prev = path[path.length - 2];
  const l = typeof last === 'number' ? `Item ${last + 1}` : humanize(last);
  if (path.length === 1) return l;
  if (typeof prev === 'number') return `${humanize(path[path.length - 3] ?? 'Item')} ${prev + 1} · ${l}`;
  return `${humanize(prev)} · ${l}`;
}

/** First string found under any of `keys` (case-insensitive) anywhere in v. */
export function findKey(v: J, keys: string[], depth = 4): J {
  if (depth < 0) return undefined;
  const want = keys.map((k) => k.toLowerCase());
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) if (want.includes(k.toLowerCase()) && x !== undefined && x !== null && x !== '') return x;
    for (const x of Object.values(v)) { const r = findKey(x, keys, depth - 1); if (r !== undefined) return r; }
  } else if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) { const r = findKey(x, keys, depth - 1); if (r !== undefined) return r; }
  }
  return undefined;
}
export const str = (v: J): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** Text of a reading: a string, or {text|prediction|description|reading}, or an array of those. */
export function textOf(v: J): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n\n');
  if (isObj(v)) {
    const t = findKey(v, ['text', 'prediction', 'description', 'reading', 'result', 'desc', 'predictions', 'content'], 2);
    if (t !== undefined) return textOf(t);
  }
  return typeof v === 'number' ? String(v) : '';
}

/* ───────── astrology: chart ───────── */

export const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const ABBR: Record<string, string> = { sun: 'Su', moon: 'Mo', mars: 'Ma', mercury: 'Me', jupiter: 'Ju', venus: 'Ve', saturn: 'Sa', rahu: 'Ra', ketu: 'Ke', uranus: 'Ur', neptune: 'Ne', pluto: 'Pl', ascendant: 'Asc', lagna: 'Asc', asc: 'Asc' };
export const PLANET_ABBR = ['Su', 'Mo', 'Ma', 'Me', 'Ju', 'Ve', 'Sa', 'Ra', 'Ke'];
export function abbr(name: string): string {
  const k = name.trim().toLowerCase();
  if (ABBR[k]) return ABBR[k];
  const two = name.trim().slice(0, 2);
  return two ? two[0].toUpperCase() + two.slice(1).toLowerCase() : '';
}
function signNo(v: J): number | null {
  if (typeof v === 'number' && v >= 1 && v <= 12) return Math.round(v);
  if (typeof v === 'string') {
    const i = SIGNS.findIndex((s) => s.toLowerCase() === v.trim().toLowerCase() || s.slice(0, 3).toLowerCase() === v.trim().toLowerCase().slice(0, 3));
    if (i >= 0) return i + 1;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 12) return Math.round(n);
  }
  return null;
}
export interface ChartData { asc: number; houses: string[][] }
const emptyHouses = (): string[][] => Array.from({ length: 12 }, () => []);

/** Normalises the shapes we expect: {asc,houses}, AstrologyAPI horo_chart (12 entries with planet_small), or a planets list. */
export function chartFrom(v: J, fallbackPlanets?: J): ChartData | null {
  const fromPlanets = (list: J, ascHint: number | null): ChartData | null => {
    if (!Array.isArray(list)) return null;
    const rows = list.filter(isObj);
    if (!rows.length) return null;
    let asc = ascHint;
    const ascRow = rows.find((r) => /^(asc|ascendant|lagna)/i.test(str(r.name ?? r.planet)));
    if (asc === null && ascRow) asc = signNo(ascRow.sign ?? ascRow.sign_name ?? ascRow.rashi);
    const houses = emptyHouses();
    let used = 0;
    for (const r of rows) {
      const nm = str(r.name ?? r.planet ?? r.planet_name);
      if (!nm) continue;
      const a = abbr(nm);
      let h = typeof r.house === 'number' ? r.house : Number(r.house ?? r.house_id ?? r.house_no);
      if (!Number.isFinite(h) || h < 1 || h > 12) {
        const sg = signNo(r.sign ?? r.sign_name ?? r.rashi ?? r.sign_id);
        if (sg === null || asc === null) continue;
        h = ((sg - asc + 12) % 12) + 1;
      }
      if (a === 'Asc') continue;
      houses[h - 1].push(a); used++;
    }
    if (!used) return null;
    return { asc: asc ?? 1, houses };
  };
  if (isObj(v) && Array.isArray(v.houses)) {
    const hs = (v.houses as J[]).slice(0, 12).map((h) => (Array.isArray(h) ? h.map(String) : typeof h === 'string' && h ? h.split(/[ ,]+/) : []));
    while (hs.length < 12) hs.push([]);
    return { asc: signNo(v.asc ?? v.asc_sign ?? v.ascendant) ?? 1, houses: hs };
  }
  if (Array.isArray(v) && v.length === 12 && v.every((x) => isObj(x) && ('planet_small' in x || 'planet' in x))) {
    const arr = v as Record<string, J>[];
    const houses = arr.map((h) => {
      const l = (h.planet_small ?? h.planet) as J;
      return Array.isArray(l) ? l.map((x) => abbr(String(x))).filter(Boolean) : [];
    });
    return { asc: signNo(arr[0].sign ?? arr[0].sign_name) ?? 1, houses };
  }
  const list = Array.isArray(v) ? v : isObj(v) ? (v.planets ?? v.planet_positions ?? v.data) : undefined;
  const ascHint = isObj(v) ? signNo(v.asc ?? v.asc_sign ?? v.ascendant ?? v.lagna ?? v.ascendant_sign) : null;
  const c = fromPlanets(list, ascHint);
  if (c) return c;
  if (isObj(v) && isObj(v.planets)) { // { Sun: 5, Moon: 3 } house numbers
    const houses = emptyHouses(); let n = 0;
    for (const [k, h] of Object.entries(v.planets)) { const hn = Number(h); if (hn >= 1 && hn <= 12) { houses[hn - 1].push(abbr(k)); n++; } }
    if (n) return { asc: ascHint ?? 1, houses };
  }
  return fallbackPlanets !== undefined ? fromPlanets(Array.isArray(fallbackPlanets) ? fallbackPlanets : isObj(fallbackPlanets) ? fallbackPlanets.planets : undefined, ascHint) : null;
}

/** Text anchor spots for the 12 houses of a North-Indian chart in a 300x300 box (house 1 = top diamond, anticlockwise). */
export const NORTH_SPOTS: { nx: number; ny: number; px: number; py: number; corner: boolean }[] = [
  { nx: 150, ny: 80, px: 150, py: 98, corner: false },
  { nx: 76, ny: 42, px: 76, py: 60, corner: false },
  { nx: 38, ny: 80, px: 38, py: 98, corner: true },
  { nx: 76, ny: 150, px: 76, py: 168, corner: false },
  { nx: 38, ny: 226, px: 38, py: 244, corner: true },
  { nx: 76, ny: 262, px: 76, py: 244, corner: false },
  { nx: 150, ny: 214, px: 150, py: 232, corner: false },
  { nx: 224, ny: 262, px: 224, py: 244, corner: false },
  { nx: 262, ny: 226, px: 262, py: 244, corner: true },
  { nx: 224, ny: 150, px: 224, py: 168, corner: false },
  { nx: 262, ny: 80, px: 262, py: 98, corner: true },
  { nx: 224, ny: 42, px: 224, py: 60, corner: false },
];

/* ───────── astrology: dasha ───────── */

export interface DashaItem { planet: string; start: number; end: number; path: Path }
export function parseDate(s: J): number | null {
  if (typeof s === 'number') return s > 1e11 ? s : null;
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
export function dashaItems(v: J): DashaItem[] {
  const find = (x: J, path: Path, depth: number): DashaItem[] | null => {
    if (depth < 0) return null;
    if (Array.isArray(x) && x.length >= 3 && x.every(isObj)) {
      const items: DashaItem[] = [];
      x.forEach((r, i) => {
        const rec = r as Record<string, J>;
        const pl = str(rec.planet ?? rec.name ?? rec.lord);
        const a = parseDate(rec.start ?? rec.start_date ?? rec.from); const b = parseDate(rec.end ?? rec.end_date ?? rec.to);
        if (pl && a !== null && b !== null && b > a) items.push({ planet: pl, start: a, end: b, path: [...path, i] });
      });
      if (items.length >= 3) return items;
    }
    if (isObj(x)) for (const [k, y] of Object.entries(x)) { const r = find(y, [...path, k], depth - 1); if (r) return r; }
    return null;
  };
  return find(v, [], 3) ?? [];
}

/* ───────── numerology ───────── */

export const DEVA_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
export const deva = (n: number): string => String(n).split('').map((d) => DEVA_DIGITS[Number(d)] ?? d).join('');
/** Lo Shu layout, top row first. */
export const LO_SHU = [[4, 9, 2], [3, 5, 7], [8, 1, 6]];
export function loShuCounts(v: J, dob?: string | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 1; i <= 9; i++) out[i] = 0;
  const raw = isObj(v) ? (v.counts ?? v.grid ?? v.lo_shu) : v;
  if (isObj(raw) && !Array.isArray(raw)) {
    let any = false;
    for (let i = 1; i <= 9; i++) { const c = Number(raw[String(i)]); if (Number.isFinite(c)) { out[i] = Math.max(0, Math.round(c)); any = true; } }
    if (any) return out;
  }
  if (Array.isArray(raw) && raw.length === 3 && raw.every((r) => Array.isArray(r) && r.length === 3)) {
    LO_SHU.forEach((row, ri) => row.forEach((n, ci) => {
      const cell = (raw as J[][])[ri][ci];
      const digits = String(cell ?? '').replace(/[^1-9]/g, '');
      out[n] = digits.length;
    }));
    return out;
  }
  for (const ch of (dob ?? '').replace(/-/g, '')) { const d = Number(ch); if (d >= 1 && d <= 9) out[d] += 1; }
  return out;
}

/* ───────── generic ───────── */

export function loadingNote(c: FileCard | undefined): string {
  if (!c) return 'This card was not prepared.';
  return c.note ?? (c.status === 'error' ? 'The service returned an error for this card.' : 'The service did not return this card.');
}
