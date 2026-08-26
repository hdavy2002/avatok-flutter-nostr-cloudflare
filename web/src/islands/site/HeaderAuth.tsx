/* HeaderAuth — the auth-aware right side of SiteHeader.
 *
 * [WEB-HEADER-1 2026-08-26] Signed out: LOG IN + SIGN UP, exactly as the poster
 * artwork showed them. Signed in: DASHBOARD + SIGN OUT.
 *
 * Styling comes from SiteHeader.astro's global `.avh-cta` classes rather than
 * Tailwind, because the header uses the poster's palette and Anton, neither of
 * which is in the site's zine token set.
 *
 * Renders the signed-OUT pair while Clerk is still loading. That is deliberate:
 * it matches the server-rendered markup, so there is no flash of empty space,
 * and it is the correct state for the overwhelming majority of visitors. A
 * signed-in user sees it swap once, in place, with no layout shift because both
 * states are the same shape.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';

function Anon() {
  return (
    <>
      <a className="avh-cta" href="/sign-in">Log in</a>
      <a className="avh-cta avh-cta--solid" href="/sign-up">Sign up</a>
    </>
  );
}

function Inner() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const [hasGuest, setHasGuest] = useState(false);

  useEffect(() => {
    try {
      setHasGuest(!!localStorage.getItem('avatok_guest_jwt'));
    } catch {
      /* private mode — treat as anonymous */
    }
  }, []);

  if (!isLoaded) return <Anon />;
  if (!isSignedIn && !hasGuest) return <Anon />;

  return (
    <>
      <a className="avh-cta" href="/dashboard">Dashboard</a>
      <button
        type="button"
        className="avh-cta avh-cta--solid"
        onClick={async () => {
          try { localStorage.removeItem('avatok_guest_jwt'); } catch { /* ignore */ }
          try { await signOut(); } catch { /* ignore */ }
          location.href = '/';
        }}
      >
        Sign out
      </button>
    </>
  );
}

export function HeaderAuth() {
  // No key configured → no session can be read; the signed-out pair is correct.
  if (!CLERK_PUBLISHABLE_KEY) return <Anon />;
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default HeaderAuth;
