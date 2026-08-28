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
  const { isLoaded, isSignedIn } = useAuth();
  const [hasGuest, setHasGuest] = useState(false);

  useEffect(() => {
    try {
      setHasGuest(!!localStorage.getItem('avatok_guest_jwt'));
    } catch {
      /* private mode — treat as anonymous */
    }
  }, []);

  // A guest session lives in localStorage and is knowable WITHOUT Clerk, so it
  // is checked first. Testing `isLoaded` before it meant that whenever clerk-js
  // failed to load — an ad blocker, a flaky network — a signed-in guest was
  // shown "Log in / Sign up" and had no way back to their dashboard.
  if (hasGuest) return <DashboardCta />;
  if (!isLoaded || !isSignedIn) return <Anon />;

  return <DashboardCta />;
}

/*
 * [WEB-HEADER-2 2026-08-26] Signed in = a Dashboard button, replacing both
 * Log in and Sign up (owner request).
 *
 * [WEB-HEADER-SIGNOUT-2 2026-08-28] SIGN OUT IS BACK IN THE HEADER. The 2026-08-26
 * note below this used to say it lived only in the dashboard sidebar's profile
 * card (islands/shell/SidebarUser.tsx), and that this had been "checked before
 * removing this one". That check did not survive the dashboard being rebuilt:
 * in the current shell the card sits at the bottom of a long, scrolling sidebar,
 * BELOW THE FOLD, so from the owner's seat there was no sign out anywhere on the
 * page. A single off-screen affordance is not a way out.
 *
 * It links to /sign-out (pages/sign-out.astro) rather than calling signOut()
 * here, so the identical markup works on pages that have no Clerk island — the
 * static design comps at /marketplace and the listing routes.
 */
function DashboardCta() {
  return (
    <>
      <a className="avh-cta avh-cta--solid" href="/dashboard">Dashboard</a>
      <a className="avh-cta" href="/sign-out">Sign out</a>
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
