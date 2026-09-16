import { getListingReviews, getListingSlots, getExplore, getCreator } from './apiClient';
import { withDeadline } from './requestDeadline';
import type { Listing } from './types';

/** All optional public reads share a 1.5s ceiling, rather than four serial waits.
 * No token/cookies are forwarded into these publicly cached page companions. */
export async function getListingCompanions(listing: Listing) {
  const [reviewList, slots, page, creatorProfile] = await Promise.all([
    withDeadline((signal) => getListingReviews(listing.id, {}, signal), 1500).catch(() => null),
    withDeadline((signal) => getListingSlots(listing.id, signal), 1500).catch(() => null),
    withDeadline((signal) => getExplore({ section: listing.section ?? undefined, category: listing.category ?? undefined, limit: 9 }, signal), 1500).catch(() => null),
    listing.creator?.uid
      ? withDeadline((signal) => getCreator(listing.creator!.uid!, undefined, signal), 1500).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { reviewList, slots, browseMore: page?.listings ?? [], creatorProfile, creatorListings: creatorProfile?.listings ?? [] };
}
