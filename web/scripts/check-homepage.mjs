// [HF-DESI-HOME-1] Desi homepage with the shared Explore header/footer. CI only.
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
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One H1');
assert(bodyHtml.includes('aria-label="' + identity.name + ' home"') && bodyHtml.includes('logo.png'), 'Owner logo with central accessible brand identity');
for (const copy of ['Your feed. Your people. Your call.', 'From Reel se', 'Real tak.', 'Your number stays private.', 'So many reasons.']) assert(mainText.includes(copy), 'Desi homepage copy: ' + copy);
assert.deepEqual([...main.matchAll(/data-home-section="([^"]+)"/g)].map(m => m[1]), ['hero','download','reasons','privacy','how-it-works','creators'], 'Approved desi section order');
for (const name of ['Meera','Kabir','Ananya','Rohan']) assert(mainText.includes(name), 'Illustrative creator: ' + name);
function idsFromMarkup(markup) { return [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); }
const allIds = idsFromMarkup(html);
const ids = new Set(allIds);
assert.equal(ids.size, allIds.length, 'No duplicate IDs');
// Shared header/footer deep links into the homepage (/#people, /#naye-dost, /#moods, #how-it-works).
for (const id of ['main-content','people','moods','naye-dost','how-it-works','safety','download']) assert(ids.has(id), 'Existing deep link: ' + id);
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
// Compare emitted footer links with Explore, so a home-only footer branch cannot drift. The home header is
// Explore's plus the two home extras (How it works, Join us) from <Header homeReference />.
const explore = normalizeBuiltImages(readFileSync(resolve(root, 'marketplace/index.html'), 'utf8'), { root });
const chrome = (markup, tag) => markup.match(new RegExp(`<${tag}\\b[^>]*data-callvaal-chrome[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0] || '';
const links = markup => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, label]) => ({
  href: attrs.match(/\bhref="([^"]+)"/)?.[1].replaceAll('&amp;', '&').replace(/^#/, '/#'),
  label: plainText(label),
  ariaLabel: attrs.match(/\baria-label="([^"]+)"/)?.[1] || '',
  auth: attrs.match(/cv-auth-(?:in|out)/)?.[0] || '',
}));
assert(chrome(explore, 'footer'), 'Explore shared footer exists');
assert.deepEqual(links(chrome(html, 'footer')), links(chrome(explore, 'footer')), 'Homepage footer matches Explore destinations and copy');
const homeHeader = links(chrome(html, 'header'));
const exploreHeader = links(chrome(explore, 'header'));
for (const item of exploreHeader) assert(homeHeader.some(h => h.href === item.href && h.label === item.label && h.auth === item.auth), 'Homepage header keeps Explore link: ' + item.href);
for (const href of ['/how-it-works', '/hosts/join', '/explore', '/sign-in', '/dashboard', '/sign-out']) assert(homeHeader.some(h => h.href === href), 'Homepage header link: ' + href); // [HF-EXPLORE-PUBLIC-1] header Explore = public reels; /marketplace stays
const footer = chrome(html, 'footer');
assert.deepEqual([...footer.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(m => plainText(m[1])), footerGroups, 'Five canonical footer groups');
assert.equal((footer.match(/data-callvaal-footer-group/g) || []).length, 5);
const footerItems = [...footer.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].flatMap(m => links(m[1]));
assert.equal(footerItems.length, 30, 'All 30 grouped footer links (six per column)');
assert.deepEqual(footerItems.map(item => item.href), footerRoutes, 'Canonical footer link order');
const source = readFileSync(resolve('src/pages/index.astro'), 'utf8');
assert.match(source, /desi-home-body\.html\?raw/, 'Homepage body comes from the generated desi design file');
assert.match(bodyHtml, /data-desi-home/, 'Desi homepage has its own layout shell');
assert.doesNotMatch(main, /href="#(?:explore|play|ios|meera|kabir|ananya|rohan|signin|blog|top|how)"/, 'No placeholder links from the design file survive');
for (const img of [...main.matchAll(/<img\b[^>]*>/g)].map(m => m[0])) {
  const src = img.match(/\bsrc="([^"]+)"/)?.[1] || '';
  if (src.startsWith('/assets/')) assert(existsSync(resolve(root, src.slice(1).split('?')[0])), 'Homepage image is shipped: ' + src);
}
assert.match(source, /import\s*\{[^}]*HF_PLAY_URL[^}]*\}\s*from\s*['"][^'"]*hfApp['"]/, 'Google Play URL comes from canonical HF app configuration');
const download = main.match(/<section\b[^>]*data-home-section="download"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '';
const playUrl = `https://play.google.com/store/apps/details?id=${brandConfig.hfPlayPackageId}`;
assert(links(download).some(link => link.href === playUrl), 'Download targets the configured Hello Fraands Google Play package');
assert(!links(download).some(link => /apps\.apple\.com/.test(link.href || '')), 'No invented Apple listing');
assert.match(download, /<span\b[^>]*aria-disabled="true"[^>]*>[\s\S]*?Coming soon/i, 'Unknown Apple listing has a truthful non-link Coming soon state');
// [HF-SCROLL-HERO-1 2026-10-25] Owner asked for a scroll-controlled explainer film above the hero. It is the ONLY
// video allowed in <main>: muted, inline, never autoplaying, and it explains the call flow (it is not a feed).
const storyHero = main.match(/<section\b[^>]*data-story-hero[\s\S]*?<\/section>/)?.[0] || '';
assert(storyHero, 'Scroll story hero renders inside <main>');
assert(main.indexOf('data-story-hero') < main.indexOf('data-home-section="hero"'), 'Scroll story hero sits above the desi hero');
const storyVideo = storyHero.match(/<video\b[^>]*>/)?.[0] || '';
assert(/\bmuted\b/.test(storyVideo) && /\bplaysinline\b/.test(storyVideo) && !/\bautoplay\b/.test(storyVideo) && !/\bcontrols\b/.test(storyVideo), 'Story film is muted, inline and never autoplays');
assert(/\bposter="[^"]+"/.test(storyVideo), 'Story film shows a poster immediately');
for (const copy of ['From watching reels', 'to saying hello.', 'Find your favourite.', 'First, we call Arti.', 'Then, we call you.', 'Just the conversation.', 'Not your number.', 'Neither person sees the other’s phone number.', 'Find your person.', 'Say hello.']) assert(plainText(storyHero).includes(copy), 'Story hero copy: ' + copy);
assert(storyHero.includes('href="/marketplace"') && storyHero.includes('href="/hosts/join"'), 'Story hero links Explore creators and Become a creator to real routes');
assert(!/<video\b/.test(main.replace(storyHero, '')), 'Illustrative art does not pretend an actual feed exists');
checkHelloFraandsPages(root, identity);
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m);
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m);
console.log('Desi homepage: shared header/footer links, resolvable anchors, download CTA and content contracts passed.');

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
assert(!sitemap.includes(BRAND.webOrigin + '/blog/'), 'Archived blog stays out of sitemap'); // [HF-BLOG-ARCHIVE-1]
assert(!sitemap.includes(BRAND.webOrigin + '/blog/creator-ideas/'), 'Retired blog articles stay out of sitemap');

// The promoted homepage has one accurate share preview and canonical URL (A4).
assert(meta(html, 'og:title').includes(identity.name), 'Homepage share identity follows the approved brand');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
const ogImageUrl = meta(html, 'og:image');
assert(ogImageUrl, 'Homepage has a share image');
assert(ogImageUrl.includes('/assets/hf-desi/'), 'Homepage shares its desi artwork');
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
