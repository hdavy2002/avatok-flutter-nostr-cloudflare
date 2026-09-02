/* ListingPublish — mounts the 8-step listing wizard, opened straight at
 * step 8 (Preview & publish) for an existing draft.
 *
 * [LIST-WEB-MEDIA-1] + [LIST-WEB-PUBLISH-1] → [LIST-WIZ-1] This file used to be
 * its own standalone panel: cover upload + a readiness checklist + Publish. That
 * screen still exists in spirit — it is step 8 of the wizard now
 * (listing-form/steps.tsx: Step8Preview) — because the checklist, the cover
 * upload flow and the publish call all needed to also be reachable from
 * /dashboard/listings/new once that flow grew to 8 steps, and having two
 * separate implementations of "upload a cover photo" or "check readiness" was
 * exactly the kind of drift this rewrite was meant to end.
 *
 * /dashboard/listings/publish?id=<id> keeps working unchanged: the wizard reads
 * ?id= itself and loads the existing draft's full content, not just its covers.
 */
import { useEffect, useState } from 'react';
import { ListingWizard } from './listing-form/ListingWizard';
import { IslandBoundary } from '../../components/IslandBoundary';

/*
 * [LIST-WEB-GATE-1 2026-08-30] NO CLIENT-SIDE ACCOUNT GATE HERE, DELIBERATELY —
 * see CreateListing.tsx for the full incident writeup (multiple <ClerkProvider>
 * roots breaking this exact island twice). /dashboard/* is reached only when
 * signed in, and every call here carries a bearer token the worker checks.
 */
export function ListingPublish() {
  const [hasId, setHasId] = useState<boolean | null>(null);
  useEffect(() => {
    try { setHasId(Boolean(new URLSearchParams(window.location.search).get('id'))); } catch { setHasId(false); }
  }, []);
  return (
    <IslandBoundary island="dashboard-listing-publish">
      {hasId === null ? null : !hasId ? <p className="font-body font-bold text-inkSoft">No listing selected.</p> : <ListingWizard startAtPublish />}
    </IslandBoundary>
  );
}

export default ListingPublish;
