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
// [HF-HOME-HOST-FAN-1] HFHOME-02/06/07/09: the approved host/fan body.
const plainText = value => value.replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/&#(?:39|x27);/g, "'").replace(/&#(?:8217|x2019);/g, '’').replace(/\s+/g, ' ').trim();
const main = bodyHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
const mainText = plainText(main);
assert(!visibleText.includes('INVITE ONLY · BETA PHASE'), 'Retired beta ribbon is absent');
assert.doesNotMatch(bodyHtml, /class="[^"]*\bhfh-beta\b[^"]*"/, 'No beta ribbon element');
for (const copy of [
  'Talk to your favourite social media influencers over a private phone call.',
  'Book a time. We call you, call the host, and connect both calls. Neither of you sees the other’s personal number.',
  'Full KYC', 'Private numbers', 'Secure payments',
  'Book time with creators you follow',
  'Verified hosts. Real conversations. Pick a time that works.',
  'Your number stays yours.',
  'Our system calls the fan and the host separately, then securely connects the calls. We never reveal either person’s personal phone number.',
  'Two private calls. One conversation.',
  'Women with women', 'LGBTQ+ with LGBTQ+',
  'A private space for women to book conversations with verified women hosts.',
  'A respectful space for LGBTQ+ fans to book conversations with hosts from the community.',
  'Video KYC required', 'Choose a host', 'Book and pay', 'Talk privately',
  'Turn your audience into real conversations.',
  'Influencer or not, any adult can apply. Complete full KYC, create your page, set your rate, and share your link.',
]) assert(mainText.includes(copy), 'Approved homepage copy: ' + copy);
assert.match(mainText, /Sample profiles · Illustrative/);
assert.match(mainText, /No audio plays and no call or payment is made/);
assert.match(mainText, /Video KYC verifies the person, not their gender or sexual orientation/);
const sectionOrder = [...main.matchAll(/data-home-section="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(sectionOrder, ['hero', 'creators', 'privacy', 'lanes', 'how-it-works', 'host-cta']);
assert(bodyHtml.indexOf('<header') >= 0 && bodyHtml.indexOf('</header>') > bodyHtml.indexOf('<header') && bodyHtml.indexOf('</header>') < bodyHtml.indexOf('<main'), 'Homepage header precedes main content');
assert.match(main, /<em>over a private phone call\.<\/em>/);
const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const ids = new Set(allIds);
assert.equal(ids.size, allIds.length, 'No duplicate IDs');
for (const id of ['main-content', 'moods', 'naye-dost', 'women-only', 'privacy-note', 'safety', 'people', 'earn', 'how-it-works', 'preview-dialog']) assert(ids.has(id), 'Section exists: #' + id);
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) assert(ids.has(href.split('#')[1]), 'Missing anchor: ' + href);
}
for (const href of ['/marketplace', '/hosts/join', '/marketplace?lane=women#people', '/marketplace?lane=lgbtq#people']) assert(main.replaceAll('&amp;', '&').includes('href="' + href + '"'), 'Real destination: ' + href);
assert.equal((html.match(/<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared header');
assert.equal((html.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared footer');
assert(html.includes('href="/sign-in'), 'Sign-in remains reachable');
assert(meta(html, 'description')?.length > 40, 'Useful description');
assert(meta(html, 'og:title')?.includes(identity.name), 'Share title uses homepage identity');
assert(meta(html, 'og:description'), 'Share description exists');
assert.match(bodyHtml, /<dialog\b[^>]*id="preview-dialog"[^>]*aria-labelledby="preview-title"[^>]*aria-describedby="preview-description"/);
const cards = [...main.matchAll(/<article\b[^>]*data-creator-preview="[^"]+"[^>]*>[\s\S]*?<\/article>/g)].map(match => match[0]);
assert.equal(cards.length, 4, 'Four illustrative creators');
const expected = [
  ['neha', 'Neha', 'Beauty & Style', '4.9', 'Online now', '3.99'],
  ['arjun', 'Arjun', 'Gaming', '4.8', 'Online now', '4.50'],
  ['meera', 'Meera', 'Fitness', '4.9', 'In 30 mins', '3.50'],
  ['rohit', 'Rohit', 'Film & Culture', '4.7', 'Online now', '3.25'],
];
for (const [index, [id, name, category, rating, availability, rate]] of expected.entries()) {
  const card = cards[index];
  assert(card.includes('data-creator-preview="' + id + '"'));
  for (const copy of [name, category, rating, availability, '₹' + rate + '/min', 'Book a call', '0:20']) assert(plainText(card).includes(copy), id + ': ' + copy);
  for (const action of ['call', 'voice']) assert.match(card, new RegExp('<button\\b[^>]*data-preview-action="' + action + '"[^>]*aria-haspopup="dialog"'), 'Truthful preview action');
  assert(card.includes('alt="Illustrative portrait of ' + name + '"'));
}
assert.doesNotMatch(main, /data-live-host|<astro-island|id="mood-filter"|data-person(?:=|\s|>)/, 'Retired homepage discovery removed; marketplace stays independent');
// A discretionary line-break element does not change the displayed URL.
assert(main.replace(/<wbr\s*\/?>/gi, '').includes(identity.domain + '/yourname'), 'Sample share URL uses central identity');
assert(main.includes(identity.name), 'Private connector uses central identity');
assert.equal((main.match(/class="hfh-kyc"/g) || []).length, 2);
const footer = bodyHtml.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:="")?[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
assert.equal((footer.match(/data-callvaal-footer-group(?:="")?/g) || []).length, 5, 'Five footer groups');
assert.equal((footer.match(/<li[ >]/g) || []).length, 37, 'Complete five-column content footer');
const copyright = footer.match(/<p\b[^>]*class="cv-footer-copyright footer-copyright"[^>]*>([^<]*)<\/p>/)?.[1] ?? '';
assert.equal(copyright.trim(), `© ${new Date().getFullYear()} Ava Global International Inc. · Delaware, USA`, 'Owner-approved footer copyright uses the current year');
assert.deepEqual([...footer.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(m => plainText(m[1])), footerGroups, 'Footer groups keep the requested order');
assert.deepEqual([...footer.matchAll(/<li\b[^>]*>\s*<a\b[^>]*href="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&')), footerRoutes, 'Every requested footer route in column order');
checkHelloFraandsPages(root, identity);
// HFHOME-08: separate optimized photos, never a screenshot of the page.
// Inspect emitted URLs before normalization restores their source asset names.
const emittedMain = emittedHtml.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
const homepagePhotos = [...emittedMain.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
assert.equal(homepagePhotos.length, 11, 'All approved homepage photo placements render');
for (const photo of homepagePhotos) {
  assert.match(photo, /\bsrc="\/cdn-cgi\/image\/format=avif,quality=60,width=\d+,fit=cover\//, 'Homepage photo uses the public-image pipeline');
  const srcset = photo.match(/\bsrcset="([^"]+)"/)?.[1] || '';
  assert((srcset.match(/\s\d+w(?:,|$)/g) || []).length >= 2, 'Homepage photo has responsive width variants');
  assert.match(photo, /\bsizes="[^"]+"/, 'Homepage photo declares its display sizes');
}
for (const name of ['hero', 'host', 'neha', 'arjun', 'meera', 'rohit', 'women', 'community', 'hero-cutout', 'women-cutout', 'community-cutout', 'fan-call', 'host-call', 'women-reference', 'community-reference']) {
  const file = resolve(root, 'assets/callvaal/host-fan', name + '.webp');
  const bytes = readFileSync(file);
  const art = await sharp(bytes).metadata();
  assert.equal(art.format, 'webp', 'Genuine WebP: ' + name);
  assert(art.width >= 600 && art.height >= 600, 'Adequate source resolution: ' + name);
  assert(bytes.length <= (name.startsWith('hero') ? 400000 : 160000), 'Optimized asset budget: ' + name);
}
assert(meta(html, 'og:image').endsWith('/host-fan/hero.jpg'), 'New hero share fallback');
assert.equal((main.match(/fetchpriority="high"/g) || []).length, 1, 'Only hero is high priority');
assert.match(main, /class="hfh-hero-photo"[^>]*width="1000"[^>]*height="1250"/);
for (const href of ['/privacy', '/terms', '/refunds']) assert(footer.includes(`href="${href}"`), 'Published service policy is linked: ' + href);
assert.doesNotMatch(plainText(footer), /CallVaal|Doctors|Tax & money|Career|Relationships|Counsellor|Listener|Practice/, 'Footer has no retired brand or professional categories');
const talkSafely = readFileSync(resolve(root, 'talk-safely/index.html'), 'utf8');
const talkSafelyText = talkSafely.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
assert(talkSafelyText.includes(identity.name), 'Safety guide uses the centrally configured homepage identity');
assert(talkSafely.includes(`<title>Talking safely with strangers | ${identity.name}</title>`), 'Safety guide title uses the homepage identity');
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
console.log('Host/fan homepage checks passed: approved composition, four previews, privacy, lanes, routes, anchors and metadata.');

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
assert(routesJson.exclude.includes('/.well-known/*'), '_routes.json must exclude /.well-known/* (else assetlinks.json hits the [username]/[slug] Function and 404s)');
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
assert.match(guide, /<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Guide uses shared Hello Fraands footer');
assert.match(guide, /<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Guide uses shared Hello Fraands header');
assert.match(guide, /id="idea-search"/, 'Guide search has an accessible input');
// [HELLO-FRAANDS-ARCHIVE-1] archived (noindex) pages carry no structured data: assert.match(guide, /CollectionPage/);
// [HELLO-FRAANDS-ARCHIVE-1] archived (noindex) pages carry no structured data: assert.match(guide, /ItemList/);
assert(meta(guide, 'og:title') && meta(guide, 'og:description'));
const ritualLinks = [...new Set([...guide.matchAll(/href="(\/rituals\/[a-z0-9-]+)\/"/g)].map(m => m[1]))];
assert.equal(ritualLinks.length, 51, 'Every ritual has its own article');
const sitemap = readFileSync(resolve(root,'sitemap-pages.xml'),'utf8');
const sitemapIndexSource = readFileSync(resolve('src/pages/sitemap.xml.ts'),'utf8');
assert.match(sitemapIndexSource,/<sitemapindex/,'sitemap.xml is implemented as a sitemap index');
assert(sitemapIndexSource.includes('/sitemap-pages.xml'),'Index lists sitemap-pages.xml');
// [HELLO-FRAANDS-ARCHIVE-1] The guide is archived: still built, but noindex and out of the sitemap.
assert(!sitemap.includes(`<loc>${BRAND.webOrigin}/rituals/</loc>`), 'Archived guide stays out of the sitemap');
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
 assert.match(article, /<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Shared Hello Fraands article header: ' + href);
 assert.match(article, /<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Shared Hello Fraands article footer: ' + href);
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
// [HELLO-FRAANDS-ARCHIVE-1] archived (noindex) pages carry no structured data: assert.match(article, /BreadcrumbList/);
 assert(!sitemap.includes(BRAND.webOrigin + href + '/<'), 'Archived article stays out of the sitemap: ' + href);
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
