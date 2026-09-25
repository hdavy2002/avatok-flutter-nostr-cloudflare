// [WEB-SEO-AUTO-1] Post-build contract for every crawlable HTML document.
// New public pages fail CI if they bypass the shared metadata/schema pipeline.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const dist = resolve('dist');
assert(existsSync(dist), 'Missing dist/; run after the Astro build');

function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.isFile() && entry.name.endsWith('.html') ? [path] : [];
  });
}

const value = (html, pattern) => html.match(pattern)?.[1]?.trim();
const seenCanonical = new Map();
let indexable = 0;

for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  const robots = value(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i)
    ?? value(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']robots["']/i);
  assert(robots, `Missing robots meta: ${relative(dist, file)}`);
  if (/\bnoindex\b/i.test(robots)) continue;
  indexable++;

  const canonical = value(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  assert(canonical?.startsWith('https://saathum.com/'), `Invalid canonical: ${relative(dist, file)}`);
  assert(!canonical.includes('?') && !canonical.includes('#'), `Canonical contains query/fragment: ${canonical}`);
  assert(!seenCanonical.has(canonical), `Duplicate canonical ${canonical}: ${seenCanonical.get(canonical)} and ${relative(dist, file)}`);
  seenCanonical.set(canonical, relative(dist, file));

  const required = [
    /<title[^>]*>[^<]+<\/title>/i,
    /<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["'][^"']+["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["'][^"']+["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https:\/\/saathum\.com\//i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']https:\/\/saathum\.com\//i,
    /<meta[^>]+name=["']twitter:card["'][^>]+content=["']summary_large_image["']/i,
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i,
  ];
  for (const pattern of required) assert.match(html, pattern, `Incomplete SEO head: ${relative(dist, file)}`);

  const ogImage = value(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogImage?.includes('/og/')) {
    assert.match(ogImage, /\.png\?v=[a-f0-9]{64}$/, `Generated OG image is not versioned: ${ogImage}`);
    assert.match(html, /property=["']og:image:width["'][^>]+content=["']1200["']/i);
    assert.match(html, /property=["']og:image:height["'][^>]+content=["']630["']/i);
  }
}

assert(indexable > 0, 'No indexable HTML pages found');
for (const output of ['sitemap-pages.xml', 'llms.txt', 'llms-rituals.txt']) {
  assert(existsSync(join(dist, output)), `Missing discovery output: ${output}`);
}
const sitemapPages = readFileSync(join(dist, 'sitemap-pages.xml'), 'utf8');
const sitemapLocations = new Set([...sitemapPages.matchAll(/<loc>(https:\/\/saathum\.com\/[^<]*)<\/loc>/g)].map((match) => match[1]));
for (const canonical of seenCanonical.keys()) {
  assert(sitemapLocations.has(canonical), `Indexable prerendered page missing from sitemap-pages.xml: ${canonical}`);
}
const sitemapIndexSource = readFileSync(resolve('src/pages/sitemap.xml.ts'), 'utf8');
assert(sitemapIndexSource.includes('/sitemap-directory.xml'), 'Sitemap index omits marketplace directory pages');
const directorySitemapSource = readFileSync(resolve('src/pages/sitemap-directory.xml.ts'), 'utf8');
assert(directorySitemapSource.includes('/marketplace/page/'), 'Directory sitemap does not enumerate directory canonicals');

// Dynamic public pages cannot appear in dist as HTML, so make route-family
// registration an explicit CI contract. Any future SSR page using Base content
// fails until its crawl feed/static sitemap coverage is declared here.
const dynamicCoverage = new Map([
  ['src/pages/marketplace.astro', 'sitemap-pages.xml'],
  ['src/pages/l/[id].astro', 'sitemap-listings.xml'],
  ['src/pages/[username]/[slug].astro', 'sitemap-listings.xml'],
  ['src/pages/c/[handle].astro', 'sitemap-creators.xml'],
  ['src/pages/marketplace/page/[page].astro', 'sitemap-directory.xml'],
]);
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith('.astro') ? [path] : [];
  });
}
for (const file of sourceFiles(resolve('src/pages'))) {
  const source = readFileSync(file, 'utf8');
  if (!/export\s+const\s+prerender\s*=\s*false/.test(source) || !/<Base\s+[^>]*content=/.test(source)) continue;
  const route = relative(resolve('.'), file);
  assert(dynamicCoverage.has(route), `Dynamic public route lacks declared sitemap coverage: ${route}`);
}
const robots = readFileSync(resolve('public/robots.txt'), 'utf8');
for (const crawler of ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot']) assert(robots.includes(`User-agent: ${crawler}`), `robots.txt missing ${crawler}`);

const fallback = readFileSync(resolve('public/seo/fallback.png'));
assert.equal(fallback.readUInt32BE(16), 1200, 'SEO fallback must be 1200px wide');
assert.equal(fallback.readUInt32BE(20), 630, 'SEO fallback must be 630px high');
console.log(`SEO contract OK: ${indexable} indexable pages, ${seenCanonical.size} unique canonicals.`);
