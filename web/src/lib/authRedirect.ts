// [DASH2-FOUNDATION 2026-09-25] Where a person lands after sign-in / sign-up /
// SSO / the phone gate. Owner decision: ALWAYS `/dashboard` (Book events),
// unless they were sent to sign in FROM a specific page (e.g. checkout) — then
// back there. Accepts both spellings in use: `redirect_url` (Clerk's own and
// the Dashboard 2 guard) and `next` (the older web islands).
//
// Only same-origin targets are honoured; anything else falls back to
// /dashboard, so this can never be used as an open redirect.

import { BRAND } from './brand';
export const DEFAULT_LANDING = '/dashboard';

/** Pages that must never be a post-login target (loops / dead ends). */
const NEVER = /^\/(sign-in|sign-up|sign-out|sso-callback)(\/|$|\?)/;

/** Returns a safe same-origin path+search+hash, or null. */
export function safeSameOriginPath(raw: string | null | undefined, origin?: string): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const base = origin ?? (typeof location !== 'undefined' ? location.origin : BRAND.webOrigin);
    // Reject protocol-relative and backslash tricks before URL parsing normalises them.
    if (value.startsWith('//') || value.startsWith('/\\') || value.startsWith('\\')) return null;
    const u = new URL(value, base);
    if (u.origin !== new URL(base).origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    if (!path.startsWith('/') || NEVER.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/** Read `redirect_url` (preferred) or `next` from a query string. */
export function redirectTargetFrom(search: string, fallback = DEFAULT_LANDING, origin?: string): string {
  try {
    const q = new URLSearchParams(search);
    return safeSameOriginPath(q.get('redirect_url'), origin) ?? safeSameOriginPath(q.get('next'), origin) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Browser convenience: the post-login landing for the current page's URL. */
export function postLoginTarget(fallback = DEFAULT_LANDING): string {
  if (typeof location === 'undefined') return fallback;
  return redirectTargetFrom(location.search, fallback);
}

/** The sign-in URL that brings the visitor back to where they are now. */
export function signInUrlForHere(): string {
  if (typeof location === 'undefined') return '/sign-in';
  return `/sign-in?redirect_url=${encodeURIComponent(location.pathname + location.search)}`;
}

// [SAATHUM-FREEVID-WEB-1 2026-10-01] FREE EVENTS. Owner decision: a free event is
// watchable by anyone signed in with an email — NO WhatsApp verification (that stays
// for paid events). Every email/Google sign-in normally ends at the phone/WhatsApp
// gate (`/sign-up?finish=1`, see finishUrl in islands/auth/passwordless.ts). A visitor
// who starts sign-in from a free event's "Watch free" button carries this marker in the
// return path, and ONLY then does the sign-in page skip that hop and go straight back.
// The marker is a routing hint, not a permission: the server still decides who may
// watch (free: signed in; paid: booking + verified WhatsApp), and account bootstrap
// still refuses an unverified phone wherever it is called.
export const FREE_WATCH_PARAM = 'freewatch';

/** Sign-in URL for a free event page: returns here, and skips the WhatsApp gate. */
export function signInUrlForFreeWatch(): string {
  if (typeof location === 'undefined') return '/sign-in';
  const q = new URLSearchParams(location.search);
  q.set(FREE_WATCH_PARAM, '1');
  const back = `${location.pathname}?${q.toString()}`;
  return `/sign-in?redirect_url=${encodeURIComponent(back)}`;
}

/** True when the post-login target is a free-event page (an /book/<id> path with the marker). */
export function isFreeWatchTarget(target: string): boolean {
  try {
    const u = new URL(target, typeof location !== 'undefined' ? location.origin : BRAND.webOrigin);
    return /^\/book\/[^/]+\/?$/.test(u.pathname) && u.searchParams.get(FREE_WATCH_PARAM) === '1';
  } catch {
    return false;
  }
}
