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

// --- [WEB-HELP-2 2026-09-11] Help-art image references -------------------
// Every /help/art/<name> a built help page points at (the section stamp,
// the "Related policies" kettle sticker) must actually be a built file —
// catches a renamed/deleted asset in web/public/help/art that the page
// still references.
let artRefCount = 0;
for (const file of helpHtmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/src="(\/help\/art\/[^"]+)"/g)) {
    const src = match[1].replaceAll('&amp;', '&');
    const target = resolve(root, '.' + src);
    assert(existsSync(target), `Broken /help/art image in ${file}: ${src}`);
    artRefCount++;
  }
}

// --- [WEB-HELP-2] No font-relative rootMargin in built JS -----------------
// IntersectionObserver's rootMargin accepts only px/% (a font-relative unit
// like rem/em throws at construction) — this bit HelpOnThisPage.astro's
// scroll-spy once already. Scan every built JS chunk for a rootMargin
// string carrying "rem" so that mistake can't ship silently again.
const astroDir = resolve(root, '_astro');
const jsFiles = existsSync(astroDir)
  ? readdirSync(astroDir).filter((f) => f.endsWith('.js')).map((f) => resolve(astroDir, f))
  : [];
const ROOT_MARGIN_REM = /rootMargin\s*:\s*["'`][^"'`]*rem[^"'`]*["'`]/;
for (const file of jsFiles) {
  const js = readFileSync(file, 'utf8');
  assert.doesNotMatch(
    js,
    ROOT_MARGIN_REM,
    `Built JS chunk uses a font-relative unit in an IntersectionObserver rootMargin (must be px/%): ${file}`,
  );
}

// --- [WEB-HELP-2] Every var(--x) a help page's CSS consumes is defined ----
// somewhere in that SAME built CSS file — catches a custom property that
// looks defined in source (e.g. it lives in ava-tokens.css) but whose
// import silently drops out of the production bundle, so the property
// resolves to nothing at runtime (the exact bug the --ava-* alias block in
// Help.astro's <style> works around). Allowlist: `--tilt-*` and `--tile-*`
// (both set inline, per-element, via a `style="--x:...;"` attribute on the
// markup itself — HelpTiles.astro's `--tile-bg`/`--tile-band` included —
// never in a stylesheet, so "not defined in any linked CSS" is expected for
// these) and `--tw-shadow-color` (Tailwind's own internal plumbing, defined
// by its runtime elsewhere). A `var(--x, <fallback>)` call is exempt too —
// it degrades on its own.
const VAR_ALLOWLIST_PREFIX = ['--tilt-', '--tile-'];
const VAR_ALLOWLIST_EXACT = new Set(['--tw-shadow-color']);
const cssTextCache = new Map();
function readCss(hrefPath) {
  if (!cssTextCache.has(hrefPath)) {
    const target = resolve(root, '.' + hrefPath);
    cssTextCache.set(hrefPath, existsSync(target) ? readFileSync(target, 'utf8') : null);
  }
  return cssTextCache.get(hrefPath);
}
let cssFilesChecked = 0;
for (const file of helpHtmlFiles) {
  const html = readFileSync(file, 'utf8');
  const cssHrefs = new Set(
    [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((m) =>
      m[1].replaceAll('&amp;', '&'),
    ),
  );
  // [WEB-HELP-2] A custom property can legitimately be USED in one built CSS
  // chunk and DEFINED in another chunk that Astro split it into — e.g. a
  // page-level chunk consumes a name that a shared/base chunk defines. Both
  // chunks are always linked together on the same page (Astro never ships a
  // page a stylesheet it doesn't need), so the real question isn't "is this
  // name defined in THIS file" but "is it defined in ANY stylesheet this
  // page links" — combine every linked CSS file's text for the definedness
  // check, per-page, instead of checking each file in isolation.
  const combinedCss = [...cssHrefs].map((href) => {
    const css = readCss(href);
    assert(css !== null, `Help page ${file} links a stylesheet that isn't a built file: ${href}`);
    return css;
  }).join('\n');

  for (const href of cssHrefs) {
    const css = readCss(href);
    cssFilesChecked++;

    // Bare `var(--x)` uses — NOT `var(--x, ...)` calls, which carry their
    // own fallback and so are exempt by construction.
    const used = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)].map((m) => m[1]));
    for (const name of used) {
      if (VAR_ALLOWLIST_EXACT.has(name)) continue;
      if (VAR_ALLOWLIST_PREFIX.some((p) => name.startsWith(p))) continue;
      const definedPattern = new RegExp(`(?:^|[{;,\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
      assert(
        definedPattern.test(combinedCss),
        `${name} is used in ${href} (linked from ${file}) but never defined in any stylesheet that page links`,
      );
    }
  }
}

console.log(
  `Help centre smoke checks passed: landing page OK, search.json ${searchDocs.length} entries ` +
    `(${(searchBytes / 1024).toFixed(1)} KB), ${helpHtmlFiles.length} built pages + ${policyHtmlFiles.length} policy pages checked ` +
    `(${articleCount} articles), all /help, /help#, and /#anchor links resolved, no placeholder text, ` +
    `FAQPage present once, BreadcrumbList present once per article, ${artRefCount} /help/art image refs OK, ` +
    `${jsFiles.length} JS chunks checked for rem-based rootMargin, ${cssFilesChecked} help-page CSS files checked ` +
    `for undefined custom properties.`,
);
