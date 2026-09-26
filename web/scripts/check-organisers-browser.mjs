// [SAATHUM-ENTITY-1 2026-09-26] /organisers now redirects home instead of
// rendering content (see organisers.astro / check-organisers.mjs). The rich
// layout/interaction checks that used to live here no longer apply; this
// just confirms the redirect actually fires end-to-end through the browser,
// the same way dmca.astro carries no dedicated browser check at all.
import assert from 'node:assert/strict';

export async function checkOrganisersBrowser(browser) {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4179/organisers/', { waitUntil: 'networkidle' });
  assert.equal(page.url(), 'http://127.0.0.1:4179/', '/organisers redirects home, matching the dmca.astro pattern');
  console.log('organisers redirect-to-home check passed.');
  await page.close();
}
