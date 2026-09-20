// [06-FREEZE-AVATOK] Zero-dependency smoke test for postprocess-dist.mjs's
// pure functions. Run with plain `node` — no npm install needed, so it can
// run in this sandbox where installing web/'s dependencies is off-limits.
//
// Usage: node tool/avatok-freeze/postprocess-dist.test.mjs

import assert from 'node:assert/strict';
import { isDeadHref, stripDeadAnchors, ensureNoindex } from './postprocess-dist.mjs';

// --- isDeadHref: prefix boundary matching ------------------------------
assert.equal(isDeadHref('/sign-up'), true);
assert.equal(isDeadHref('/sign-up?role=creator&country=global'), true);
assert.equal(isDeadHref('/marketplace'), true);
assert.equal(isDeadHref('/marketplace?group=india_goes_live'), true);
assert.equal(isDeadHref('/india'), true);
assert.equal(isDeadHref('/dashboard'), true);
assert.equal(isDeadHref('/dashboard/wallet'), true);

// Collisions that MUST survive — real static pages that share a prefix with
// a dropped route.
assert.equal(isDeadHref('/india-next'), false);
assert.equal(isDeadHref('/payouts'), false);
assert.equal(isDeadHref('/consultation-terms'), false);
assert.equal(isDeadHref('/marketplace-terms'), false);
assert.equal(isDeadHref('/careers'), false);
assert.equal(isDeadHref('/pricing-fees'), false);

// Unrelated hrefs untouched.
assert.equal(isDeadHref('/about'), false);
assert.equal(isDeadHref('#pricing'), false);
assert.equal(isDeadHref('https://play.google.com/store/apps/details?id=com.saathum.app'), false);
assert.equal(isDeadHref('mailto:hello@avatok.ai'), false);

console.log('isDeadHref: OK');

// --- stripDeadAnchors ----------------------------------------------------
{
  const html =
    '<p>Before</p>' +
    '<a data-i18n="x" class="rail-button" href="/sign-up" data-home-cta="hero-create">Start earning free</a>' +
    '<a class="idea-market-link" href="/marketplace" data-ideas-cta="marketplace">Explore the marketplace ↗</a>' +
    '<a href="/payouts">How payouts work</a>' +
    '<p>After</p>';
  const { html: out, count } = stripDeadAnchors(html);
  assert.equal(count, 2, 'exactly the two dead anchors are rewritten');
  assert.match(out, /<span class="frozen-disabled-link">Start earning free<\/span>/);
  assert.match(out, /<span class="frozen-disabled-link">Explore the marketplace/);
  assert.match(out, /<a href="\/payouts">How payouts work<\/a>/, 'live route left untouched');
  assert.doesNotMatch(out, /href="\/sign-up"/);
  assert.doesNotMatch(out, /href="\/marketplace"/);
  assert.match(out, /^<p>Before<\/p>/);
  assert.match(out, /<p>After<\/p>$/);
}
console.log('stripDeadAnchors: OK');

// --- ensureNoindex ---------------------------------------------------------
{
  const already = '<head><meta name="robots" content="noindex, nofollow"></head>';
  assert.equal(ensureNoindex(already).changed, false);

  const wrongValue = '<head><meta name="robots" content="index, follow"></head>';
  const fixed = ensureNoindex(wrongValue);
  assert.equal(fixed.changed, true);
  assert.match(fixed.html, /noindex, nofollow/);

  const missing = '<head><title>x</title></head>';
  const inserted = ensureNoindex(missing);
  assert.equal(inserted.changed, true);
  assert.match(inserted.html, /<meta name="robots" content="noindex, nofollow">\s*<\/head>/);
}
console.log('ensureNoindex: OK');

console.log('\nAll postprocess-dist.mjs unit tests passed.');
