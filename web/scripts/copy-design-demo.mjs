// [DEMO-LISTING-1 2026-08-26] Stage the bazaar listing-details mockup so the
// /<username>/<slug> route can serve it. ONE file, into src/generated/, and
// deliberately NOT into public/.
//
// ─── WHY NOT public/ — THE 100-RULE _routes.json CEILING ─────────────────────
// Cloudflare Pages allows at most 100 rules across include+exclude in
// _routes.json, and Astro emits one exclude per static asset. This site was
// already sitting at ~100. Dropping the 11 mockup files (pages, support.js,
// assets/) into public/ pushed it to 102, and the failure mode is vicious:
//   * the deploy dies with "Failed to publish your Function. Got error: Unknown
//     internal error occurred." — no mention of routes, no mention of a limit;
//   * when it does publish, the overflowed paths are no longer excluded, so
//     /demo/* resolves to the Function instead of the static file. The Function
//     fetched that same URL, re-entered itself, and Cloudflare killed the loop
//     with a bare 502.
// Neither symptom names the cause. Do not "simplify" this back into public/.
//
// The runtime assets the mockup needs — support.js, the <dc-import> components,
// assets/*.png — are served from the avatok-design Pages project instead, via a
// <base> tag in the route. That project is published by design-preview.yml from
// this same folder, so the two stay in step; if it is ever torn down, the route
// loses its styling and this is the coupling to look at.
import { cp, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'design', 'live-streaming', 'avaTOK Listing Details.dc.html');
const DEST_DIR = join(here, '..', 'src', 'generated');
const DEST = join(DEST_DIR, 'listing-details.dc.html');

try {
  await access(SRC);
} catch {
  // Fail loudly: a missing source means an incomplete checkout, not "demo off".
  console.error(`[copy-design-demo] source missing: ${SRC}`);
  process.exit(1);
}

await mkdir(DEST_DIR, { recursive: true });
await cp(SRC, DEST);

console.log('[copy-design-demo] staged listing-details.dc.html -> web/src/generated/');
