// [HF-HOME-SHARP-2] Separate high-resolution portraits, native art and shared Explore chrome. CI only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { normalizeBuiltImages, validateBuiltImageSources } from './built-image-source.mjs';
import { BRAND, reEscape } from './brand.mjs';
import { checkHelloFraandsPages, footerGroups, footerRoutes } from './check-hello-fraands-pages.mjs';
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
const brandConfig = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8'));
const identity = brandConfig.homepageIdentity;
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
const dialog = bodyHtml.match(/<dialog\b[^>]*id="approved-preview-dialog"[^>]*>([\s\S]*?)<\/dialog>/)?.[1] || '';
assert.match(plainText(dialog), /illustrative|sample/i, 'Sample disclosure remains inside the interactive dialog');
assert.match(plainText(dialog), /no video plays/i, 'Dialog truthfully explains the video sample');
assert.match(plainText(dialog), /no video plays, call is booked or payment is taken|no call or payment|no call.*no payment/i, 'Preview actions do not pretend to book or charge');
assert.doesNotMatch(visibleText, /Design concept|Design preview · Illustrative creators/i, 'Removed design labels and disclosure paragraph stay removed');
assert(!idsFromMarkup(bodyHtml).includes('sample-disclosure'), 'Removed standalone sample paragraph stays removed');
assert.deepEqual([...main.matchAll(/data-home-section="([^"]+)"/g)].map(m => m[1]), ['hero','privacy','how-it-works','creators','connect','download'], 'Exact approved section order');
assert.deepEqual([...main.matchAll(/data-approved-creator="([^"]+)"/g)].map(m => m[1]), ['meera','kabir','ananya','rohan'], 'Exact four illustrative creators');
for (const name of ['Meera','Kabir','Ananya','Rohan','Lifestyle','Comedy','Music','Travel']) assert(mainText.includes(name), 'Approved creator label: ' + name);
function idsFromMarkup(markup) { return [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); }
const allIds = idsFromMarkup(html);
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
// Compare emitted links, labels and auth classes with Explore, so using the
// component name alone cannot hide a different home-only menu or footer branch.
const explore = normalizeBuiltImages(readFileSync(resolve(root, 'marketplace/index.html'), 'utf8'), { root });
const chrome = (markup, tag) => markup.match(new RegExp(`<${tag}\\b[^>]*data-callvaal-chrome[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0] || '';
const links = markup => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, label]) => ({
  href: attrs.match(/\bhref="([^"]+)"/)?.[1].replaceAll('&amp;', '&').replace(/^#/, '/#'),
  label: plainText(label),
  ariaLabel: attrs.match(/\baria-label="([^"]+)"/)?.[1] || '',
  auth: attrs.match(/cv-auth-(?:in|out)/)?.[0] || '',
}));
for (const tag of ['header', 'footer']) {
  assert(chrome(explore, tag), 'Explore shared ' + tag + ' exists');
  assert.deepEqual(links(chrome(html, tag)), links(chrome(explore, tag)), 'Homepage ' + tag + ' matches Explore destinations, copy and session modes');
  assert.doesNotMatch(chrome(html, tag), /data-scrapbook/, 'Homepage uses the default shared ' + tag);
}
const footer = chrome(html, 'footer');
assert.deepEqual([...footer.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(m => plainText(m[1])), footerGroups, 'Five canonical footer groups');
assert.equal((footer.match(/data-callvaal-footer-group/g) || []).length, 5);
const footerItems = [...footer.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].flatMap(m => links(m[1]));
assert.equal(footerItems.length, 36, 'All 36 grouped footer links');
assert.deepEqual(footerItems.map(item => item.href), footerRoutes, 'Canonical footer link order');
const source = readFileSync(resolve('src/pages/index.astro'), 'utf8');
const css = readFileSync(resolve('src/styles/approved-scrapbook.css'), 'utf8');
assert.doesNotMatch(source + css + main, /hf-approved-scrapbook|approved-reference|ReferenceCrop|crop-manifest/, 'No screenshot crops or old raster decorations in the homepage');
assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\(/i, 'No gradients in approved landing design');
const portraitIds = ['meera', 'kabir', 'ananya', 'rohan'];
const hashes = new Set();
for (const id of portraitIds) {
  const file = `assets/hf-home-sharp/${id}.webp`;
  const bytes = readFileSync(resolve(root, file));
  hashes.add(createHash('sha256').update(bytes).digest('hex'));
  const metadata = await sharp(bytes).metadata();
  assert(Math.min(metadata.width, metadata.height) >= 1024 && Math.max(metadata.width, metadata.height) >= 1536, 'Native high-resolution portrait: ' + id);
  const placements = [...main.matchAll(/<img\b[^>]*>/g)].map(m => m[0]).filter(tag => tag.includes('/' + file));
  assert(placements.length >= 1, 'Distinct portrait is actually rendered: ' + id);
  for (const photo of placements) {
    assert.match(photo, /\balt="[^"]+"/, 'Portrait has descriptive alternate text: ' + id);
    assert.equal(Number(photo.match(/\bwidth="(\d+)"/)?.[1]), metadata.width, 'Intrinsic portrait width: ' + id);
    assert.equal(Number(photo.match(/\bheight="(\d+)"/)?.[1]), metadata.height, 'Intrinsic portrait height: ' + id);
    assert.match(photo, /\bsrcset="[^"]* 2048w(?:,|")/, 'Portrait serves a 2048px responsive candidate: ' + id);
    assert.match(photo, /\bsizes="[^"]*(?:vw|calc\()[^"]*"/, 'Portrait has responsive sizes: ' + id);
  }
}
assert.equal(hashes.size, 4, 'Four separately sourced portrait files');
const photos = [...main.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
assert(photos.length >= 7, 'Hero collage and creator cards contain separate photo elements');
for (const photo of photos) {
  assert.match(photo, /\balt="/);
  assert.match(photo, /\bwidth="\d+"/);
  assert.match(photo, /\bheight="\d+"/);
  assert(portraitIds.some(id => photo.includes(`/assets/hf-home-sharp/${id}.webp`)), 'Homepage raster placements are individual fresh portraits');
}
const vectors = [...main.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map(m => m[0]);
assert(vectors.filter(vector => /class="[^"]*\bas-art\b/.test(vector)).length >= 5, 'Indian decoration is native vector artwork');
for (const vector of vectors) {
  assert.match(vector, /\bviewBox="/);
  assert.doesNotMatch(vector, /<(?:image|foreignObject)\b|data:image|approved-reference|hf-approved-scrapbook/i, 'Vector artwork cannot wrap a raster screenshot');
}
assert.match(source, /import\s*\{[^}]*HF_PLAY_URL[^}]*\}\s*from\s*['"][^'"]*hfApp['"]/, 'Google Play URL comes from canonical HF app configuration');
assert.match(source, /href=\{HF_PLAY_URL\}/, 'Canonical Google Play URL is used by the CTA');
const download = main.match(/<section\b[^>]*data-home-section="download"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '';
const playUrl = `https://play.google.com/store/apps/details?id=${brandConfig.hfPlayPackageId}`;
assert(links(download).some(link => link.href === playUrl), 'Download targets the configured Hello Fraands Google Play package');
assert.match(source, /\bAPP_STORE_URL\b/, 'Apple CTA uses configured listing availability');
const appleLinks = links(download).filter(link => /apps\.apple\.com/.test(link.href || ''));
if (appleLinks.length) {
  assert.equal(appleLinks.length, 1, 'One configured Apple listing');
  assert.match(appleLinks[0].href, /^https:\/\/apps\.apple\.com\/.*\/id\d+/);
} else {
  assert.match(download, /<(?:button|span)\b[^>]*(?:disabled|aria-disabled="true")[^>]*>[\s\S]*?Coming soon/i, 'Unknown Apple listing has a truthful non-link Coming soon state');
}
assert(!/<video\b/.test(main), 'Illustrative video art does not pretend an actual feed exists');
checkHelloFraandsPages(root, identity);
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m);
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m);
console.log('Sharp homepage: distinct high-resolution portraits, native vectors, Explore chrome, download CTA, preview integrity and content contracts passed.');

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
assert(ogImageUrl.includes('/assets/hf-home-sharp/'), 'Homepage shares its fresh high-resolution creator artwork');
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
