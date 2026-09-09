/* [LIST-DETAIL-EMBED-1 2026-09-09] The host bridge, on every page the app's
 * WebView opens.
 *
 * WHY IT LIVES IN THE LAYOUT AND NOT ON A PAGE. [LIST-EMBED-1] installed the
 * bridge from the one island that owned the one embedded route
 * (islands/dashboard/EmbeddedCreateListing.tsx → /embed/listing). The listing
 * DETAILS page is not one route: the app opens `/l/<id>`, the site 301s it to
 * `/<handle>/<slug>`, the buyer taps Book and lands on `/book/<id>`, and
 * checkout hands off and comes back to `/pay/return`. Wiring four pages by hand
 * would leave the fifth one — the one added next month — silently signed out.
 * Base.astro mounts this whenever the request carries the app's UA marker, so
 * "embedded" is a property of the WebView, not of a URL list.
 *
 * WHAT IT RENDERS: nothing. It exists for two side effects — installing the
 * token provider `lib/clerk.tsx:getActiveToken()` prefers, and sending the one
 * `ready` message the host's watchdog waits for.
 *
 * NO CLERK PROVIDER HERE, deliberately. This mounts on pages that already own
 * their own Clerk island, and a second <ClerkProvider> throws (see
 * CreateListing.tsx). There is no session to provide inside the WebView anyway
 * — that is the whole point of the bridge.
 *
 * `useState(initialiser)` and not `useEffect`: the initialiser runs during
 * render, so a sibling island's first fetch is more likely to find the provider
 * already there. It is not a guarantee — islands hydrate independently — which
 * is why getActiveToken() also self-installs. Both, because neither alone is
 * enough: this gets `ready` out promptly on a page that never needs a token,
 * and that covers the island that asks for one first.
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
      /* not embedded after all (a crawler faking the UA, no window) — no-op */
    }
    return null;
  });
  return null;
}
