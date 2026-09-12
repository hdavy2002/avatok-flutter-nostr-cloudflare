// Canonical web path helpers.
//
// Keep the route rules in one place so browser links, redirects and canonical
// tags stay aligned across the public site.

/** Canonical public listing URL. Falls back to /l/<id> when no slugged URL exists. */
export function listingPath(opts: {
  id: string;
  handle?: string | null;
  slug?: string | null;
}): string {
  const handle = opts.handle?.trim();
  const slug = opts.slug?.trim();
  if (handle && slug) return `/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
  return `/l/${encodeURIComponent(opts.id)}`;
}

/** Canonical creator profile URL. */
export function creatorPath(handleOrId: string): string {
  return `/c/${encodeURIComponent(handleOrId)}`;
}

/** Canonical browser page for a booking/session id. */
export function sessionPath(bookingId: string): string {
  return `/session/${encodeURIComponent(bookingId)}`;
}

/** Canonical browser page for a paid live listing. */
export function livePath(listingId: string): string {
  return `/live/${encodeURIComponent(listingId)}`;
}

/** Legacy browser resolver for old emailed join links. */
export function joinPath(token: string): string {
  return `/j/${encodeURIComponent(token)}`;
}

/**
 * [APP-ONLY-TX-1 2026-09-12] Creator-side deep link into the avaTOK app.
 *
 * RULEBOOK-PAID-SESSIONS §7: all transmission is from the app, so a
 * creator-facing button on the website may only hand off to the app — never
 * open a browser hosting surface. Both shapes are already parsed by
 * `app/lib/core/deep_links.dart` (`liveEvent`, `commercialSession`); the
 * https:// twins are Android App Links (AndroidManifest `/live/`, `/session`),
 * which is why the custom scheme is used here — the browser is already sitting
 * on the https URL.
 */
export function appSessionDeepLink(opts: {
  kind: 'live_event' | 'consult_1to1' | string;
  listingId?: string | null;
  bookingId?: string | null;
}): string | null {
  if (opts.kind === 'live_event' && opts.listingId) return `avatok://live/${encodeURIComponent(opts.listingId)}`;
  if (opts.bookingId) return `avatok://session/${encodeURIComponent(opts.bookingId)}`;
  if (opts.listingId) return `avatok://session?listing_id=${encodeURIComponent(opts.listingId)}`;
  return null;
}

/**
 * [JOIN-LINK-1] `?return=<path>` — where checkout should send the buyer once he
 * has paid, so "Pay and join" really does end in the room he was trying to enter
 * rather than in a bookings list.
 *
 * This value rides in a URL and comes back through a payment gateway, so it is
 * attacker-controlled by construction. Only a room path on THIS origin is ever
 * honoured: no scheme, no host, no protocol-relative `//evil.example`, no query
 * or fragment. Anything else returns null and the caller falls back to its own
 * default — an open redirect out of a checkout confirmation is exactly the kind
 * of thing a phishing page is built on.
 */
const RETURN_RE = /^\/(?:live|session|consult)\/[A-Za-z0-9._~:-]{1,128}$/;

export function safeReturnPath(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || v.startsWith('//')) return null;
  return RETURN_RE.test(v) ? v : null;
}

/** The validated `?return=` of the page currently open, or null. */
export function readReturnParam(): string | null {
  try {
    if (typeof location === 'undefined') return null;
    return safeReturnPath(new URLSearchParams(location.search).get('return'));
  } catch {
    return null;
  }
}

/** Checkout URL for a listing, carrying the room to come back to. */
export function payAndJoinPath(listingId: string, returnTo?: string | null): string {
  const ret = safeReturnPath(returnTo);
  const base = `/book/${encodeURIComponent(listingId)}`;
  return ret ? `${base}?return=${encodeURIComponent(ret)}` : base;
}
