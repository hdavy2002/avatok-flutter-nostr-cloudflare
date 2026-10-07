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
const html = normalizeBuiltImages(readFileSync(resolve(root, 'index.html'), 'utf8'), { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
const visibleText = bodyHtml.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const identity = JSON.parse(readFileSync(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
assert(identity?.name && identity?.domain, 'Homepage identity is centrally configured');
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One main heading');
assert(visibleText.includes(identity.name), 'Planned public brand is visible');
assert.match(visibleText, /Baat karo\. Dil halka karo\./);
assert.match(visibleText, /Real people\. Your number stays private\./);
assert.match(visibleText, /Pay per minute/);
assert.match(visibleText, /18\+ only/);
for (const copy of ['No medical, legal or money advice.', 'No miracles, no guaranteed results.', 'Tele-MANAS 14416', 'Calls are recorded with consent, kept 30 days', 'Earn ₹12–₹18', 'Video KYC + Aadhaar', 'Go online, get paid via UPI']) {
  assert(visibleText.includes(copy), 'Conversation, safety and earning contract: ' + copy);
}
assert.doesNotMatch(bodyHtml, /data-callvaal-category-card|id="category-filter"|data-category-select/, 'Discovery uses moods, not professional categories');
assert.doesNotMatch(visibleText, /General physician|NMC|Bar Council|ICAI|RCI|Raasta nikalo|Become an expert/);
for (const heading of ['Mann ki baat', 'Tension', 'Gap-shap', 'Taare', 'Aapka number.', 'Kaun hai', 'Baatein karo.']) assert(visibleText.includes(heading), 'Section: ' + heading);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const id of ['main-content', 'moods', 'women-only', 'privacy-note', 'safety', 'people', 'earn', 'preview-dialog']) assert(ids.has(id), 'Section exists: #' + id);
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) assert(ids.has(href.split('#')[1]), 'Missing anchor: ' + href);
}
assert.equal((html.match(/<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared header');
assert.equal((html.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/g) || []).length, 1, 'One shared footer');
assert(meta(html, 'description')?.length > 40, 'Useful description');
assert(meta(html, 'og:title')?.includes(identity.name), 'Share title uses homepage identity');
assert(meta(html, 'og:description'), 'Share description exists');
assert(html.includes('href="/sign-in'), 'Sign-in remains reachable');
assert.match(html, /<dialog\b/, 'Preview actions have an accessible notice');
const plainText = value => value.replace(/<[^>]*>/g, ' ').replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
const moodSlugs = ['bas-baat-karni-hai', 'aaj-akela-lag-raha-hai', 'din-kharab-tha', 'raat-ko-neend-nahi-aati', 'shaam-ki-company', 'exam-ki-tension', 'interview-se-darr', 'shaadi-ka-pressure', 'ghar-waalon-se-jhagda', 'naukri-ki-chinta', 'breakup', 'kisi-topic-pe-baat', 'apni-bhasha-mein-baat', 'english-mein-casual-chat', 'kundli', 'horoscope', 'tarot'];
const moodSelect = bodyHtml.match(/<select\b[^>]*id="mood-filter"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
assert.deepEqual([...moodSelect.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(m => m[1]), moodSlugs, 'All 17 moods in discovery order');
for (const slug of moodSlugs) assert(bodyHtml.includes(`href="/?mood=${slug}#people"`), 'Mood link: ' + slug);
assert.match(bodyHtml, /id="online-filter"/, 'Online filter available');
const cards = [...bodyHtml.matchAll(/<article\b[^>]*data-person(?:="")?[^>]*>[\s\S]*?<\/article>/g)].map(m => m[0]);
assert.equal(cards.length, 8, 'Eight illustrative hosts');
assert.deepEqual(cards.map(card => plainText(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/)?.[1] || '')), ['Neha', 'Priya', 'Sana', 'Kavya', 'Ananya', 'Rohan', 'Arjun', 'Dev'], 'Approved host roster');
for (const card of cards) {
  assert.match(card, /data-moods="[^"]+"/);
  assert.match(card, /data-online="(?:true|false)"/);
  assert.match(card, /data-price="(?:20|25|30)"/);
  assert.match(card, /alt="Illustrative portrait of /);
}
assert.match(visibleText, /All profiles, video-KYC badges, ratings and conversation counts shown here are illustrative/);
assert.match(visibleText, /Calls and payments are unavailable in this preview/);
assert.match(visibleText, /Illustrative preview/);
assert.match(visibleText, /Launch target/);
assert.match(visibleText, /Sample activity Live updates coming later/);
assert.match(bodyHtml, /class="activity-sequence" aria-hidden="true"/);
const womenSection = bodyHtml.match(/<section\b[^>]*id="women-only"[^>]*>[\s\S]*?<\/section>/)?.[0] || '';
assert(womenSection, 'Women-only preview renders on the homepage');
assert.match(womenSection, /<h2[^>]*id="women-title"[^>]*>Sirf ladkiyon ke liye<br\s*\/?><em>Ek jagah jahan sirf auratein baat karti hain\.<\/em><\/h2>/, 'Women-only heading has an italic second line');
assert(bodyHtml.indexOf('id="moods"') < bodyHtml.indexOf('id="women-only"') && bodyHtml.indexOf('id="women-only"') < bodyHtml.indexOf('id="privacy-note"'), 'Women-only preview sits between moods and privacy');
for (const copy of ['Sirf ladkiyon ke liye', 'Ek jagah jahan sirf auratein baat karti hain.', 'Preview — visible to verified women at launch', 'Talk and share — not medical advice.', 'periods & PCOS worries', 'saas-bahu, ghar ki baatein', 'pregnancy & new mom nights', 'Hosts in this space earn the same rates.']) assert(plainText(womenSection).includes(copy), 'Women-only preview: ' + copy);
assert.match(womenSection, /<button\b[^>]*disabled[^>]*>Verify &amp; enter<\/button>/, 'Preview entry is disabled');
assert(womenSection.includes('href="/women-only"') && womenSection.includes('href="#earn"'), 'Women-only explainer and host rates links');
assert.equal((womenSection.match(/class="women-mood-chip"/g) || []).length, 3, 'Three women-only mood chips');
assert.equal((womenSection.match(/href="\/\?lane=women#people"/g) || []).length, 3, 'Women-only mood links enter preview lane');
const footer = bodyHtml.match(/<footer\b[^>]*\bdata-callvaal-chrome(?:="")?[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
assert.equal((footer.match(/data-callvaal-footer-group(?:="")?/g) || []).length, 5, 'Five footer groups');
assert.equal((footer.match(/<li[ >]/g) || []).length, 34, 'Complete five-column content footer');
assert.deepEqual([...footer.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(m => plainText(m[1])), footerGroups, 'Footer groups keep the requested order');
assert.deepEqual([...footer.matchAll(/<li\b[^>]*>\s*<a\b[^>]*href="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&')), footerRoutes, 'Every requested footer route in column order');
checkHelloFraandsPages(root, identity);
const portraitHashes = new Set();
for (const asset of ['hero-collage-moods.png', 'earn-art-moods.png', 'portrait-ananya.png', ...[3, 4, 5, 6, 7, 8, 9].map(i => `portrait-${i}.png`)]) {
  const file = resolve(root, 'assets/callvaal/scrapbook', asset);
  assert(existsSync(file), 'Approved artwork ships: ' + asset);
  const art = await sharp(file).metadata();
  assert(art.width >= 1024 && art.height >= 1024, 'Artwork resolution: ' + asset);
  if (asset.startsWith('portrait-')) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    assert(!portraitHashes.has(hash), 'Distinct host artwork: ' + asset);
    portraitHashes.add(hash);
  }
}
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
console.log('Notebook homepage checks passed: identity, moods, eight hosts, safety, earning, anchors, sample disclosure and metadata.');

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
assert.match(guide, /<footer\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Guide uses shared Hello Fraands footer');
assert.match(guide, /<header\b[^>]*\bdata-callvaal-chrome(?:=|\s|>)/, 'Guide uses shared Hello Fraands header');
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
