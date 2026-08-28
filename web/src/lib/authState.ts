/*
 * authState — THE single answer to "is this visitor signed in?" on the web.
 *
 * [WEB-AUTH-STATE-1 2026-08-28] Before this file, the site had FOUR different
 * implementations of that question and they disagreed with each other:
 *
 *   1. islands/site/HeaderAuth.tsx — a Clerk React island (auth="auto" pages).
 *   2. components/SiteHeader.astro — a hardcoded `auth` prop ("in" / "static"),
 *      i.e. the page ASSERTS the answer at build time and can be wrong.
 *   3. The mobile panel in that same header — always signed-OUT links, on every
 *      page, because a second <ClerkProvider> crashes @clerk/clerk-react. A
 *      signed-in user on a phone was shown "Log in / Sign up".
 *   4. lib/mockupPage.ts — a network call to Clerk's API, injected into the
 *      static design comps, which have no island at all.
 *
 * Four implementations means four places to fix and four ways to drift. This is
 * the replacement, and it is deliberately the SIMPLEST possible mechanism:
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 * Clerk publishes a non-httpOnly cookie, `__client_uat`, precisely so a server
 * or a script can know the answer without loading the SDK. It holds "0" when
 * signed out and a unix timestamp when signed in. This is the same signal
 * Clerk's own SSR/edge helpers use.
 *
 * Verified live on avatok.ai 2026-08-28:
 *   signed in  -> __client_uat = <timestamp>, __session present
 *   signed out -> __client_uat = "0",         __session absent
 *
 * That makes the check SYNCHRONOUS and network-free, so it can run before first
 * paint and there is no flash of the wrong buttons.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is NOT authentication and NOT authorisation. It decides which BUTTONS to
 * draw, nothing else. A visitor can forge the cookie and see a "Dashboard"
 * link; clicking it lands on a page whose real Clerk guard bounces them to
 * /sign-in. Never gate data, money or a protected route on this — the server
 * verifies the session, as it always did.
 */

/** Clerk's signed-in hint cookie. "0" = signed out, timestamp = signed in. */
const UAT_COOKIE = '__client_uat';
/** Device-level guest session, outside Clerk. Also counts as signed in. */
const GUEST_JWT_KEY = 'avatok_guest_jwt';

export type AuthState = 'in' | 'out';

/** Read one cookie without pulling in a dependency. */
function cookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const raw = part.trim();
    const eq = raw.indexOf('=');
    if (eq > 0 && raw.slice(0, eq) === name) return raw.slice(eq + 1);
  }
  return null;
}

/**
 * Signed in? Synchronous, no network, safe to call before Clerk loads.
 *
 * Clerk may publish the cookie unscoped (`__client_uat`) and/or scoped to the
 * instance (`__client_uat_<hash>`); both appear on avatok.ai. Any one of them
 * carrying a non-zero value means there is a session.
 */
export function isSignedInSync(): boolean {
  if (typeof document === 'undefined') return false;

  const uat = cookie(UAT_COOKIE);
  if (uat && uat !== '0') return true;

  // Scoped variant, e.g. __client_uat_nrpBfDj4.
  if (/(?:^|;\s*)__client_uat_[A-Za-z0-9]+=(?!0(?:;|$))[^;]+/.test(document.cookie)) return true;

  try {
    if (localStorage.getItem(GUEST_JWT_KEY)) return true;
  } catch {
    /* storage blocked — fall through to signed out */
  }
  return false;
}

/** The attribute the header's CSS keys off. */
export const AUTH_ATTR = 'data-avatok-auth';

/**
 * Stamp the current state onto <html> so CSS can show the right buttons.
 * Returns what it wrote, so callers can act on it too.
 */
export function applyAuthState(): AuthState {
  const state: AuthState = isSignedInSync() ? 'in' : 'out';
  try {
    document.documentElement.setAttribute(AUTH_ATTR, state);
  } catch {
    /* non-DOM context */
  }
  return state;
}
