// [LIST-DETAIL-1] Fixes a silent envelope mismatch that predates this task and that
// blocks every field this task is asked to render.
//
// THE BUG: `apiClient.getListing()` is typed `Promise<Listing>`, but the Worker's
// actual response body (worker/src/routes/listings.ts, function getListing, the
// `return json({ listing: {...}, creator_stats, reviews, viewer })` at the end) is
//
//   { listing: { id, title, price, cover_media, starts_at, ... }, creator_stats,
//     reviews, viewer }
//
// — every Card-level field (id, title, price, cover_media, starts_at, duration_min,
// capacity, spoken_lang, attrs, video_url, intent, price_semantics, ...) lives UNDER
// `.listing`, not at the top level the `Listing` type promises. `creator_stats`,
// `reviews` and `viewer` happen to also be declared as top-level `Listing` fields, so
// TypeScript never complained — but `listing.title`, `listing.price`, `listing.poster`
// etc. have been silently `undefined` in production. That is the real reason the
// public/dashboard detail pages "throw away most of what the API sends": nothing
// downstream of the fetch ever saw it.
//
// FIX SCOPE: neither `web/src/lib/apiClient.ts` nor
// `web/src/pages/dashboard/l/[id].astro` is in this task's editable file list, so the
// unwrap can't happen at the fetch call or in the dashboard page. This is the one
// normalization point both callers can share: `pages/l/[id].astro` calls it once
// (also fixing the OpenGraph tags, which read the same broken shape), and
// `ListingDetailView.astro` calls it again defensively so the dashboard route — which
// still calls the raw, un-normalized `getListing()` — renders correctly without being
// touched directly. Idempotent: an already-flat `Listing` (a hand-built mock, or a
// future apiClient fix) passes through unchanged.
import type { CreatorStats, Listing, Review } from '../../lib/types';

export function normalizeListing(input: unknown): Listing {
  const raw = (input ?? {}) as Record<string, unknown> & { listing?: Record<string, unknown> };
  const inner = raw.listing && typeof raw.listing === 'object' ? raw.listing : null;
  if (!inner) return raw as unknown as Listing;
  return {
    ...(inner as unknown as Listing),
    creator_stats: (raw.creator_stats as CreatorStats | null | undefined) ?? (inner.creator_stats as CreatorStats | null | undefined) ?? null,
    reviews: (raw.reviews as Review[] | undefined) ?? (inner.reviews as Review[] | undefined) ?? [],
    viewer: (raw.viewer as Listing['viewer'] | undefined) ?? (inner.viewer as Listing['viewer'] | undefined),
  };
}
