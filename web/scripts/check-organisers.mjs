// [SHV2-S10] /organisers was removed by the owner (2026-09-26) — the page now
// redirects home (301) rather than rendering content, matching the pattern
// already used for dmca.astro, child-safety.astro, etc. Those pages carry no
// dedicated smoke check at all; this one stays only as a lightweight guard
// that the redirect (and the non-prerendered build output it depends on)
// hasn't silently regressed. Invoked from check-homepage.mjs so it rides that
// existing CI step without a new workflow trigger — see the note there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync('src/pages/organisers.astro', 'utf8');
assert.match(
  source,
  /export const prerender = false;/,
  '/organisers must not be statically prerendered (Cloudflare serves a prerendered file before consulting _redirects)'
);
assert.match(source, /const REMOVED = true;/, '/organisers redirect guard is active');
assert.match(source, /Astro\.redirect\('\/', 301\)/, '/organisers redirects home with a 301');

// Regression guard: a prerendered static file for this route would mean
// Cloudflare serves it ahead of the redirect, silently undoing the removal.
const builtPath = resolve('dist', 'organisers/index.html');
assert(!existsSync(builtPath), '/organisers must not exist as a static file in the production build');

console.log('/organisers checks passed: page redirects home (301), matching the dmca.astro removal pattern.');
