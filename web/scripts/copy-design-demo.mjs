// [DEMO-LISTING-1 / DEMO-MARKET-1 2026-08-26] Stage the bazaar design comps so
// the routes that serve them can inline the markup. Into src/generated/, and
// deliberately NOT into public/.
//
// ─── WHY NOT public/ — THE 100-RULE _routes.json CEILING ─────────────────────
// Cloudflare Pages allows at most 100 rules across include+exclude in
// _routes.json, and Astro emits one exclude per static asset. This site was
// already sitting at ~100. Dropping the mockup files (pages, support.js,
// assets/) into public/ pushed it to 102, and the failure mode is vicious:
//   * the deploy dies with "Failed to publish your Function. Got error: Unknown
//     internal error occurred." — no mention of routes, no mention of a limit;
//   * when it does publish, the overflowed paths are no longer excluded, so
//     /demo/* resolves to the Function instead of the static file. The Function
//     fetched that same URL, re-entered itself, and Cloudflare killed the loop
//     with a bare 502.
// Neither symptom names the cause. Do not "simplify" this back into public/.
//
// The runtime assets each comp needs — support.js, the <dc-import> components,
// assets/*.png — come from the avatok-design Pages project instead, via a <base>
// tag (see src/lib/mockupPage.ts). That project is published by
// design-preview.yml from this same folder, so the two stay in step.
//
// ─── ONE SOURCE FOLDER, ON PURPOSE ──────────────────────────────────────────
// Everything is staged from design/live-streaming/. design/marketplace/ is a
// re-export of the identical kit (verified 2026-08-26: byte-for-byte the same
// apart from edits made here), so treating it as a second source would mean two
// copies of the same 7MB free to drift, and a coin-flip over which one a given
// route rendered.
import { cp, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..', '..', 'design', 'live-streaming');
const DEST_DIR = join(here, '..', 'src', 'generated');

const PAGES = [
  ['avaTOK Listing Details.dc.html', 'listing-details.dc.html'],
  ['avaTOK Marketplace.dc.html', 'marketplace.dc.html'],
  ['avaTOK Creator Profile.dc.html', 'creator-profile.dc.html'],
];

await mkdir(DEST_DIR, { recursive: true });

for (const [from, to] of PAGES) {
  const src = join(SRC_DIR, from);
  try {
    await access(src);
  } catch {
    // Fail loudly: a missing source means an incomplete checkout, not "demo off".
    console.error(`[copy-design-demo] source missing: ${src}`);
    process.exit(1);
  }
  await cp(src, join(DEST_DIR, to));
}

console.log(`[copy-design-demo] staged ${PAGES.length} comps -> web/src/generated/`);
