// [AUMFE-PREVIEW-GATE-1] Server-authorized preview access, cached for the current session.
// Auth readiness/account changes invalidate both successful and signed-out results.
import { useEffect, useState } from 'react';
import { request } from './apiClient';
import { getActiveTokenWaited, ACTIVE_SESSION_CHANGED } from './clerk';
import { capture } from './analytics';
import { createPreviewStore, PREVIEW_OFF } from './previewStore';
import type { PreviewState, PreviewSnapshot } from './previewStore';
export type { PreviewState } from './previewStore';

const store = createPreviewStore(async () => {
  const token = await getActiveTokenWaited(2500);
  if (!token) return PREVIEW_OFF;
  const r = await request<Partial<PreviewState>>('/api/me/preview', { auth: token, timeoutMs: 8000 });
  return { preview: r.preview === true, guides: r.guides === true, admin: r.admin === true };
});

let listening = false;
function listenForSession() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(ACTIVE_SESSION_CHANGED, () => store.sessionChanged());
}

export function getPreview(): Promise<PreviewState> {
  if (typeof window === 'undefined') return Promise.resolve(PREVIEW_OFF);
  listenForSession();
  return store.get();
}

export function usePreview(): PreviewSnapshot {
  const [state, setState] = useState<PreviewSnapshot>({ ...PREVIEW_OFF, loading: true });
  useEffect(() => {
    listenForSession();
    const unsubscribe = store.subscribe(setState);
    setState(store.snapshot());
    void store.get();
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!state.preview) return;
    try {
      if (!sessionStorage.getItem('preview_mode_seen')) {
        sessionStorage.setItem('preview_mode_seen', '1');
        capture('preview_mode_seen', { guides: state.guides, admin: state.admin });
      }
    } catch { /* storage blocked — skip the once-per-session guard */ }
  }, [state.preview, state.guides, state.admin]);
  return state;
}
