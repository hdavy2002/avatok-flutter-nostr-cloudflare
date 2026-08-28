/* SignOutIsland — ends the Clerk session, clears the guest token, goes home.
 *
 * [WEB-HEADER-SIGNOUT-1 2026-08-28] Mirrors what SidebarUser's "Sign out" does,
 * as a standalone route so pages without a Clerk island (the static design
 * comps at /marketplace and the listing routes) can offer a sign-out link.
 *
 * Every step is best-effort and the redirect happens regardless: a failure to
 * reach Clerk must not strand someone on a page that says "Signing you out…"
 * forever.
 */
import { useEffect } from 'react';
import { useClerk } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const GUEST_HANDLE_KEY = 'avatok_guest_handle';

function Inner() {
  const clerk = useClerk();

  useEffect(() => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      location.href = '/';
    };

    void (async () => {
      // The guest token is device-level and lives outside Clerk, so it has to be
      // cleared explicitly — otherwise "sign out" leaves a session behind.
      try {
        localStorage.removeItem(GUEST_JWT_KEY);
        localStorage.removeItem(GUEST_HANDLE_KEY);
      } catch {
        /* storage blocked — nothing to clear */
      }
      try {
        await clerk.signOut();
      } catch {
        /* already signed out, or Clerk unreachable */
      }
      go();
    })();

    // Backstop: if Clerk hangs, leave anyway rather than showing a dead page.
    const t = window.setTimeout(go, 4000);
    return () => window.clearTimeout(t);
  }, [clerk]);

  return null;
}

export default function SignOutIsland() {
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}
