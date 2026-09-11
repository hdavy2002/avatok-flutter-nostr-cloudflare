// [WEB-HELP-1 2026-09-11] Post-build smoke check for the help centre: landing
// page shape, search index integrity, internal link resolution (both
// /help/... links and /#anchor links back to the homepage), no leftover
// placeholder text, and that FAQPage structured data appears only on the
// landing page. Same shape as check-homepage.mjs: assert with a clear
// message, exit non-zero on any failure, print one OK summary on success.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve('dist');
const helpRoot = resolve(root, 'help');

// --- Landing page -----------------------------------------------------
const landingPath = resolve(helpRoot, 'index.html');
assert(existsSync(landingPath), 'Missing dist/help/index.html');
const landing = readFileSync(landingPath, 'utf8');
assert.equal((landing.match(/<h1[ >]/g) || []).length, 1, 'Help landing page must have exactly one <h1>');
assert.equal(
  (landing.match(/"@type":"FAQPage"/g) || []).length,
  1,
  'Help landing page must contain "@type":"FAQPage" exactly once',
);

// --- search.json --------------------------------------------------------
const searchPath = resolve(helpRoot, 'search.json');
assert(existsSync(searchPath), 'Missing dist/help/search.json');
const searchRaw = readFileSync(searchPath, 'utf8');
const searchBytes = Buffer.byteLength(searchRaw, 'utf8');
assert(searchBytes < 250 * 1024, `search.json must be < 250 KB, got ${searchBytes} bytes`);
let searchDocs;
try {
  searchDocs = JSON.parse(searchRaw);
} catch (err) {
  throw new Error('search.json failed to parse: ' + err.message);
}
assert(Array.isArray(searchDocs), 'search.json must be an array');
assert(searchDocs.length >= 15, `search.json must have >= 15 entries, got ${searchDocs.length}`);
for (const doc of searchDocs) {
  assert(typeof doc.url === 'string' && doc.url.startsWith('/'), 'search.json entry missing a valid url: ' + JSON.stringify(doc));
  const target = resolve(root, '.' + doc.url, 'index.html');
  assert(existsSync(target), 'search.json url does not resolve to a built file: ' + doc.url);
}

// --- Homepage anchors, for /#anchor link checks below --------------------
const homepageHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const homepageIds = new Set([...homepageHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// [WEB-HELP-1] Landing-page ids, for /help#x link checks below — a link like
// href="/help#billing" resolves to a BUILT FILE (dist/help/index.html
// exists) even when "billing" isn't an id on that page, so the plain
// existsSync check above silently let a broken in-page anchor through.
const landingIds = new Set([...landing.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// --- Walk every built help HTML page -------------------------------------
function walkHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// [WEB-HELP-1] The four policy pages (tokens/refunds/payouts/pricing-fees)
// carry a `helpHref` deep link (Content.astro's help-crosslink callout) plus
// their own /help#billing-style landing anchors — check them for the same
// two link classes as the help pages themselves, since a broken link there
// is just as real as one inside /help. Each page must actually exist AND
// render the crosslink (not just build) — a missing `helpHref` prop would
// build fine and pass silently otherwise.
const POLICY_PAGES = ['tokens', 'refunds', 'payouts', 'pricing-fees'];
const policyHtmlFiles = POLICY_PAGES.map((slug) => resolve(root, slug, 'index.html'));
for (const file of policyHtmlFiles) {
  assert(existsSync(file), `Missing built policy page: ${file}`);
  const html = readFileSync(file, 'utf8');
  assert(html.includes('class="help-crosslink"'), `Policy page missing the help-centre crosslink: ${file}`);
}

const helpHtmlFiles = walkHtmlFiles(helpRoot);
assert(helpHtmlFiles.length > 0, 'No built HTML files found under dist/help');

/** Checks common to every help + policy page: /help#x anchors and /help/... deep links. */
function checkHelpLinks(file, html) {
  // Every /help#x href must resolve to an id on the landing page (not just
  // to dist/help/index.html existing).
  for (const match of html.matchAll(/href="(\/help#[^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    const anchor = href.slice('/help#'.length).split('?')[0];
    assert(landingIds.has(anchor), `Broken /help#${anchor} link (no matching landing-page id) in ${file}`);
  }

  // Every /help/... href (a deep link into an article) must resolve to a built file.
  for (const match of html.matchAll(/href="(\/help\/[^"#?]+)/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    const target = resolve(root, '.' + href, 'index.html');
    assert(existsSync(target), `Broken /help link in ${file}: ${href}`);
  }

  // Every /#anchor href must resolve to an id on the homepage.
  for (const match of html.matchAll(/href="(\/#[^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    const anchor = href.slice(2).split('?')[0];
    assert(homepageIds.has(anchor), `Broken /#${anchor} link (no matching homepage id) in ${file}`);
  }
}

for (const file of policyHtmlFiles) {
  const html = readFileSync(file, 'utf8');
  checkHelpLinks(file, html);
}

let articleCount = 0;
for (const file of helpHtmlFiles) {
  const html = readFileSync(file, 'utf8');
  const isLanding = file === landingPath;

  // No leftover placeholder text outside of HTML comments.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(withoutComments, /TODO/i, 'Help page contains TODO: ' + file);
  assert.doesNotMatch(withoutComments, /lorem/i, 'Help page contains lorem: ' + file);
  assert.doesNotMatch(withoutComments, /FIXME/i, 'Help page contains FIXME: ' + file);

  checkHelpLinks(file, html);

  if (!isLanding) {
    // Article pages: exactly one <h1>, never carry FAQPage structured data,
    // and exactly one BreadcrumbList (Help.astro emits it once per article).
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'Article must have exactly one <h1>: ' + file);
    assert.equal(
      (html.match(/"@type":"FAQPage"/g) || []).length,
      0,
      'Article page must not contain FAQPage structured data: ' + file,
    );
    assert.equal(
      (html.match(/"@type":"BreadcrumbList"/g) || []).length,
      1,
      'Non-landing help page must contain "@type":"BreadcrumbList" exactly once: ' + file,
    );
    articleCount++;
  }
}

console.log(
  `Help centre smoke checks passed: landing page OK, search.json ${searchDocs.length} entries ` +
    `(${(searchBytes / 1024).toFixed(1)} KB), ${helpHtmlFiles.length} built pages + ${policyHtmlFiles.length} policy pages checked ` +
    `(${articleCount} articles), all /help, /help#, and /#anchor links resolved, no placeholder text, ` +
    `FAQPage present once, BreadcrumbList present once per article.`,
);
