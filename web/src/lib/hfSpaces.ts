/* [HF-CREATOR-SPACES-1] Shared bits for Women-only / LGBTQ+ channels: who may call (GET /api/hf/lanes/me), the lock text,
 * the verify link, and telemetry. Missing fields from an older worker count as false/null. Never send gender or the declaration. */
import { useEffect, useState } from 'react';
import { hfCall, looksSignedOut, signInUrl } from './hfCallsApi';
import { capture } from './analytics';

export type Space = 'women' | 'lgbtq';
export const parseSpace = (v: unknown): Space | null => (v === 'women' || v === 'lgbtq' ? v : null);
/** Host objects carry `space`; the old `womenOnly` flag still means the women space. */
export const spaceOf = (h: { space?: unknown; womenOnly?: boolean } | null | undefined): Space | null => parseSpace(h?.space) ?? (h?.womenOnly ? 'women' : null);

export const SPACE_TAG: Record<Space, string> = { women: 'Women-only channel', lgbtq: 'LGBTQ+ channel' };
export const LOCK_TEXT: Record<Space, string> = {
  women: 'Only verified women can call this channel',
  lgbtq: 'Only verified LGBTQ+ members can call this channel',
};

export function verifyHref(lane: Space, next?: string): string {
  let n = next;
  if (n === undefined) { try { n = location.pathname + location.search; } catch { n = '/'; } }
  return `/verify/lane?lane=${lane}&next=${encodeURIComponent(n || '/')}`;
}

export interface SpaceMe {
  whatsappVerified?: boolean; aadhaarVerified?: boolean; videoKycVerified?: boolean; gender?: 'F' | 'M' | 'T' | null;
  selfie?: { status?: 'none' | 'pending' | 'approved' | 'rejected'; reason?: string | null };
  lanes?: { women?: { eligible?: boolean; granted?: boolean }; lgbtq?: { declared?: boolean; granted?: boolean } };
}

/** What is still missing, for telemetry only (no personal detail). */
export function missingFor(me: SpaceMe | null, lane: Space): string {
  if (!me) return 'signin';
  if (!me.whatsappVerified) return 'whatsapp';
  if (!me.aadhaarVerified) return 'aadhaar';
  if (lane === 'lgbtq' && !me.lanes?.lgbtq?.declared) return 'declaration';
  const s = me.selfie?.status ?? 'none';
  if (s !== 'approved') return s === 'pending' ? 'selfie_pending' : s === 'rejected' ? 'selfie_rejected' : 'selfie';
  return 'join';
}

export function trackGate(lane: Space, missing: string): void {
  try { capture('hf_space_gate_shown', { lane, missing }); } catch { /* telemetry is best-effort */ }
}

let meP: Promise<{ signedOut: boolean; me: SpaceMe | null }> | null = null;
/** One lanes/me request per page; a failure is not cached. */
export function fetchSpaceMe(): Promise<{ signedOut: boolean; me: SpaceMe | null }> {
  if (!meP) {
    const p = hfCall<SpaceMe>('GET', '/api/hf/lanes/me').then(r => {
      if (r.ok) return { signedOut: false, me: r.data };
      if (r.status === 401) { if (meP === p) meP = null; return { signedOut: true, me: null }; }
      if (meP === p) meP = null;
      return { signedOut: false, me: null };
    });
    meP = p;
  }
  return meP;
}

export type GateState = 'loading' | 'ok' | 'signedout' | 'locked';
/** Is this viewer allowed to call a channel in `space`? `loading` keeps buttons off until we know. */
export function useSpaceGate(space: Space | null): { state: GateState; missing: string; needsBridge: boolean } {
  const [st, setSt] = useState<{ state: GateState; missing: string }>({ state: space ? 'loading' : 'ok', missing: '' });
  useEffect(() => {
    if (!space) { setSt({ state: 'ok', missing: '' }); return; }
    if (looksSignedOut()) { setSt({ state: 'signedout', missing: 'signin' }); return; }
    let live = true;
    void fetchSpaceMe().then(r => {
      if (!live) return;
      if (r.signedOut) { setSt({ state: 'signedout', missing: 'signin' }); return; }
      if (!r.me) { setSt({ state: 'locked', missing: 'unknown' }); return; } // could not load: the server still enforces; show the prompt, not the buttons
      const granted = r.me.lanes?.[space]?.granted === true;
      setSt(granted ? { state: 'ok', missing: '' } : { state: 'locked', missing: missingFor(r.me, space) });
    });
    return () => { live = false; };
  }, [space]);
  return { ...st, needsBridge: !!space && st.state !== 'signedout' };
}

export { signInUrl };
