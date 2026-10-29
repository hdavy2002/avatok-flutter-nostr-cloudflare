// [HF-SUPPORT-DESK] Who is signed in. Real mode: the website's own Clerk session (the same one hellofraands.com uses; the
// cookie/session is shared with subdomains of the primary domain). Mock mode (PUBLIC_SUPPORT_MOCK=1): a fake person you can
// switch from the little bar at the bottom of the screen.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth as useClerkAuth, useUser } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/env';
import { MOCK } from './api';
import { navigate } from './router';

export interface AuthState { ready: boolean; signedIn: boolean; name: string; email: string; signOut: () => Promise<void> }
const AuthCtx = createContext<AuthState>({ ready: false, signedIn: false, name: '', email: '', signOut: async () => undefined });
export const useAuthState = (): AuthState => useContext(AuthCtx);

/* ── real ──────────────────────────────────────────────────────────────── */
function ClerkAuth({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, signOut } = useClerkAuth();
  const { user } = useUser();
  const doSignOut = useCallback(async () => { await signOut(); navigate('/', { replace: true }); }, [signOut]);
  const value = useMemo<AuthState>(() => ({
    ready: !!isLoaded, signedIn: !!isSignedIn,
    name: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress?.split('@')[0] || '',
    email: user?.primaryEmailAddress?.emailAddress ?? '',
    signOut: doSignOut,
  }), [isLoaded, isSignedIn, user, doSignOut]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/* ── mock ──────────────────────────────────────────────────────────────── */
type MockWho = 'staff' | 'customer' | 'guest';
function readWho(): MockWho {
  try {
    const q = new URLSearchParams(location.search).get('as');
    if (q === 'staff' || q === 'customer' || q === 'guest') { sessionStorage.setItem('hfs-mock-who', q); return q; }
    const s = sessionStorage.getItem('hfs-mock-who');
    if (s === 'staff' || s === 'customer' || s === 'guest') return s;
  } catch { /* storage may be blocked */ }
  return 'staff';
}

function MockAuth({ children }: { children: ReactNode }) {
  const [who, setWho] = useState<MockWho>(readWho);
  useEffect(() => { void import('./mock').then((m) => m.setMockWho(who)); }, [who]);
  const [ready, setReady] = useState(false);
  useEffect(() => { void import('./mock').then((m) => { m.setMockWho(who); setReady(true); }); }, [who]);
  const pick = (w: MockWho) => { try { sessionStorage.setItem('hfs-mock-who', w); } catch { /* ignore */ } setReady(false); setWho(w); navigate('/', { replace: true }); };
  const value = useMemo<AuthState>(() => ({
    ready, signedIn: who !== 'guest', name: who === 'staff' ? 'Davy' : who === 'customer' ? 'Ravi K' : '', email: who === 'staff' ? 'hdavy2002@gmail.com' : who === 'customer' ? 'ravi.k@example.com' : '',
    signOut: async () => pick('guest'),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ready, who]);
  return (
    <AuthCtx.Provider value={value}>
      <div key={who}>{children}</div>
      <div className="hfs-mockbar" role="group" aria-label="Preview data switch">
        <span>Preview data (not live)</span>
        {(['staff', 'customer', 'guest'] as MockWho[]).map((w) => (
          <button key={w} type="button" className={who === w ? 'is-on' : ''} onClick={() => pick(w)}>{w === 'guest' ? 'Signed out' : w === 'staff' ? 'Staff' : 'Customer'}</button>
        ))}
      </div>
    </AuthCtx.Provider>
  );
}

/** Marks a successful sign-in in mock mode (the sign-in forms call this instead of Clerk). */
export function mockSignedIn(as: 'customer' | 'staff'): void {
  try { sessionStorage.setItem('hfs-mock-who', as); } catch { /* ignore */ }
  location.reload();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (MOCK) return <MockAuth>{children}</MockAuth>;
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="hfs-fatal" role="alert">
        <h1>Sign-in is not set up on this build</h1>
        <p>PUBLIC_CLERK_PUBLISHABLE_KEY is missing. Ask the developer to set it, then rebuild.</p>
      </div>
    );
  }
  return <ClerkIsland><ClerkAuth>{children}</ClerkAuth></ClerkIsland>;
}
