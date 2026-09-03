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
