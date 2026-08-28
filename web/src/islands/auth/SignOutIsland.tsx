/* SignOutIsland — ends the Clerk session, clears the guest token, goes home.
 *
 * [WEB-HEADER-SIGNOUT-1 2026-08-28] Mirrors what SidebarUser's "Sign out" does,
 * as a standalone route so pages without a Clerk island (the static design
 * comps at /marketplace and the listing routes) can offer a sign-out link.
 *
 * ── [WEB-AUTH-SIGNOUT-FIX-1 2026-08-28] WHY THE FIRST VERSION DID NOT SIGN OUT
 * It called `clerk.signOut()` immediately on mount and started a 4s timer that
 * redirected home regardless. `useClerk()` hands back the Clerk instance right
 * away, but that instance is NOT LOADED yet — the SDK is still fetching its
 * environment and client. Calling signOut() on an unloaded instance does not end
 * the session; it rejects or no-ops. The rejection went into a bare catch, the
 * redirect fired, and the visitor landed on the home page STILL SIGNED IN, with
 * a header correctly showing "Dashboard / Sign out" — which read as the header
 * being broken rather than the sign-out being broken. Verified live: the same
 * call works perfectly after `await Clerk.load()`.
 *
 * Two rules follow, and both matter:
 *   1. WAIT for `isLoaded` before calling signOut.
 *   2. Do NOT race the redirect against it. The backstop below only starts once
 *      Clerk is loaded, and is generous — leaving early is exactly the bug.
 *
 * The redirect still always happens in the end: a visitor must never be stranded
 * on "Signing you out…". But it is no longer allowed to pre-empt the sign-out.
 */
import { useEffect, useState } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const GUEST_HANDLE_KEY = 'avatok_guest_handle';

/** Leave the page. `replace` so Back does not return to the sign-out route. */
function goHome() {
  location.replace('/');
}

function Inner() {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const [status, setStatus] = useState('Signing you out…');

  useEffect(() => {
    // The guest token is device-level and lives outside Clerk, so clear it
    // immediately and unconditionally — it does not depend on the SDK.
    try {
      localStorage.removeItem(GUEST_JWT_KEY);
      localStorage.removeItem(GUEST_HANDLE_KEY);
    } catch {
      /* storage blocked — nothing to clear */
    }
  }, []);

  useEffect(() => {
    // RULE 1: not until Clerk is actually loaded.
    if (!isLoaded) return;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      goHome();
    };

    void (async () => {
      try {
        await clerk.signOut();
      } catch {
        // Already signed out, or Clerk unreachable. Either way there is nothing
        // further this page can do, and leaving is better than hanging.
        setStatus('Signing you out…');
      }
      finish();
    })();

    // RULE 2: backstop starts only AFTER isLoaded, and is long enough that it
    // cannot plausibly interrupt a sign-out that is genuinely in flight.
    const t = window.setTimeout(finish, 12000);
    return () => window.clearTimeout(t);
  }, [isLoaded, clerk]);

  return <span>{status}</span>;
}

export default function SignOutIsland() {
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}
