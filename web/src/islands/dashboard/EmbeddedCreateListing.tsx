/* [LIST-EMBED-1 2026-09-05] The listing wizard as the app's WebView sees it.
 *
 * Same component as /dashboard/listings/new — deliberately. This file adds
 * exactly two things and nothing else:
 *
 *   1. The host token bridge, installed BEFORE the wizard mounts. ListingWizard
 *      fires authenticated reads (`/api/listings/mine` for the free-entry gate,
 *      `?id=` hydration) from its very first effect, so installing this in an
 *      effect of our own would race those and hand them a null token — a form
 *      that opens with an error banner on a perfectly good session.
 *      `useState(initialiser)` runs during render, before any child effect.
 *
 *   2. No Clerk provider. See CreateListing.tsx's header for what a second
 *      <ClerkProvider> does to this page; here there is no session to provide
 *      anyway.
 *
 * If someone opens this URL in a normal browser the bridge no-ops (isEmbedded
 * requires the native channel, not just the query param) and the wizard falls
 * back to the ordinary Clerk path, so the route degrades to a chrome-less
 * version of the normal form rather than breaking.
 */
import { useState } from 'react';
import { ListingWizard } from './listing-form/ListingWizard';
import { IslandBoundary } from '../../components/IslandBoundary';
import { installEmbedBridge } from '../../lib/embed';
import { setHostTokenProvider } from '../../lib/clerk';

export function EmbeddedCreateListing() {
  useState(() => {
    setHostTokenProvider(installEmbedBridge());
    return null;
  });
  return (
    <IslandBoundary island="embed-create-listing">
      <ListingWizard />
    </IslandBoundary>
  );
}

export default EmbeddedCreateListing;
