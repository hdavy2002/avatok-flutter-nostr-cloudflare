// [AUMFE-PREVIEW-GATE-1] Is this visitor a previewer of the hidden-until-gateway surfaces (voice guides, wallet UI,
// home ad band, Explore guides, new help topics, new legal sections)? Calls GET /api/me/preview, memoised per page load.
// Any error or a signed-out visitor resolves to all-false, so hidden stuff stays hidden when in doubt.
import { useEffect, useState } from 'react';
import { request } from './apiClient';
import { getActiveTokenWaited } from './clerk';
import { capture } from './analytics';

export interface PreviewState { preview: boolean; guides: boolean; admin: boolean }
const OFF: PreviewState = { preview: false, guides: false, admin: false };
let memo: Promise<PreviewState> | null = null;

export function getPreview(): Promise<PreviewState> {
  if (typeof window === 'undefined') return Promise.resolve(OFF);
  if (!memo) {
    memo = (async () => {
      try {
        const token = await getActiveTokenWaited(2500);
        if (!token) return OFF; // signed out
        const r = await request<Partial<PreviewState>>('/api/me/preview', { auth: token, timeoutMs: 8000 });
        const out: PreviewState = { preview: r.preview === true, guides: r.guides === true, admin: r.admin === true };
        if (out.preview) {
          try {
            if (!sessionStorage.getItem('preview_mode_seen')) {
              sessionStorage.setItem('preview_mode_seen', '1');
              capture('preview_mode_seen', { guides: out.guides, admin: out.admin });
            }
          } catch { /* storage blocked — skip the once-per-session guard */ }
        }
        return out;
      } catch {
        return OFF;
      }
    })();
  }
  return memo;
}

export function usePreview(): PreviewState & { loading: boolean } {
  const [state, setState] = useState<PreviewState & { loading: boolean }>({ ...OFF, loading: true });
  useEffect(() => {
    let alive = true;
    void getPreview().then((s) => { if (alive) setState({ ...s, loading: false }); });
    return () => { alive = false; };
  }, []);
  return state;
}
