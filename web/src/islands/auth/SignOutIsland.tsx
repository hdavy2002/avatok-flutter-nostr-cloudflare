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
 *
 * ── [WEB-SIGNOUT-BACKSTOP-1 2026-09-05] RULE 2 HAD NO FLOOR
 * The 12s backstop above starts only once `isLoaded` is true, so it covers "Clerk
 * loaded and signOut() is slow" and nothing else. If the Clerk SDK never loads —
 * blocked script, dead key, offline — `isLoaded` stays false forever, no timer is
 * ever armed, and the visitor sits on "Signing you out…" indefinitely. That is
 * exactly the failure the header's own last paragraph forbids, and it is worse
 * than the original bug: every header "Sign out" on the site is a plain link to
 * this route (HeaderAuth.tsx), so a hang here is the only exit being closed.
 *
 * So there are now TWO timers, and they are not the same thing:
 *   • the LOADED backstop (12s, unchanged) — Clerk is up, signOut is just slow.
 *   • the HARD backstop (below, armed on MOUNT) — Clerk never showed up at all.
 * The hard one is long enough that it cannot pre-empt a real sign-out, which is
 * still the rule that matters. It emits `auth_signout_stranded` before leaving,
 * because a visitor reaching it means the SDK is broken on this page and that is
 * invisible from the server side.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { capture, reset } from '../../lib/analytics';

const GUEST_JWT_KEY = 'avatok_guest_jwt';
const GUEST_HANDLE_KEY = 'avatok_guest_handle';

/** Leave the page. `replace` so Back does not return to the sign-out route. */
function goHome() {
  location.replace('/');
}

/** Clerk is up but signOut is slow. Generous — leaving early is the original bug. */
const LOADED_BACKSTOP_MS = 12000;
/** Clerk never loaded at all. Longer still, so it can never pre-empt the above. */
const HARD_BACKSTOP_MS = 20000;

function Inner() {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const [status, setStatus] = useState('Signing you out…');
  // Shared across both effects so the hard backstop and the sign-out path cannot
  // both navigate. A ref, not a local: the two timers live in different effects.
  const doneRef = useRef(false);
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    goHome();
  };

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
    // The floor. Armed on mount, so it covers the case `isLoaded` never flips.
    const t = window.setTimeout(() => {
      if (doneRef.current) return;
      // Reaching here means the Clerk SDK never came up on this page. Say so,
      // because from the server this looks identical to a successful sign-out.
      capture('auth_signout_stranded', { reason: 'clerk_never_loaded', waited_ms: HARD_BACKSTOP_MS });
      reset();
      finish();
    }, HARD_BACKSTOP_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // RULE 1: not until Clerk is actually loaded.
    if (!isLoaded) return;

    void (async () => {
      try {
        await clerk.signOut();
        capture('auth_signout', {});
      } catch {
        // Already signed out, or Clerk unreachable. Either way there is nothing
        // further this page can do, and leaving is better than hanging.
        setStatus('Signing you out…');
      }
      // §1.3 — clear the PostHog distinct_id/session on sign-out regardless of
      // whether Clerk's own call succeeded; there is nothing left to identify.
      reset();
      finish();
    })();

    // RULE 2: this backstop starts only AFTER isLoaded, and is long enough that
    // it cannot plausibly interrupt a sign-out that is genuinely in flight. The
    // hard backstop above covers the case where isLoaded never arrives.
    const t = window.setTimeout(finish, LOADED_BACKSTOP_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
