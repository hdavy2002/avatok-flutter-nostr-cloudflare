/* Phase B — AuthGate (reusable identity gate for B/C/D/E).
 *
 * Purpose (MASTER-PROMPT §4b): expose the viewer's identity LEVEL and gate a
 * single action behind "guest is enough". A guest (level 0) may book, talk,
 * join and enter — so the default `minLevel` is 0 and the gate simply ensures a
 * session exists via the shared `requireGuestAuth()`. Higher tiers (1–3, full
 * account) are only requested where a phase explicitly needs them, in which
 * case the gate surfaces <UpgradePrompt/> instead of proceeding.
 *
 * This file deliberately does NOT build any C/D/E screen — it only resolves
 * "am I allowed in" and hands back the level + token. See ladder.ts:
 *   GET /api/identity/level → { uid, level, proofs }   (guest = 0, full = 1..3)
 */
import { useCallback, useEffect, useState } from 'react';
import { getActiveToken, requireGuestAuth } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import type { IdentityLevel } from '../../lib/types';
import { UpgradePrompt } from './UpgradePrompt';

/** Anonymous (no session yet) is represented as level -1. */
export type ViewerLevel = number;

export interface IdentityState {
  level: ViewerLevel;
  uid: string | null;
  loaded: boolean;
  /** Re-read the current level (after auth/upgrade). */
  refresh: () => Promise<void>;
}

/**
 * Read the viewer's identity level WITHOUT opening any UI. Anonymous → -1.
 * Phases C/D/E can import this to decide whether to show their join button.
 */
export function useIdentityLevel(): IdentityState {
  const [level, setLevel] = useState<ViewerLevel>(-1);
  const [uid, setUid] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const token = await getActiveToken();
    if (!token) {
      setLevel(-1);
      setUid(null);
      setLoaded(true);
      return;
    }
    try {
      const r = await request<IdentityLevel>('/api/identity/level', { auth: token });
      setLevel(typeof r.level === 'number' ? r.level : 0);
      setUid(r.uid ?? null);
    } catch (e) {
      // A valid guest token that the level endpoint rejects → treat as anon.
      setLevel(e instanceof ApiError && e.status === 401 ? -1 : 0);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { level, uid, loaded, refresh };
}

export interface AuthGateProps {
  /** Minimum identity level to proceed. Booking/talk/join/enter = 0 (guest ok). */
  minLevel?: number;
  /** Rendered once the viewer meets `minLevel` (a valid session exists). */
  children: (token: string) => React.ReactNode;
  /** Optional copy for the upgrade prompt when a higher tier is required. */
  upgradeReason?: string;
  /** Optional render while resolving. */
  fallback?: React.ReactNode;
}

/**
 * Ensures a session that meets `minLevel`, then renders `children(token)`.
 * - level 0 required (default): opens the GuestGate via requireGuestAuth().
 * - level ≥1 required and viewer is a guest: shows <UpgradePrompt/>.
 */
export function AuthGate({ minLevel = 0, children, upgradeReason, fallback }: AuthGateProps) {
  const { level, loaded, refresh } = useIdentityLevel();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once we know the viewer is anonymous and only guest is required, fetch a
  // guest session up front so children can render immediately.
  useEffect(() => {
    if (!loaded || token) return;
    if (minLevel <= 0) {
      void (async () => {
        setBusy(true);
        try {
          const t = await requireGuestAuth();
          setToken(t);
          await refresh();
        } catch {
          setError('Sign-in was cancelled.');
        } finally {
          setBusy(false);
        }
      })();
    }
  }, [loaded, token, minLevel, refresh]);

  if (!loaded || busy) return <>{fallback ?? null}</>;

  if (level >= 1 || (minLevel <= 0 && token)) {
    const t = token;
    return <>{t ? children(t) : fallback ?? null}</>;
  }

  // A higher tier is required but the viewer is a guest/anon → prompt upgrade.
  if (minLevel >= 1) {
    return <UpgradePrompt reason={upgradeReason} onUpgraded={() => void refresh()} />;
  }

  if (error) {
    return (
      <p className="font-body font-bold text-[14px] text-coral">{error}</p>
    );
  }
  return <>{fallback ?? null}</>;
}

export default AuthGate;
