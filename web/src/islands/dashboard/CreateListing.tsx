/* CreateListing — mounts the 8-step listing wizard (step 1: Type).
 *
 * [LIST-WEB-FORM-1] → [LIST-WIZ-1] This file used to BE the one-page form (type,
 * title, one-liner, price, category, start, length, language, location, 18+) that
 * could create a draft but could not fill in anything the details page renders —
 * how-it-works, house rules, FAQ, join requirements, commercial policy, vibe tags,
 * schedule shape. All of that content now has a server contract
 * (worker/src/routes/listings.ts: listingContentFieldsError, contentAttrsError,
 * commercialPolicyError — spec Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md
 * §F) and nowhere on the web to enter it. The wizard in `listing-form/` is that
 * surface; this file is now just the mount point for /dashboard/listings/new.
 *
 * ?id= still opens the wizard on an existing draft (edit), same as before.
 */
import { ListingWizard } from './listing-form/ListingWizard';
import { IslandBoundary } from '../../components/IslandBoundary';

/*
 * [LIST-WEB-GATE-1 2026-08-30] NO CLIENT-SIDE ACCOUNT GATE HERE, DELIBERATELY.
 *
 * An earlier pass wrapped this island in <RequireAccount> because the file header had
 * always CLAIMED it was gated and it was not. That broke the page in two different ways,
 * neither visible to the typechecker or the build — only in a browser, on the live site:
 *
 *   1. <RequireAccount> mounts <ClerkIsland> -> <ClerkProvider>. SidebarUser already
 *      mounts one on every dashboard page (see islands/shell/SidebarUser.tsx:15, which
 *      says so in as many words). Clerk's provider check is global, not per React root,
 *      so the second one threw "You've added multiple <ClerkProvider> components" and the
 *      WHOLE island failed to render: the New Listing page showed a heading and no form.
 *
 *   2. Dropping the provider (RequireAccountInline) moved the failure rather than fixing
 *      it. Astro islands are SEPARATE React roots, so this island is not inside
 *      SidebarUser's provider — and the gate's own <SignInButton> then threw
 *      "SignInButton can only be used within <ClerkProvider>".
 *
 * The gate was also solving nothing. /dashboard/* is reached only when signed in, every
 * call this island makes carries a bearer token, and the WORKER rejects an unauthenticated
 * create outright. The server is the authority; a client gate here was decoration that
 * cost the page its form.
 */
export function CreateListing() {
  return (
    <IslandBoundary island="dashboard-create-listing">
      <ListingWizard />
    </IslandBoundary>
  );
}

export default CreateListing;
