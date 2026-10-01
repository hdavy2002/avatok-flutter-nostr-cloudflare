// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The shop cart — localStorage, no account needed.
// Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §5.2 (other shop surfaces import this; keep the API exact).
//
// NOTE FOR AI:
//  - Every storage access is wrapped in try/catch (private windows / blocked storage must never throw);
//    when storage is unavailable the cart still works for the life of the page, from memory.
//  - Changes broadcast on `window` event 'shop:cart' (same tab) and the native 'storage' event (other tabs).
//  - Cart lines are a DISPLAY cache: the server re-prices every line (POST /api/shop/quote and order create).
//  - Per-account scoping does not apply: the cart is a guest device-level value like the Clerk token.
export type CartLine = {
  product_id: string; slug: string; name: string; colour: string; colour_hex: string; size: string;
  qty: number; unit_rupees: number; image_url: string | null;
};

const KEY = 'saathum_shop_cart_v1';
const EVT = 'shop:cart';
const OPEN_EVT = 'shop:cart-open';
const TOAST_EVT = 'shop:toast';
const MAX_QTY = 10;
const MAX_LINES = 20;

const isBrowser = typeof window !== 'undefined';
let memory: CartLine[] = [];

function clean(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const out: CartLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const l = r as Record<string, unknown>;
    if (typeof l.product_id !== 'string' || typeof l.size !== 'string' || typeof l.colour !== 'string') continue;
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(l.qty) || 1)));
    out.push({
      product_id: l.product_id,
      slug: typeof l.slug === 'string' ? l.slug : '',
      name: typeof l.name === 'string' ? l.name : '',
      colour: l.colour,
      colour_hex: typeof l.colour_hex === 'string' ? l.colour_hex : '',
      size: l.size,
      qty,
      unit_rupees: Math.max(0, Math.round(Number(l.unit_rupees) || 0)),
      image_url: typeof l.image_url === 'string' ? l.image_url : null,
    });
  }
  return out.slice(0, MAX_LINES);
}

function read(): CartLine[] {
  if (!isBrowser) return [];
  try {
    const text = window.localStorage.getItem(KEY);
    if (text == null) return memory;
    memory = clean(JSON.parse(text));
  } catch { /* storage blocked or corrupt JSON: fall back to the in-memory copy */ }
  return memory;
}

function write(lines: CartLine[]): void {
  memory = lines;
  if (!isBrowser) return;
  try { window.localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* quota / blocked: memory copy still serves this page */ }
  try { window.dispatchEvent(new CustomEvent<CartLine[]>(EVT, { detail: lines })); } catch { /* old browser */ }
}

export function getCart(): CartLine[] { return read().map((l) => ({ ...l })); }
export function cartCount(): number { return read().reduce((n, l) => n + l.qty, 0); }

/** Adds a line, merging with an existing product+colour+size line (qty capped at 10). */
export function addToCart(l: CartLine): void {
  const lines = read().map((x) => ({ ...x }));
  const hit = lines.find((x) => x.product_id === l.product_id && x.colour === l.colour && x.size === l.size);
  const qty = Math.max(1, Math.floor(l.qty) || 1);
  if (hit) {
    hit.qty = Math.min(MAX_QTY, hit.qty + qty);
    hit.unit_rupees = l.unit_rupees; hit.image_url = l.image_url; hit.name = l.name; hit.slug = l.slug; hit.colour_hex = l.colour_hex;
  } else if (lines.length < MAX_LINES) {
    lines.push({ ...l, qty: Math.min(MAX_QTY, qty) });
  }
  write(lines);
}

/** qty < 1 removes the line. */
export function setQty(index: number, qty: number): void {
  const lines = read().map((x) => ({ ...x }));
  if (!lines[index]) return;
  if (qty < 1) lines.splice(index, 1);
  else lines[index].qty = Math.min(MAX_QTY, Math.floor(qty));
  write(lines);
}

export function removeLine(index: number): void {
  const lines = read().map((x) => ({ ...x }));
  if (!lines[index]) return;
  lines.splice(index, 1);
  write(lines);
}

export function clearCart(): void { write([]); }

/** Subscribe to cart changes in this tab and other tabs. Returns the unsubscribe function. */
export function onCartChange(cb: (c: CartLine[]) => void): () => void {
  if (!isBrowser) return () => {};
  const local = () => cb(getCart());
  const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) cb(getCart()); };
  window.addEventListener(EVT, local);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVT, local); window.removeEventListener('storage', storage); };
}

/** Opens the cart drawer (CartDrawer listens for this). */
export function openCart(): void {
  if (!isBrowser) return;
  try { window.dispatchEvent(new CustomEvent(OPEN_EVT)); } catch { /* old browser */ }
}

/** Shows the shop toast (bottom-centre, 2.2 s) — used for "Added: …" and wishlist messages. */
export function showToast(message: string): void {
  if (!isBrowser) return;
  try { window.dispatchEvent(new CustomEvent<string>(TOAST_EVT, { detail: message })); } catch { /* old browser */ }
}

export const SHOP_EVENTS = { cart: EVT, open: OPEN_EVT, toast: TOAST_EVT } as const;
