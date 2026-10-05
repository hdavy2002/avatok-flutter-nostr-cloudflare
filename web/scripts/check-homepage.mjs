// [CALLVAAL-NOTEBOOK-HOME-1] Built homepage contract. Run in GitHub Actions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { normalizeBuiltImages, validateBuiltImageSources } from './built-image-source.mjs';
import { BRAND, reEscape } from './brand.mjs';

function meta(page, key) {
  const tags = page.match(/<meta\b[^>]*>/g) || [];
  const tag = tags.find(tag => tag.includes('property="' + key + '"') || tag.includes('name="' + key + '"'));
  return tag?.match(/content="([^"]*)"/)?.[1];
}

const root = resolve('dist');
validateBuiltImageSources(root);
const html = normalizeBuiltImages(readFileSync(resolve(root, 'index.html'), 'utf8'), { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
const visibleText = bodyHtml.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const identity = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
assert(identity?.name && identity?.domain, 'Homepage identity is centrally configured');
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One main heading');
assert(visibleText.includes(identity.name), 'Planned public brand is visible');
assert.match(visibleText, /Baat karo\./);
assert.match(visibleText, /Raasta nikalo\./);
assert.match(visibleText, /Sample profiles/, 'Fictional profile cards are labelled');
for (const label of ['5,000+', 'Verified people', 'Any Indian language', 'Pan India', 'Private numbers']) {
  assert(visibleText.includes(label), 'Social proof preview card: ' + label);
}
assert.match(visibleText, /Illustrative preview/, 'Social proof is visibly disclosed as illustrative');
assert.match(visibleText, /Launch target/, '5,000+ is framed as a launch target');
assert.match(visibleText, /Sample activity Live updates coming later/, 'Ticker is visibly disclosed as sample activity');
assert.match(bodyHtml, /class="activity-sequence" aria-hidden="true"/, 'Duplicated ticker sequence is hidden from assistive technology');
assert(bodyHtml.indexOf('class="social-proof-section"') > bodyHtml.indexOf('class="notebook-hero"') && bodyHtml.indexOf('class="social-proof-section"') < bodyHtml.indexOf('class="category-section"'), 'Social proof sits between hero and categories');
const homepageCss = readFileSync(resolve('src/styles/callvaal-notebook.css'), 'utf8');
assert.match(homepageCss, /@keyframes sample-activity-scroll\{to\{transform:translateX\(-50%\)\}\}/, 'Ticker loops right-to-left without a timer');
assert.match(homepageCss, /prefers-reduced-motion:reduce/, 'Ticker has a reduced-motion layout');
assert.match(homepageCss, /\.activity-track\{width:100%;max-width:100%;animation:none/, 'Reduced-motion track stays within its container');
assert.match(homepageCss, /\.activity-sequence\{width:100%;max-width:100%;flex:1 1 100%;min-width:0;/, 'Reduced-motion sequence can shrink at narrow zoomed widths');
assert.match(homepageCss, /animation-play-state:paused/, 'Ticker pauses for pointer and keyboard users');
assert.match(homepageCss, /\.activity-ticker:focus-visible\{outline:3px solid #7b388c;outline-offset:4px\}/, 'Ticker has a visible keyboard focus ring');
assert.doesNotMatch(bodyHtml, /hero-havan|FolkArtwork|data-folk-artwork|AskPandit|grand-havan|bright\/border|logo-horizontal/);
assert.doesNotMatch(visibleText, /Himalayan temple|prasad|pujas|havans|Aum Fe|Saa Thum/i);
for (const heading of ['Kis se baat karni hai?', 'Aapka number. Sirf aapka.', 'Sahi insaan. Ek kaam ki baat.', 'Your knowledge. Your experience. Your time.']) {
  assert(visibleText.includes(heading), 'Reference section: ' + heading);
}
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const id of ['main-content', 'categories', 'privacy-note', 'people', 'earn', 'preview-dialog']) {
  assert(ids.has(id), 'Homepage section exists: #' + id);
}
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) assert(ids.has(href.split('#')[1]), 'Missing anchor: ' + href);
}
assert.equal((html.match(/<header\b/g) || []).length, 1);
assert.equal((html.match(/<footer\b/g) || []).length, 1);
assert(meta(html, 'description')?.length > 40, 'Homepage has useful neutral description');
assert(meta(html, 'og:title')?.includes(identity.name), 'Share title uses homepage brand');
assert(meta(html, 'og:description'), 'Share description exists');
assert(html.includes('href="/sign-in'), 'Sign-in route remains reachable');
assert.match(html, /<dialog\b/, 'Unwired calls and joining have an accessible preview notice');
assert.doesNotMatch(visibleText, /No app needed|Life ka sawaal|Become an expert/i);
// [CALLVAAL-READABLE-CATEGORIES-1] Check each discovery surface, not merely text anywhere.
const categoryLabels = ['Doctors', 'Legal', 'Tax & money', 'Career & workplace', 'Relationships & marriage', 'Counsellor', 'Listener', 'Astrology', 'Practice'];
const plainText = value => value.replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
const categoryCards = [...bodyHtml.matchAll(/<button\b[^>]*class="category-card"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1]);
assert.deepEqual(categoryCards.map(card => plainText(card.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/)?.[1] || '')), categoryLabels, 'Exact nine category labels and order');
const categorySelect = bodyHtml.match(/<select\b[^>]*id="category-filter"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
assert.deepEqual([...categorySelect.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map(match => plainText(match[1])).slice(1), categoryLabels, 'Dropdown matches category tiles');
assert.doesNotMatch(plainText(visibleText), /Home & property|Learning & skills|Wellbeing/, 'Retired categories are absent');
const registryLabels = ['NMC', 'Bar Council', 'ICAI', 'RCI'];
const categoryCredentials = [...bodyHtml.matchAll(/<span\b[^>]*class="category-credential"[^>]*>([\s\S]*?)<\/span>/g)].map(match => plainText(match[1]));
assert.equal(categoryCredentials.length, 4, 'Four category registry badges');
assert.deepEqual(categoryCredentials, registryLabels.map(registry => `✓ Verified · ${registry}`), 'Credential categories use explicit verified labels');
for (const [index, registry] of [[0, 'NMC'], [1, 'Bar Council'], [2, 'ICAI'], [5, 'RCI']]) {
  assert(categoryCards[index].includes('category-credential') && plainText(categoryCards[index]).includes(registry), 'Registry belongs to correct category: ' + registry);
}
const profileBadges = [...bodyHtml.matchAll(/<div\b[^>]*class="person-heading"[^>]*>([\s\S]*?)<\/div>/g)].map(match => match[1]).filter(heading => heading.includes('class="verification-badge"')).map(plainText);
assert.equal(profileBadges.length, 4, 'Four illustrative profile verification badges');
for (const registry of registryLabels) assert(profileBadges.some(badge => badge.includes(registry)), 'Illustrative profile registry: ' + registry);
const disclosure = [...bodyHtml.matchAll(/<p\b[^>]*class="(?:sample-label|profile-disclosure)"[^>]*>([\s\S]*?)<\/p>/g)].map(match => plainText(match[1])).join(' ');
assert.match(disclosure, /illustrative/i);
for (const detail of ['profiles', 'qualifications', 'verification badges']) assert(disclosure.includes(detail), 'Illustrative disclosure covers ' + detail);
const footer = bodyHtml.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
assert.equal((footer.match(/<li[ >]/g) || []).length, 43, 'Complete 43-entry footer');
const explore = [...footer.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)].map(match => match[1]).find(group => /<summary[^>]*>Explore<\/summary>/.test(group)) || '';
assert.equal((explore.match(/<li[ >]/g) || []).length, 11, 'Explore has two destinations and nine categories');
assert.deepEqual([...explore.matchAll(/<button\b[^>]*data-category-select[^>]*>([\s\S]*?)<\/button>/g)].map(match => plainText(match[1])), categoryLabels, 'Footer exposes every category filter');
assert.match(visibleText, /non-clinical support/);
assert.match(visibleText, /not therapy or crisis care/);
assert.match(visibleText, /No stock or crypto tips\./, 'Tax category retains its advice boundary');
for (const asset of ['hero-collage.png', 'category-stickers.png', 'earn-art.png', ...Array.from({ length: 9 }, (_, i) => `portrait-${i + 1}.png`)]) {
  const file = resolve(root, 'assets/callvaal/scrapbook', asset);
  assert(existsSync(file), 'Scrapbook artwork ships: ' + asset);
  const art = await sharp(file).metadata();
  assert(art.width >= 1024 && art.height >= 1024, 'Scrapbook artwork has sufficient resolution: ' + asset);
  if (asset === 'category-stickers.png') assert.equal(art.width, art.height, 'Three-by-three sprite is square: ' + asset);
}
assert.equal((html.match(/data-person(?:=""|\s|>)/g) || []).length, 9, 'Nine illustrative profiles');
assert.match(visibleText, /Illustrative qualifications, verification badges, ratings, reviews, conversation counts and prices/);
assert.doesNotMatch(bodyHtml, /href="\/(?:privacy|terms|refunds|help)"/, 'Do not send new-service users to unrelated old policies');
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m);
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m);
console.log('Notebook homepage checks passed: identity, reference content, anchors, sample disclosure and metadata.');

// [WEB-OLD-PAGES-GONE-1 2026-09-27] /archive/home-2026-09-09 and /global-ideas were DELETED
// by owner decision (they now answer 410 via src/middleware.ts), so their archive and
// global-artwork crop checks were removed. They are in git history if ever needed.
assert(!existsSync(resolve(root, 'archive/home-2026-09-09/index.html')), 'Deleted archive page is not rebuilt');
assert(!existsSync(resolve(root, 'global-ideas/index.html')), 'Deleted /global-ideas page is not rebuilt');

// [SAATHUM-GUIDE-1 2026-09-25] The creator /ideas page (and its /blog/creator-ideas
// articles) was replaced by the Puja & Havan Guide at /rituals. /ideas is now an
// SSR 301 → /rituals, so it has no prerendered file. The creator checks that
// stood here are in git history (c32524ca) for restore.
assert(!existsSync(resolve(root, 'ideas/index.html')), '/ideas is a redirect, not a prerendered page');
// [SAATHUM-GUIDE-2] Articles 404'd in prod when /rituals/* overflowed the 100-rule _routes.json.
const routesJson = JSON.parse(readFileSync(resolve(root, '_routes.json'), 'utf8'));
assert(routesJson.exclude.includes('/rituals/*'), '_routes.json must exclude /rituals/* (else articles hit the Function and 404)');
assert(routesJson.include.length + routesJson.exclude.length <= 100, 'Cloudflare 100-rule _routes.json ceiling');
for (const list of [routesJson.include, routesJson.exclude]) {
  const splats = list.filter(rule => rule.endsWith('/*')).map(rule => rule.slice(0, -1));
  for (const rule of list) assert(!splats.some(prefix => rule !== prefix + '*' && (rule.startsWith(prefix) || rule + '/' === prefix)), 'Cloudflare rejects overlapping _routes.json rules: ' + rule);
}
const guide = normalizeBuiltImages(readFileSync(resolve(root, 'rituals/index.html'), 'utf8'), { root });
// [WEB-REFRAME-1 2026-09-29] Navagraha Havan/Puja, Lalita Havan and Shani Shanti Puja removed (temple policy).
assert.equal((guide.match(/data-idea-card/g) || []).length, 51, 'All 51 rituals (28 havans + 23 pujas) are in the guide');
assert.equal((guide.match(/data-format="havan"/g) || []).length, 29, '28 havan cards + the Havans filter');
assert.equal((guide.match(/data-format="puja"/g) || []).length, 24, '23 puja cards + the Pujas filter');
assert.equal((guide.match(/<h1[ >]/g) || []).length, 1, 'Guide has one main heading');
assert.match(guide, /class="bazaar-footer bazaar-footer--folk"/, 'Guide uses shared footer');
assert.match(guide, /avh--sticky/, 'Guide uses shared header');
assert.match(guide, /id="idea-search"/, 'Guide search has an accessible input');
assert.match(guide, /CollectionPage/);
assert.match(guide, /ItemList/);
assert(meta(guide, 'og:title') && meta(guide, 'og:description'));
const ritualLinks = [...new Set([...guide.matchAll(/href="(\/rituals\/[a-z0-9-]+)\/"/g)].map(m => m[1]))];
assert.equal(ritualLinks.length, 51, 'Every ritual has its own article');
const sitemap = readFileSync(resolve(root,'sitemap-pages.xml'),'utf8');
const sitemapIndexSource = readFileSync(resolve('src/pages/sitemap.xml.ts'),'utf8');
assert.match(sitemapIndexSource,/<sitemapindex/,'sitemap.xml is implemented as a sitemap index');
assert(sitemapIndexSource.includes('/sitemap-pages.xml'),'Index lists sitemap-pages.xml');
assert(sitemap.includes(`<loc>${BRAND.webOrigin}/rituals/</loc>`), 'Guide is in the sitemap');
assert(!sitemap.includes(`${BRAND.webOrigin}/ideas<`), 'Retired /ideas is out of the sitemap');
assert(!sitemap.includes(`${BRAND.webOrigin}/blog/creator-ideas/`), 'Archived creator guides stay out of the sitemap');
assert(!sitemap.includes(`${BRAND.webOrigin}/organisers`), '/organisers archived: not in sitemap');
const ritualImages = new Set();
for (const href of ritualLinks) {
 const slug = href.split('/').pop();
 const article = normalizeBuiltImages(readFileSync(resolve(root, href.slice(1), 'index.html'), 'utf8'), { root });
 assert.equal((article.match(/<h1[ >]/g) || []).length, 1, 'One article heading: ' + href);
 assert.match(article, new RegExp('data-ritual-article="' + slug + '"'), 'Article identity: ' + href);
 for (const section of ['about','why-deity','blessings','who','when','altar','value','from-home','prasad','good-to-know']) assert(article.includes('id="' + section + '"'), 'Missing ' + section + ' in ' + href);
 assert.match(article, /avh--sticky/, 'Shared article header: ' + href);
 assert.match(article, /class="bazaar-footer bazaar-footer--folk"/, 'Shared article footer: ' + href);
 assert.match(article, /href="\/marketplace\?q=/, 'Article booking CTA: ' + href);
 // [SAATHUM-GUIDE-2] Havans are open shared events (power of many); pujas are private.
  // [PRICING-1] The price is a live [data-site-price] span fed by /api/pricing — never a hardcoded figure.
 if (slug.endsWith('-havan')) { assert(article.includes('id="together"'), 'Havan explains joining together: ' + href); assert.match(article, /from <span data-site-price="[a-z0-9-]+" data-site-type="havan">₹\d[\d,]*<\/span>/, 'Havan price anchor (live from /api/pricing, [PRICING-1]): ' + href); }
 assert.match(article, /The story behind it/, 'Deity story: ' + href);
 assert.match(article, /temple priests/, 'Temple priests explained: ' + href);
 assert.match(article, /href="\/refunds"/, 'Refund policy link: ' + href);
 assert.match(article, /internationally/, 'International prasad courier explained: ' + href);
 assert.doesNotMatch(article, /guarantee(?:d|s)? (?:to|that|result|success|cure)|will cure|cures /i, 'No guaranteed outcomes or cures: ' + href);
 assert.equal(meta(article, 'og:type'), 'article');
 assert.match(article, /BreadcrumbList/);
 assert(sitemap.includes(BRAND.webOrigin + href + '/<'), 'Article in sitemap: ' + href);
 // Artwork: one file per ritual at /assets/rituals/<slug>.png, landscape, unique.
 const file = resolve(root, 'assets/rituals', slug + '.png');
 assert(existsSync(file), 'Ritual artwork missing (see Specs/saathum-ritual-images/IMAGE-PROMPTS.md): ' + slug + '.png');
 const art = await sharp(file).metadata();
 assert(art.width > art.height, 'Ritual artwork is landscape: ' + slug + '.png');
 const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
 assert(!ritualImages.has(hash), 'Duplicate ritual artwork bytes: ' + slug + '.png');
 ritualImages.add(hash);
 assert(article.includes('rituals/' + slug + '.png'), 'Article shows its own artwork: ' + href);
}
console.log('Puja & Havan Guide checks passed: 51 articles, sections, sitemap, sharing and unique artwork.');

// The promoted homepage has one accurate share preview and canonical URL (A4).
assert(meta(html, 'og:title').includes(identity.name), 'Homepage share identity follows the approved brand');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
const ogImageUrl = meta(html, 'og:image');
assert(ogImageUrl, 'Homepage has a share image');
assert(ogImageUrl.includes('/assets/callvaal/scrapbook/'), 'Homepage shares its scrapbook artwork');
assert.doesNotMatch(ogImageUrl, /avatok-creator-constellation/, 'Share image is not the retired creator hero (A4.1, D10)');
assert.equal(meta(html, 'twitter:image'), ogImageUrl);
assert.match(html, new RegExp('<link\\b[^>]*rel="canonical"[^>]*href="' + reEscape(BRAND.webOrigin + '/') + '"'), 'Homepage canonical is the root URL');
assert.equal(meta(html, 'og:url'), BRAND.webOrigin + '/');
assert.doesNotMatch(sitemap, new RegExp('<loc>' + reEscape(BRAND.webOrigin) + '/india(?:-next)?/?</loc>'), 'Retired and preview routes stay out of the sitemap');
console.log('Homepage title, description, canonical and share image passed.');

// [SHV2-S10] Attach the new /organisers contract check to THIS existing CI
// step (web-deploy.yml "Check homepage links and archive"; typecheck.yml
// "Check public homepage and help before deployment") instead of adding a
// new workflow step or trigger — B2 rule 8, S10 brief phase 1. Same pattern
// check-performance.mjs already uses to fan out to its sub-checks.
// [WEB-OLD-PAGES-GONE-1 2026-09-27] /organisers was DELETED (410), so check-organisers.mjs no longer runs.

// [WEB-SEO-REBRAND-1 2026-09-27] Brand-leak guard rides this same CI step.
execFileSync(process.execPath, ['scripts/check-brand-leaks.mjs'], { stdio: 'inherit' });
