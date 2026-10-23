/* [HF-CHANNEL-WEB-1 2026-10-23] The fan's Bag: many merch lines (from any influencers), paid once.
 * Stored in localStorage `hf_bag_v1` (try/catch everywhere: private windows and blocked storage fall back to memory for the tab).
 * The bag keeps display facts only; the server re-prices every line at checkout (POST /api/hf/merch/checkout { items }).
 * Limits mirror the worker: 1..10 lines, 1..3 of each. Changes are broadcast with a window event so the header badge,
 * the drawer and the bag page stay in step, and with the `storage` event so other tabs follow. */
export interface BagLine {
  productId: string; hostSlug: string; hostName: string; slug: string; title: string; imageUrl: string | null;
  colour: string; size: string; qty: number; unitPaise: number; category: string;
}
export const BAG_KEY = 'hf_bag_v1';
export const BAG_MAX_LINES = 10;
export const BAG_MAX_QTY = 3;
const CHANGE = 'hf-bag-change';
const OPEN = 'hf-bag-open';

let memory: string | null = null;
const isBrowser = typeof window !== 'undefined';

const lineKey = (l: Pick<BagLine, 'productId' | 'colour' | 'size'>) => `${l.productId}|${l.colour}|${l.size}`;
const validLine = (l: unknown): l is BagLine => {
  if (!l || typeof l !== 'object') return false;
  const o = l as Record<string, unknown>;
  return typeof o.productId === 'string' && typeof o.hostSlug === 'string' && typeof o.slug === 'string' && typeof o.title === 'string'
    && typeof o.colour === 'string' && typeof o.size === 'string' && Number.isFinite(o.qty) && Number.isFinite(o.unitPaise);
};

/** The raw stored string. useSyncExternalStore compares snapshots by identity, so the hook reads this and parses with parseBag. */
export function rawBag(): string {
  if (!isBrowser) return '[]';
  try { return localStorage.getItem(BAG_KEY) ?? memory ?? '[]'; } catch { return memory ?? '[]'; }
}
const parseCache = new Map<string, BagLine[]>();
export function parseBag(raw: string): BagLine[] {
  const hit = parseCache.get(raw);
  if (hit) return hit;
  let out: BagLine[] = [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) out = j.filter(validLine).slice(0, BAG_MAX_LINES).map(l => ({
      ...l, hostName: String(l.hostName ?? ''), imageUrl: typeof l.imageUrl === 'string' ? l.imageUrl : null, category: String(l.category ?? ''),
      qty: Math.min(BAG_MAX_QTY, Math.max(1, Math.trunc(l.qty))), unitPaise: Math.max(0, Math.round(l.unitPaise)),
    }));
  } catch { /* corrupt: start empty */ }
  if (parseCache.size > 20) parseCache.clear();
  parseCache.set(raw, out);
  return out;
}
export const readBag = (): BagLine[] => parseBag(rawBag());

function write(lines: BagLine[]): void {
  const raw = JSON.stringify(lines);
  memory = raw;
  try { localStorage.setItem(BAG_KEY, raw); } catch { /* memory copy still serves this tab */ }
  if (isBrowser) window.dispatchEvent(new Event(CHANGE));
}

export type AddResult = { ok: true; line: BagLine } | { ok: false; reason: 'full' };
/** Add one line; the same product + colour + size merges (quantity capped at 3). */
export function addToBag(line: BagLine): AddResult {
  const lines = [...readBag()];
  const i = lines.findIndex(l => lineKey(l) === lineKey(line));
  if (i >= 0) { lines[i] = { ...lines[i], qty: Math.min(BAG_MAX_QTY, lines[i].qty + line.qty), unitPaise: line.unitPaise }; write(lines); return { ok: true, line: lines[i] }; }
  if (lines.length >= BAG_MAX_LINES) return { ok: false, reason: 'full' };
  const fresh = { ...line, qty: Math.min(BAG_MAX_QTY, Math.max(1, Math.trunc(line.qty))) };
  lines.push(fresh); write(lines);
  return { ok: true, line: fresh };
}
export function setBagQty(key: string, qty: number): void {
  write(readBag().map(l => (lineKey(l) === key ? { ...l, qty: Math.min(BAG_MAX_QTY, Math.max(1, Math.trunc(qty))) } : l)));
}
export function removeFromBag(key: string): void { write(readBag().filter(l => lineKey(l) !== key)); }
export function clearBag(): void { write([]); }
export { lineKey as bagLineKey };

export const bagCount = (lines: BagLine[] = readBag()): number => lines.reduce((n, l) => n + l.qty, 0);
export const bagTotalPaise = (lines: BagLine[] = readBag()): number => lines.reduce((n, l) => n + l.unitPaise * l.qty, 0);
/** Lines grouped by influencer, in the order first added. */
export function bagByHost(lines: BagLine[]): { hostSlug: string; hostName: string; lines: BagLine[] }[] {
  const out: { hostSlug: string; hostName: string; lines: BagLine[] }[] = [];
  for (const l of lines) {
    const g = out.find(x => x.hostSlug === l.hostSlug);
    if (g) g.lines.push(l); else out.push({ hostSlug: l.hostSlug, hostName: l.hostName, lines: [l] });
  }
  return out;
}

/** Subscribe to any change of the bag (this tab or another). Returns the unsubscribe function. */
export function subscribeBag(fn: () => void): () => void {
  if (!isBrowser) return () => {};
  const onStorage = (e: StorageEvent) => { if (e.key === BAG_KEY || e.key === null) fn(); };
  window.addEventListener(CHANGE, fn);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(CHANGE, fn); window.removeEventListener('storage', onStorage); };
}
/** Slide the bag drawer in (the drawer island listens). */
export function openBagDrawer(justAdded?: BagLine): void {
  if (isBrowser) window.dispatchEvent(new CustomEvent(OPEN, { detail: justAdded ?? null }));
}
export function onBagDrawerOpen(fn: (added: BagLine | null) => void): () => void {
  if (!isBrowser) return () => {};
  const h = (e: Event) => fn(((e as CustomEvent).detail as BagLine | null) ?? null);
  window.addEventListener(OPEN, h);
  return () => window.removeEventListener(OPEN, h);
}
