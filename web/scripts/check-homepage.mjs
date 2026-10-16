// [CALLVAAL-NOTEBOOK-HOME-1] Built homepage contract. Run in GitHub Actions.
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
  const tags = page.match(/<meta\b[^>]*>/g) || [];
  const tag = tags.find(tag => tag.includes('property="' + key + '"') || tag.includes('name="' + key + '"'));
  return tag?.match(/content="([^"]*)"/)?.[1];
}

const root = resolve('dist');
validateBuiltImageSources(root);
const emittedHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const html = normalizeBuiltImages(emittedHtml, { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
const visibleText = bodyHtml.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const identity = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
assert(identity?.name && identity?.domain, 'Homepage identity is centrally configured');
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One main heading');
assert(visibleText.includes(identity.name), 'Planned public brand is visible');
// [HF-HOME-DESI-1] Owner-approved landing (2026-10-16): the dashboard's shell and cards with an animated hero.
const plainText = value => value.replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/&#(?:39|x27);/g, "'").replace(/&#(?:8217|x2019);/g, '’').replace(/\s+/g, ' ').trim();
const main = bodyHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
const mainText = plainText(main);
assert(!visibleText.includes('INVITE ONLY · BETA PHASE'), 'Retired beta ribbon is absent');
assert.doesNotMatch(bodyHtml, /class="[^"]*\bhfh-beta\b[^"]*"/, 'No beta ribbon element');
assert.match(bodyHtml, /class="hf3 hfl3"/, 'Landing uses the dashboard shell (.hf3)');
assert.match(bodyHtml, /<aside class="h3-side">[\s\S]*?aria-label="On this page"/, 'Section sidebar like the dashboard');
assert.match(bodyHtml, /<nav class="h3-bottom" aria-label="Quick navigation"/, 'Phone bottom tabs like the dashboard');
assert.match(main, /class="hfs" role="img" aria-label="Illustration: [^"]+"/, 'Animated hero stage is described for screen readers');
for (const copy of [
  'Your favourite creators. One conversation away.',
  'Go beyond likes and comments.',
  'Find a creator', 'I’m a creator', 'Video-KYC verified creators', 'Number hidden, both sides', 'Pay by the second',
  'Creators you can talk to', 'Scroll kam, baat zyada', 'Find who you love', 'Call now or book a time', 'Talk, privately',
  'Your number stays yours.', 'Two private calls. One conversation.',
  'Women talking to women', 'Connect within the LGBTQ+ community',
  'A private space for women to talk with verified women creators.',
  'A respectful space for LGBTQ+ fans to talk with creators from the community.',
  'Video KYC required', 'Kitna kamaoge?', 'Sawaal-jawaab', 'Watch what you love. Talk to who you love.',
  'Tele-MANAS', '14416',
]) assert(mainText.includes(copy), 'Approved landing copy: ' + copy);
assert.match(mainText, /Video KYC verifies the person, not their gender or sexual orientation/);
// Truthfulness: there is no Reels/Shorts feed on the site, and no sample profiles, ratings or prices pretend to be real.
assert.doesNotMatch(mainText, /scroll through (?:entertaining )?reels|watch reels here|our reels feed/i, 'No claim of an on-site Reels/Shorts feed');
assert.doesNotMatch(main, /data-creator-preview|data-preview-action/, 'No sample creator profiles on the landing page');
assert.match(main, /<astro-island\b[^>]*component-url="[^"]*LiveCreators[^"]*"/, 'Real creators load from the live list');
const sectionOrder = [...main.matchAll(/data-home-section="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(sectionOrder, ['hero', 'ticker', 'pricing', 'creators', 'how-it-works', 'privacy', 'host-cta', 'lanes', 'faq', 'final-cta']);
assert(bodyHtml.indexOf('<header') >= 0 && bodyHtml.indexOf('</header>') > bodyHtml.indexOf('<header') && bodyHtml.indexOf('</header>') < bodyHtml.indexOf('<main'), 'Homepage header precedes main content');
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const ids = new Set(allIds);
assert.equal(ids.size, allIds.length, 'No duplicate IDs');
for (const id of ['main-content', 'top', 'moods', 'naye-dost', 'people', 'how-it-works', 'safety', 'privacy-note', 'pricing', 'spaces', 'women-only', 'lgbtq', 'earn', 'faq']) assert(ids.has(id), 'Section exists: #' + id);
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) assert(ids.has(href.split('#')[1]), 'Missing anchor: ' + href);
}
for (const href of ['/marketplace', '/hosts/join', '/marketplace?lane=women#people', '/marketplace?lane=lgbtq#people', '/talk-safely', '/help']) assert(main.replaceAll('&amp;', '&').includes('href="' + href + '"'), 'Real destination: ' + href);
assert.equal((html.match(/<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared header');
assert.equal((html.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared footer');
assert(html.includes('href="/sign-in'), 'Sign-in remains reachable');
assert(meta(html, 'description')?.length > 40, 'Useful description');
assert(meta(html, 'og:title')?.includes(identity.name), 'Share title uses homepage identity');
assert(meta(html, 'og:description'), 'Share description exists');
assert(main.replace(/<wbr\s*\/?>/gi, '').includes(identity.domain + '/yourname'), 'Sample share URL uses central identity');
assert(main.includes(identity.name), 'Private connector uses central identity');
assert.doesNotMatch(bodyHtml, /Real people\. Naye dost\./, 'Homepage footer tagline removed');
assert.equal((main.match(/Video KYC required/g) || []).length, 2);
const footer = bodyHtml.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:="")?[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
assert.equal((footer.match(/data-callvaal-footer-group(?:="")?/g) || []).length, 5, 'Five footer groups');
assert.equal((footer.match(/<li[ >]/g) || []).length, 36, 'Complete five-column content footer');
const credit = footer.match(/<p\b[^>]*class="cv-footer-made"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
assert.equal(plainText(credit), 'Developed in India with ♥', 'Owner-approved footer development credit');
assert.match(credit, /<span\b[^>]*class="cv-footer-heart"[^>]*role="img"[^>]*aria-label="love"[^>]*>♥<\/span>/, 'Footer heart retains its red styling class and accessible label');
assert.doesNotMatch(footer, /cv-footer-copyright|footer-copyright|©\s*\d{4}\s+Ava Global International Inc\.\s*·\s*Delaware, USA/, 'Retired footer copyright line stays removed');
assert.deepEqual([...footer.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(m => plainText(m[1])), footerGroups, 'Footer groups keep the requested order');
assert.deepEqual([...footer.matchAll(/<li\b[^>]*>\s*<a\b[^>]*href="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&')), footerRoutes, 'Every requested footer route in column order');
checkHelloFraandsPages(root, identity);
// [HF-HOME-DESI-1] Landing art is the owner's stickers (HF-SITE-11) through the public-image pipeline, plus SVG flowers.
const emittedMain = emittedHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
assert((emittedMain.match(/\/hf\/stickers\/[a-z]+\.webp/g) || []).length >= 6, 'Landing uses the desi stickers');
for (const stk of ['chai', 'girlboss', 'kachori', 'auto', 'yaari', 'peace', 'pco', 'kyabaat', 'mohmaya']) assert(existsSync(resolve(root, 'hf/stickers', stk + '.webp')), 'Sticker ships: ' + stk);
for (const name of ['hero', 'host', 'neha', 'arjun', 'meera', 'rohit', 'women', 'community', 'hero-cutout', 'women-cutout', 'community-cutout', 'fan-call', 'host-call', 'women-reference', 'community-reference']) {
  const file = resolve(root, 'assets/callvaal/host-fan', name + '.webp');
  const bytes = readFileSync(file);
  const art = await sharp(bytes).metadata();
  assert.equal(art.format, 'webp', 'Genuine WebP: ' + name);
  assert(art.width >= 600 && art.height >= 600, 'Adequate source resolution: ' + name);
  assert(bytes.length <= (name.startsWith('hero') ? 400000 : 160000), 'Optimized asset budget: ' + name);
}
for (const name of ['hero', 'women', 'community', 'host', 'isha', 'kabir', 'sana', 'dev', 'step-choose-audio', 'step-book-audio', 'step-talk-audio']) {
  const bytes = readFileSync(resolve(root, 'assets/callvaal/host-fan/redesign', name + '.webp'));
  const art = await sharp(bytes).metadata();
  assert.equal(art.format, 'webp', 'New editorial artwork is WebP: ' + name);
  assert(art.width >= 1200 && art.height >= 800, 'Responsive source resolution: ' + name);
  assert(bytes.length <= 300000, 'Optimized artwork budget: ' + name);
}
assert(meta(html, 'og:image').endsWith('/host-fan/redesign/hero.jpg'), 'New hero share fallback');

for (const href of ['/privacy', '/terms', '/refunds']) assert(footer.includes(`href="${href}"`), 'Published service policy is linked: ' + href);
assert.doesNotMatch(plainText(footer), /CallVaal|Doctors|Tax & money|Career|Relationships|Counsellor|Listener|Practice/, 'Footer has no retired brand or professional categories');
const talkSafely = readFileSync(resolve(root, 'talk-safely/index.html'), 'utf8');
const talkSafelyText = talkSafely.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
assert(talkSafelyText.includes(identity.name), 'Safety guide uses the centrally configured homepage identity');
assert(talkSafely.includes(`<title>Talking safely on a call | ${identity.name}</title>`), 'Safety guide title uses the homepage identity');
assert.match(talkSafely, /data-design="callvaal-scrapbook"/, 'Safety guide uses the CallVaal notebook chrome');
assert.match(talkSafely, /<meta\b[^>]*name="robots"[^>]*content="noindex,nofollow"/, 'Interim safety guide stays out of search results');
for (const baseline of ['OTPs', 'passwords', 'financial details', 'home address', 'end it', 'Report the call']) {
  assert(talkSafelyText.includes(baseline), 'Safety guide includes interim baseline: ' + baseline);
}
assert.match(talkSafely, /<a\b[^>]*class="safety-guide__home"[^>]*href="\/"/, 'Safety guide links back home');
assert.equal((talkSafely.match(/<header\b/g) || []).length, 1, 'Safety guide has notebook header chrome');
assert.equal((talkSafely.match(/<footer\b/g) || []).length, 1, 'Safety guide has notebook footer chrome');
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m);
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m);
console.log('Landing checks passed: dashboard shell, animated hero, live creators, privacy, lanes, routes, anchors and metadata.');

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
assert(ogImageUrl.includes('/assets/callvaal/host-fan/'), 'Homepage shares its new host/fan artwork');
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
