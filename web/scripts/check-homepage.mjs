// [HF-APPROVED-SCRAPBOOK-1] Approved source art + native HTML release contract. CI only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { normalizeBuiltImages, validateBuiltImageSources } from './built-image-source.mjs';
import { BRAND, reEscape } from './brand.mjs';
import { checkHelloFraandsPages } from './check-hello-fraands-pages.mjs';
function meta(page, key) {
  const tag = (page.match(/<meta\b[^>]*>/g) || []).find(t => t.includes('property="' + key + '"') || t.includes('name="' + key + '"'));
  return tag?.match(/content="([^"]*)"/)?.[1];
}
const root = resolve('dist');
validateBuiltImageSources(root);
const emittedHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const html = normalizeBuiltImages(emittedHtml, { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
const plainText = value => value.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/&#(?:39|x27);/g, "'").replace(/&#(?:8217|x2019);/g, '’').replace(/\s+/g, ' ').trim();
const visibleText = plainText(bodyHtml);
const main = bodyHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
const mainText = plainText(main);
const identity = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One native H1');
assert(bodyHtml.includes('aria-label="' + identity.name + ' home"') && bodyHtml.includes('logo.png'), 'Owner logo with central accessible brand identity');
for (const copy of [
  'Your favorite creators. One conversation away.',
  'Watch entertaining videos. Discover your kind of people. Book a private conversation.',
  'Your number stays private. The influencer’s does too.',
  'We call you both and connect the conversation.',
  'Watch. Discover. Say hello.',
  'Watch their videos', 'Find your favorite', 'We connect you both',
  'Big personalities. Real conversations.',
  'Don’t just follow. Connect.',
]) assert(mainText.includes(copy), 'Approved mock copy: ' + copy);
assert.match(visibleText, /illustrative|sample/i, 'Fictional creators are disclosed');
assert.match(visibleText, /no call|no payment|not.*book/i, 'Preview actions do not pretend to book');
assert.deepEqual([...main.matchAll(/data-home-section="([^"]+)"/g)].map(m => m[1]), ['hero','privacy','how-it-works','creators','connect'], 'Exact approved section order');
assert.deepEqual([...main.matchAll(/data-approved-creator="([^"]+)"/g)].map(m => m[1]), ['meera','kabir','ananya','rohan'], 'Exact four illustrative creators');
for (const name of ['Meera','Kabir','Ananya','Rohan','Lifestyle','Comedy','Music','Travel']) assert(mainText.includes(name), 'Approved creator label: ' + name);
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const ids = new Set(allIds);
assert.equal(ids.size, allIds.length, 'No duplicate IDs');
for (const id of ['main-content','people','moods','naye-dost','women-only','earn','how-it-works','safety','approved-preview-dialog']) assert(ids.has(id), 'Existing deep link: ' + id);
for (const m of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = m[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) assert(ids.has(href.split('#')[1]), 'Resolvable anchor: ' + href);
}
for (const href of ['/marketplace','/hosts/join','/sign-in','/about','/help','/privacy','/terms']) assert(bodyHtml.includes('href="' + href), 'Working destination: ' + href);
assert.equal((html.match(/<header\b[^>]*data-callvaal-chrome/g) || []).length, 1, 'One shared header');
assert.equal((html.match(/<footer\b[^>]*data-callvaal-chrome/g) || []).length, 1, 'One shared footer');
assert(meta(html, 'description')?.length > 40);
assert(meta(html, 'og:title')?.includes(identity.name));
assert(meta(html, 'og:description'));
const reference = readFileSync(resolve(root, 'assets/hf-approved-scrapbook/approved-reference.png'));
assert.equal(createHash('sha256').update(reference).digest('hex'), 'e70b996d45cd8557f07bbde3acbbbb8035669e71ef4589c9736d3fb6f6a2b312', 'Approved mock is byte-identical; no regenerated art');
const refMeta = await sharp(reference).metadata();
assert(refMeta.width > 1000 && refMeta.height > 1400, 'Full-resolution visual reference');
const artRoot = resolve(root, 'assets/hf-approved-scrapbook');
for (const [name, sha] of [['logo.png','4094f33216d4a333a2902f19e087a1224227cad2a1e66f6e4e3b387c0c273af4'], ['favicon.png','f45483b793af61ed73726854a456d2c0e5377cf35dbdcc6795e05920b8335103']]) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(artRoot, name))).digest('hex'), sha, 'Exact owner-supplied branding: ' + name);
}
const provenance = JSON.parse(readFileSync(resolve(artRoot, 'crop-manifest.json'), 'utf8'));
assert.equal(provenance.sourceSha256, createHash('sha256').update(reference).digest('hex'));
assert(provenance.crops.length >= 10, 'Original photos and Indian artwork extracted separately');
for (const crop of provenance.crops) {
  assert(!crop.file.includes('/') && crop.file.endsWith('.webp'), 'Bounded art filename');
  const bytes = readFileSync(resolve(artRoot, crop.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), crop.sha256, 'Source-derived artwork hash: ' + crop.file);
  const rect = crop.sourceRect;
  assert(rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= refMeta.width && rect.top + rect.height <= refMeta.height, 'Crop stays inside approved image: ' + crop.file);
  const art = await sharp(bytes).metadata();
  assert.equal(art.width, crop.width); assert.equal(art.height, crop.height);
}
const photos = [...main.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
assert(photos.length >= 5, 'Separate art and photographic placements, not a page screenshot');
for (const photo of photos) {
  assert.match(photo, /\balt="/, 'Every art placement has alt, including empty decorative alt');
  assert.match(photo, /\bwidth="/);
  assert.match(photo, /\bheight="/);
}
const source = readFileSync(resolve('src/pages/index.astro'), 'utf8');
assert(!/<img[^>]*src=\{?[^>]*approved-reference/.test(source), 'Whole-page reference cannot replace accessible HTML');
const css = readFileSync(resolve('src/styles/approved-scrapbook.css'), 'utf8');
assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\(/i, 'No gradients in approved landing design');
assert(!/<video\b/.test(main), 'Illustrative video art does not pretend an actual feed exists');
checkHelloFraandsPages(root, identity);
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m);
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m);
console.log('Approved scrapbook homepage: source art, HTML copy, privacy, navigation, preview integrity and content contracts passed.');

// [WEB-OLD-PAGES-GONE-1 2026-09-27] /archive/home-2026-09-09 and /global-ideas were DELETED
// by owner decision (they now answer 410 via src/middleware.ts), so their archive and
// global-artwork crop checks were removed. They are in git history if ever needed.
assert(!existsSync(resolve(root, 'archive/home-2026-09-09/index.html')), 'Deleted archive page is not rebuilt');
assert(!existsSync(resolve(root, 'global-ideas/index.html')), 'Deleted /global-ideas page is not rebuilt');

// Blog SSR content and retired routes are checked in check-og-runtime.mjs.
assert(!existsSync(resolve(root, 'ideas/index.html')), '/ideas is a redirect, not a prerendered page');
const sitemapIndexSource = readFileSync(resolve('src/pages/sitemap.xml.ts'), 'utf8');
assert.match(sitemapIndexSource, /<sitemapindex/, 'sitemap.xml is a sitemap index');
assert(sitemapIndexSource.includes('/sitemap-pages.xml'), 'Index lists sitemap-pages.xml');
const routesJson = JSON.parse(readFileSync(resolve(root, '_routes.json'), 'utf8'));
assert(routesJson.exclude.includes('/.well-known/*'), 'App Links stay static');
assert(!routesJson.exclude.includes('/rituals/*'), 'Retired articles reach the 410 handler');
assert(!routesJson.exclude.includes('/blog/*'), 'Unknown blog slugs reach the 410 handler');
assert(routesJson.include.length + routesJson.exclude.length <= 100, 'Cloudflare 100-rule ceiling');
for (const list of [routesJson.include, routesJson.exclude]) {
  const splats = list.filter(rule => rule.endsWith('/*')).map(rule => rule.slice(0, -1));
  for (const rule of list) assert(!splats.some(prefix => rule !== prefix + '*' && (rule.startsWith(prefix) || rule + '/' === prefix)), 'Overlapping route rule: ' + rule);
}
assert(!existsSync(resolve(root, 'rituals/index.html')), 'Retired index is not prerendered');
const sitemap = readFileSync(resolve(root, 'sitemap-pages.xml'), 'utf8');
assert(!sitemap.includes(BRAND.webOrigin + '/ideas<'), 'Retired ideas stay out of sitemap');
assert(!sitemap.includes(BRAND.webOrigin + '/organisers'), 'Archived organisers stay out of sitemap');
assert(!sitemap.includes(BRAND.webOrigin + '/rituals'), 'Retired rituals stay out of sitemap');
assert(sitemap.includes(BRAND.webOrigin + '/blog/'), 'Blog appears in sitemap');
assert(!sitemap.includes(BRAND.webOrigin + '/blog/creator-ideas/'), 'Retired blog articles stay out of sitemap');

// The promoted homepage has one accurate share preview and canonical URL (A4).
assert(meta(html, 'og:title').includes(identity.name), 'Homepage share identity follows the approved brand');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
const ogImageUrl = meta(html, 'og:image');
assert(ogImageUrl, 'Homepage has a share image');
assert(ogImageUrl.includes('/assets/hf-approved-scrapbook/'), 'Homepage shares its new host/fan artwork');
assert.doesNotMatch(ogImageUrl, /avatok-creator-constellation/, 'Share image is not the retired creator hero (A4.1, D10)');
assert.equal(meta(html, 'twitter:image'), ogImageUrl);
assert.match(html, new RegExp('<link\\b[^>]*rel="canonical"[^>]*href="' + reEscape(`https://${identity.domain}/`) + '"'), 'Homepage canonical is the root URL');
assert.equal(meta(html, 'og:url'), `https://${identity.domain}/`);
assert.doesNotMatch(sitemap, new RegExp('<loc>' + reEscape(BRAND.webOrigin) + '/india(?:-next)?/?</loc>'), 'Retired and preview routes stay out of the sitemap');
console.log('Homepage title, description, canonical and share image passed.');

// [SHV2-S10] Attach the new /organisers contract check to THIS existing CI
// step (web-deploy.yml release-contract aggregate; typecheck.yml
// "Check public homepage and help before deployment") instead of adding a
// new workflow trigger — B2 rule 8, S10 brief phase 1.
// [WEB-OLD-PAGES-GONE-1 2026-09-27] /organisers was DELETED (410), so check-organisers.mjs no longer runs.

// [WEB-SEO-REBRAND-1 2026-09-27] Brand-leak guard rides this same CI step.
// The aggregate release runner executes this independently so one homepage
// assertion cannot hide a brand-leak failure. Direct callers retain the guard.
if (process.env.CI_CONTRACT_AGGREGATE !== '1') {
  execFileSync(process.execPath, ['scripts/check-brand-leaks.mjs'], { stdio: 'inherit' });
}
