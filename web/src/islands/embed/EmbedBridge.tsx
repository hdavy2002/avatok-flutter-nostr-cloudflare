/* [LIST-DETAIL-EMBED-1 2026-09-09] NOT MOUNTED ANYWHERE — kept on disk on
 * purpose, like Nav.astro and BetaBanner.astro before it.
 *
 * This was the first shape of the app-WebView bridge: an island in Base.astro,
 * mounted when the request's user agent carried the app marker. Two things
 * killed it, and both are worth remembering before anyone re-mounts it.
 *
 *   1. Deciding ANYTHING server-side from the user agent poisoned the edge
 *      cache. `/l/<id>` is cached for 60s and Cloudflare's cache key ignores
 *      the UA, so whichever client missed the cache first decided what
 *      everyone got. Base.astro now ships one identical document to every
 *      client and hides the chrome in CSS — see its <head> for the full note.
 *
 *   2. Once nothing was conditional server-side, the island had no job left.
 *      Auth does not need it: lib/clerk.tsx:getActiveToken installs the token
 *      bridge on demand, which also removes the hydration race this island was
 *      trying to win. The host's `ready` handshake is a two-line inline script
 *      in Base.astro's <head>, which is strictly more reliable — it is the
 *      proof that the page loaded at all, and making that proof depend on
 *      React hydration puts it out of reach exactly when something is wrong.
 *
 * Re-mount it only if a page needs the bridge installed BEFORE its own islands
 * run for a reason `getActiveToken` cannot cover — and if you do, mount it from
 * the page, not from the layout, and do not reintroduce a server-side UA check.
 */
import { useState } from 'react';
import { installEmbedBridge } from '../../lib/embed';
import { setHostTokenProvider } from '../../lib/clerk';

export default function EmbedBridge() {
  useState(() => {
    try {
      const provider = installEmbedBridge();
      if (provider) setHostTokenProvider(provider);
    } catch {
      /* not embedded (no window, or a crawler faking the UA) — no-op */
    }
    return null;
  });
  return null;
}
