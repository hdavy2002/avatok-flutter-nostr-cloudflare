// [SAATHUM-SHOP-WEB-STORE-1 2026-10-01] The shop wishlist — product ids in localStorage.
// Contract: Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §5.2 (the dashboard Wishlist page imports this).
// Every storage access is try/catch'd; with storage blocked the heart still works for the page's life.
const KEY = 'saathum_shop_wish_v1';
const EVT = 'shop:wish';
const isBrowser = typeof window !== 'undefined';
let memory: string[] = [];

function read(): string[] {
  if (!isBrowser) return [];
  try {
    const text = window.localStorage.getItem(KEY);
    if (text == null) return memory;
    const raw = JSON.parse(text);
    memory = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
  } catch { /* blocked or corrupt: keep the in-memory copy */ }
  return memory;
}

function write(ids: string[]): void {
  memory = ids;
  if (!isBrowser) return;
  try { window.localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* blocked */ }
  try { window.dispatchEvent(new CustomEvent<string[]>(EVT, { detail: ids })); } catch { /* old browser */ }
}

export function getWish(): string[] { return [...read()]; }

/** Toggles a product id; returns true when it is now in the wishlist. */
export function toggleWish(id: string): boolean {
  const ids = read();
  const on = !ids.includes(id);
  write(on ? [...ids, id] : ids.filter((x) => x !== id));
  return on;
}

export function onWishChange(cb: (ids: string[]) => void): () => void {
  if (!isBrowser) return () => {};
  const local = () => cb(getWish());
  const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) cb(getWish()); };
  window.addEventListener(EVT, local);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVT, local); window.removeEventListener('storage', storage); };
}
