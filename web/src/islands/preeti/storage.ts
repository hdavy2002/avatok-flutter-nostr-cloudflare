// [SAATHUM-PREETI-1] localStorage with an in-memory fallback (private mode,
// blocked storage, SSR). Never throws.
const mem = new Map<string, string>();

export function lsGet(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch { /* storage blocked - fall back to memory */ }
  return mem.get(key) ?? null;
}

export function lsSet(key: string, value: string): void {
  mem.set(key, value);
  try { window.localStorage.setItem(key, value); } catch { /* storage blocked - memory copy kept */ }
}

export const KEY_VISITOR = 'preeti_visitor_v1';
export const KEY_CONVERSATION = 'preeti_conversation_v1';
export const KEY_BUBBLE = 'preeti_bubble_pos_v1';

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function getVisitorId(): string {
  let id = lsGet(KEY_VISITOR);
  if (!id) {
    id = newId();
    lsSet(KEY_VISITOR, id);
  }
  return id;
}
