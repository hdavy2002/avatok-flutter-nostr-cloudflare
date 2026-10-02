// Session-scoped preview state. Kept independent of React/Clerk for CI regression tests.
export interface PreviewState { preview: boolean; guides: boolean; admin: boolean }
export type PreviewSnapshot = PreviewState & { loading: boolean };
export const PREVIEW_OFF: PreviewState = { preview: false, guides: false, admin: false };

export function createPreviewStore(load: () => Promise<PreviewState>) {
  let state: PreviewSnapshot = { ...PREVIEW_OFF, loading: true };
  let memo: Promise<PreviewState> | null = null;
  let generation = 0;
  const listeners = new Set<(state: PreviewSnapshot) => void>();
  const publish = (next: PreviewSnapshot) => {
    state = next;
    listeners.forEach((listener) => listener(state));
  };
  const get = (): Promise<PreviewState> => {
    if (memo) return memo;
    const current = generation;
    memo = load().catch(() => PREVIEW_OFF).then((result) => {
      // A previous account's response must never restore its preview access.
      if (generation !== current) return PREVIEW_OFF;
      publish({ ...result, loading: false });
      return result;
    });
    return memo;
  };
  return {
    get,
    snapshot: () => state,
    subscribe(listener: (state: PreviewSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sessionChanged() {
      generation++;
      memo = null;
      // Hide immediately, including while the next account's request is pending.
      publish({ ...PREVIEW_OFF, loading: true });
      if (listeners.size) void get();
    },
  };
}
