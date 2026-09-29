// Production-build smoke check: homepage links, art and archive must resolve.
//
// [SAATHUM-REFERENCE-2026-09-22] Homepage copy and layout checks follow the
// owner-approved screenshot. Archive, creator guides, sitemap and organiser
// checks below remain independent of this homepage visual replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { normalizeBuiltImages, validateBuiltImageSources } from './built-image-source.mjs';

function meta(page, key) {
  const tags = page.match(/<meta\b[^>]*>/g) || [];
  const tag = tags.find(tag => tag.includes('property="' + key + '"') || tag.includes('name="' + key + '"'));
  return tag?.match(/content="([^"]*)"/)?.[1];
}

const root = resolve('dist');
validateBuiltImageSources(root);
const rawHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const html = normalizeBuiltImages(rawHtml, { root });
const bodyHtml = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;

// --- Owner-approved compact reference homepage (2026-09-22) ---
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One readable main heading');
// [SAATHUM-REBRAND-1 2026-09-25] Puja & Havan service copy (text-only; design identity checks below unchanged).
assert.match(html, /<title[^>]*>Book Havans &amp; Pujas Online \| Saa Thum/, 'Puja service page title');
// Headline spans and line breaks are presentational; compare readable text.
const visibleText = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
assert.match(visibleText, /Sab ki aahuti, sab ka ashirwad\./, 'Brief H1');
assert.match(visibleText, /HAVANS\s*(?:·|•|&middot;|&#183;|&#x[Bb]7;)\s*OPEN TO ALL/, 'Hero eyebrow');
for (const heading of ['What would you like to welcome into your life?', 'Sacred havans we perform for you', 'HOW DOES IT WORK?', 'Only joy, only blessings.']) {
  assert(visibleText.includes(heading), 'Approved homepage heading: ' + heading);
}
assert.match(html, /data-design="saathum-reference-v5"/, 'Approved grand booking design identity');
assert.match(html, /data-grand-artwork="hero"/, 'Grand hero artwork is rendered');
assert.doesNotMatch(html, /folk-seal|folk-handnote|folk-art-note/, 'Retired compact badges and notes are absent');
assert.doesNotMatch(html, /data-reference-artwork|saathum-reference\/approved-homepage|hero-poster-nonav|creator-constellation/i, 'Retired screenshot artwork is absent from the promoted homepage');
// [BRAND-LOGO-1 2026-09-27] The lotus sticker no longer renders in the header/
// footer — the single horizontal Saa Thum logo does. Assert that instead.
assert.match(html, /class="avh-logo-mark"[^>]*saathum-logo-horizontal|saathum-logo-horizontal[^>]*class="avh-logo-mark"|class="avh-logo-mark"/, 'Header brand logo is rendered');
assert.match(html, /class="bf-logo-mark"/, 'Footer brand logo is rendered');
assert.match(html, /rel="icon" href="\/assets\/saathum-logo\/favicon-512\.png"/, 'Diya favicon is linked');
assert.doesNotMatch(html, /avh-logo-text|bf-logo-text|app-logo2\.png/, 'Retired icon + text brand lockup and old favicon are absent');
const renderedFolkArtwork = new Set(['satsang']);
for (const [name, width, height] of [['hero', 1536, 1024], ['ganesh', 1254, 1254], ['cow', 1254, 1254], ['music', 1254, 1254], ['satsang', 1536, 1024], ['culture', 1536, 1024], ['lotus', 1254, 1254], ['border', 2172, 724]]) {
  if (name !== 'border' && renderedFolkArtwork.has(name)) assert.match(html, new RegExp('data-folk-artwork="' + name + '"'), 'Folk artwork is rendered: ' + name);
  if (name === 'border') assert.match(html, /saathum-bright\/border\.png/, 'Optimized repeating border asset is referenced');
  const file = resolve(root, 'assets/saathum-bright', name + '.png');
  assert(existsSync(file), 'Original sticker asset exists: ' + name);
  const metadata = await sharp(file).metadata();
  assert(metadata.hasAlpha, 'Sticker asset retains transparency: ' + name);
  assert.equal(metadata.width, width, 'Sticker width is recorded: ' + name);
  assert.equal(metadata.height, height, 'Sticker height is recorded: ' + name);
}
const grandHeroPath = resolve(root, 'assets/saathum-grand/hero.png');
assert(existsSync(grandHeroPath), 'Grand hero artwork exists');
const grandHeroMetadata = await sharp(grandHeroPath).metadata();
assert(grandHeroMetadata.hasAlpha, 'Grand hero retains transparent foreground');
assert.equal(grandHeroMetadata.width, 1214, 'Grand hero width is recorded');
assert.equal(grandHeroMetadata.height, 1295, 'Grand hero height is recorded');
assert(html.includes('saathum-grand/hero.png'), 'Exact grand hero source is referenced');
// [SAATHUM-GUIDE-1 2026-09-25] Listing art left the homepage with the sample listing cards;
// the havan cards use /assets/saathum-rituals/ (checked below and in check-homepage-browser.mjs).
for (const [kind, names] of [['category', ['puja', 'aarti', 'bhajan', 'satsang', 'festival', 'yoga']]]) {
  for (const name of names) {
    const path = resolve(root, 'assets/saathum-booking', kind + '-' + name + '.png');
    assert(existsSync(path), 'Booking artwork exists: ' + kind + '-' + name);
    const metadata = await sharp(path).metadata();
    assert(metadata.width && metadata.height, 'Booking artwork has dimensions: ' + kind + '-' + name);
    assert(!metadata.hasAlpha, 'Booking artwork is opaque RGB: ' + kind + '-' + name);
    if (kind === 'category') assert.equal(metadata.width, metadata.height, 'Category art is square: ' + name);
    else assert(metadata.width > metadata.height, 'Listing art is landscape: ' + name);
    const sourcePath = 'saathum-booking/' + kind + '-' + name + '.png';
    assert(html.includes(sourcePath), 'Exact booking artwork source is referenced: ' + sourcePath);
  }
}
const elephantPath = resolve(root, 'assets/saathum-booking/elephant.png');
assert(existsSync(elephantPath), 'Organiser strip elephant artwork exists');
const elephantMetadata = await sharp(elephantPath).metadata();
assert(elephantMetadata.hasAlpha, 'Organiser elephant retains transparency');
assert.equal(elephantMetadata.width, 1536, 'Organiser elephant width is recorded');
assert.equal(elephantMetadata.height, 1024, 'Organiser elephant height is recorded');
assert.match(html, /class="grand-elephant/, 'Organiser section renders elephant artwork');
assert.match(html, /class="grand-hero-image/, 'Grand hero uses responsive image pipeline');
assert(visibleText.includes('Made in India with Love ❤️ and cutting chai.'), 'Exact owner footer line');
const headerHtml = html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? '';
// [WEB-NAV-HOME-1 2026-09-27] Header menu is Home (/) + Explore (/marketplace) + How it works
// + [WEB-HIW-2 2026-09-27] Help centre (/help) + [WEB-BLOG-RITUALS-1] Blog (/rituals).
for (const [label, href] of [['Home','/'],['Explore','/marketplace'],['How it works','/how-it-works'],['Our temples','/temples'],['Blog','/rituals/'],['Help centre','/help']]) {
  assert(headerHtml.includes('href="' + href + '"'), 'Restored header destination: ' + label);
  assert(headerHtml.includes('>' + label + '</a>'), 'Restored header label: ' + label);
}
const footerHtml = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
// [SAATHUM-ARCHIVE-1 2026-09-25] Puja & Havan booking footer: kept pages must be
// linked; archived pages (src/lib/archivedPages.ts) must NOT be in the footer.
for (const href of ['/','/marketplace','/how-it-works','/temples','/rituals/','/help','/about','/contact','/terms','/privacy','/cookies','/refunds','/disclaimer','/grievance']) {
  assert(footerHtml.includes('href="' + href + '"'), 'Footer destination remains discoverable: ' + href);
}
for (const href of ['/careers','/marketplace-terms','/consultation-terms','/acceptable-use','/recording','/biometric-retention','/dmca','/community-guidelines','/child-safety','/pricing-fees','/tokens','/payouts','/organisers']) {
  assert(!footerHtml.includes('href="' + href + '"'), 'Archived page is hidden from the footer: ' + href);
}
assert.doesNotMatch(footerHtml, /<details\b/, 'Footer menus are visible, not collapsed');
assert.match(visibleText, /Saa Thum performs pujas and havans for you\./, 'Service role is explained');
assert.match(visibleText, /You book and pay online; refunds follow our published policy\s*\./, 'Payment and refund explanation remains reachable');
assert.match(visibleText, /Saa Thum makes no claims of guaranteed outcomes\./, 'Brief disclaimer present');

// [SAATHUM-GUIDE-1 2026-09-25] Owner replaced the sample listing cards with eight
// havan KNOWLEDGE cards that open the Puja & Havan Guide — no prices, no fake slots.
const havanReadLinks = [...html.matchAll(/class="grand-booking-link" href="(\/rituals\/[a-z0-9-]+)\/"/g)].map(m => m[1]);
assert.equal(havanReadLinks.length, 8, 'Eight havan cards each link to their guide article');
assert(havanReadLinks.every(href => /-havan$/.test(href)), 'Homepage guide cards are all havans');
assert.match(html, /href="\/rituals\/"[^>]*>Explore more havans &amp; pujas/, 'Explore more havans & pujas button links to /rituals');
assert.doesNotMatch(visibleText, /Live now|Starts in|seats left/, 'No invented availability labels on the knowledge cards');
assert.doesNotMatch(bodyHtml, /href="\/(?:l|listing)\/sample[^"\s]*"/, 'Samples must not invent listing destinations');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const id of ['main-content', 'home-events', 'experiences', 'benefits', 'joining', 'organise-invite']) {
  assert(ids.has(id), 'Homepage section exists: #' + id);
}
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) {
    assert(ids.has(href.split('#')[1]), 'Missing homepage anchor: ' + href);
  }
}
const topicSearchTerms = [...html.matchAll(/href="\/marketplace\?q=([^"&]+)"/g)]
  .map(m => decodeURIComponent(m[1].replace(/\+/g, ' ')));
// [WEB-FOOTER-BROWSE-1 2026-09-29] Puja/Havan/Festival searches lived only in the old footer Rituals column.
for (const term of ['Studies', 'Fresh start', 'Prosperity', 'Health', 'Family']) {
  assert(topicSearchTerms.includes(term), 'Reference category searches marketplace: ' + term);
}
assert.match(html, /<a class="grand-button" href="\/marketplace"/, 'No-JS users can still reach the marketplace (plain link, no script needed)');
// [SAATHUM-ARCHIVE-1 2026-09-25] /pricing-fees and the join-a-live-show help link left the menus.
for (const href of ['/marketplace', '/help', '/refunds', '/terms']) {
  assert(html.includes('href="' + href + '"'), 'Essential marketplace destination remains reachable: ' + href);
}

// A3/A9 AC-01 — the old creator homepage is gone, not just relabelled.
assert.doesNotMatch(html, /Your audience is ready/, 'Retired creator hero headline absent');
assert.doesNotMatch(html, /to pay for you\./, 'Retired creator hero accent absent');
assert.doesNotMatch(html, /data-home-idea="/, 'Creator idea cards removed (A3)');
assert.doesNotMatch(html, /\bindia-idea-card\b/, 'Creator idea cards removed (A3)');
assert.doesNotMatch(html, /\bbooking-illustrated\b/, 'Booking Express illustrated section removed from home (A3)');
assert.doesNotMatch(html, /\bcalculator-illustrated\b/, 'Earnings calculator removed from home — mounts only on /organisers (contracts.md §6)');
assert.doesNotMatch(html, /<input\b[^>]*type="range"/, 'No calculator controls on the homepage (contracts.md §6)');
assert.doesNotMatch(html, /id="ideas-catalogue"|id="how-saathum-works"|id="addon-ideas"|id="addon-calculator"|id="consultations"/, 'Retired creator anchors removed (contracts.md §5)');
assert.doesNotMatch(html, /avatok-creator-constellation/, 'Retired creator hero art removed (A4.1, D10)');
assert.equal((html.match(/data-india-language-select/g) || []).length, 0, 'Language picker hidden on Saa Thum (D9)');
assert.doesNotMatch(bodyHtml.replace(/<footer\b[\s\S]*?<\/footer>/i, ''), /\b1:1 video calls?\b|\bastrology\b|\btarot\b|\bpalmistry\b|\bkundli\b/i, 'No 1:1 consultation or astrology content in homepage content (D2, AC-17)');

for (const key of ['web-landing.0528be3d426aff53', 'web-landing.92f4118799fbcf80', 'web-landing.d0082f5d7ac7dd8b', 'web-landing.721cb60fc48386d6', 'web-landing.c54a63bb77c61e9d', 'web-landing.b9d43bd06fbe8631']) {
  assert.doesNotMatch(html, new RegExp('data-i18n="' + key + '"'), 'Retired creator-copy i18n key not reused (D9, AC-18): ' + key);
}

for (const name of ['approved-hero.jpg', 'approved-ideas.jpg', 'creator-train.jpg']) {
 assert(existsSync(resolve(root, 'assets/railway', name)), 'Missing art: ' + name);
}
assert.match(html, /href="\/sign-in(?:\?|\"|\/)|href="\/dashboard(?:\?|\"|\/)/, 'Sign-in / dashboard path remains reachable (guest/authenticated)');
assert.match(html, /href="\/marketplace/, 'Marketplace remains reachable');
assert.match(html, /aria-controls="avh-drawer"/, 'Mobile menu is accessible');
assert.doesNotMatch(html, /data-motion-toggle|data-rail-train|start-dialog|This design preview|noindex/, 'Production page has no retired animation, placeholder or search exclusion');
assert.doesNotMatch(html, /href="\/india(?:[/?#"]|$)|data-site-experience="global"|data-artwork="global-retro-decades"/, 'Single homepage has no retired country switch or global landing');
assert.equal((html.match(/<header\b/g) || []).length, 1, 'Exactly one homepage header');
assert.doesNotMatch(html.match(/<header\b[\s\S]*?<\/header>/)?.[0] || '', /id="avh-mobile"/, 'Drawer is independent of the sticky header');
assert.match(html, /<dialog\b[^>]*id="avh-drawer"/, 'Mobile navigation uses a top-layer modal drawer');
assert.match(html, /aria-label="Close menu"/, 'Drawer has an accessible close button');
assert.equal((html.match(/<footer\b/g) || []).length, 1, 'Exactly one homepage footer');
assert.match(html, /class="[^"]*bazaar-footer/, 'Shared footer remains');
assert(!existsSync(resolve(root, 'india/index.html')), 'Retired India URL has no duplicate static landing');
const redirects = readFileSync(resolve(root, '_redirects'), 'utf8');
assert.match(redirects, /^\/india\s+\/\s+301\s*$/m, 'India URL permanently redirects home');
assert.match(redirects, /^\/india\/\s+\/\s+301\s*$/m, 'Trailing-slash India URL permanently redirects home');
console.log('Homepage checks passed: grand hero, open sections, havan guide cards, anchors and India redirects.');

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
assert.equal((guide.match(/data-idea-card/g) || []).length, 55, 'All 55 rituals (30 havans + 25 pujas) are in the guide');
assert.equal((guide.match(/data-format="havan"/g) || []).length, 31, '30 havan cards + the Havans filter');
assert.equal((guide.match(/data-format="puja"/g) || []).length, 26, '25 puja cards + the Pujas filter');
assert.equal((guide.match(/<h1[ >]/g) || []).length, 1, 'Guide has one main heading');
assert.match(guide, /class="bazaar-footer bazaar-footer--folk"/, 'Guide uses shared footer');
assert.match(guide, /avh--sticky/, 'Guide uses shared header');
assert.match(guide, /id="idea-search"/, 'Guide search has an accessible input');
assert.match(guide, /CollectionPage/);
assert.match(guide, /ItemList/);
assert(meta(guide, 'og:title') && meta(guide, 'og:description'));
const ritualLinks = [...new Set([...guide.matchAll(/href="(\/rituals\/[a-z0-9-]+)\/"/g)].map(m => m[1]))];
assert.equal(ritualLinks.length, 55, 'Every ritual has its own article');
const sitemap = readFileSync(resolve(root,'sitemap-pages.xml'),'utf8');
const sitemapIndexSource = readFileSync(resolve('src/pages/sitemap.xml.ts'),'utf8');
assert.match(sitemapIndexSource,/<sitemapindex/,'sitemap.xml is implemented as a sitemap index');
assert(sitemapIndexSource.includes('/sitemap-pages.xml'),'Index lists sitemap-pages.xml');
assert(sitemap.includes('<loc>https://saathum.com/rituals/</loc>'), 'Guide is in the sitemap');
assert(!sitemap.includes('https://saathum.com/ideas<'), 'Retired /ideas is out of the sitemap');
assert(!sitemap.includes('https://saathum.com/blog/creator-ideas/'), 'Archived creator guides stay out of the sitemap');
assert(!sitemap.includes('https://saathum.com/organisers'), '/organisers archived: not in sitemap');
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
  // [PRICING-1] The price is a live [data-saathum-price] span fed by /api/pricing — never a hardcoded figure.
 if (slug.endsWith('-havan')) { assert(article.includes('id="together"'), 'Havan explains joining together: ' + href); assert.match(article, /from <span data-saathum-price="[a-z0-9-]+" data-saathum-type="havan">₹\d[\d,]*<\/span>/, 'Havan price anchor (live from /api/pricing, [PRICING-1]): ' + href); }
 assert.match(article, /The story behind it/, 'Deity story: ' + href);
 assert.match(article, /temple priests/, 'Temple priests explained: ' + href);
 assert.match(article, /href="\/refunds"/, 'Refund policy link: ' + href);
 assert.match(article, /internationally/, 'International prasad courier explained: ' + href);
 assert.doesNotMatch(article, /guarantee(?:d|s)? (?:to|that|result|success|cure)|will cure|cures /i, 'No guaranteed outcomes or cures: ' + href);
 assert.equal(meta(article, 'og:type'), 'article');
 assert.match(article, /BreadcrumbList/);
 assert(sitemap.includes('https://saathum.com' + href + '/<'), 'Article in sitemap: ' + href);
 // Artwork: one file per ritual at /assets/saathum-rituals/<slug>.png, landscape, unique.
 const file = resolve(root, 'assets/saathum-rituals', slug + '.png');
 assert(existsSync(file), 'Ritual artwork missing (see Specs/saathum-ritual-images/IMAGE-PROMPTS.md): ' + slug + '.png');
 const art = await sharp(file).metadata();
 assert(art.width > art.height, 'Ritual artwork is landscape: ' + slug + '.png');
 const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
 assert(!ritualImages.has(hash), 'Duplicate ritual artwork bytes: ' + slug + '.png');
 ritualImages.add(hash);
 assert(article.includes('saathum-rituals/' + slug + '.png'), 'Article shows its own artwork: ' + href);
}
console.log('Puja & Havan Guide checks passed: 55 articles, sections, sitemap, sharing and unique artwork.');

// The promoted homepage has one accurate share preview and canonical URL (A4).
assert.equal(meta(html, 'og:title'), 'Book Havans &#38; Pujas Online | Saa Thum', 'A4 og:title (WEB-SEO-AUTO-1)');
assert.equal(meta(html, 'og:description'), 'Join havans for health, prosperity, peace and new beginnings. Our priests perform your sankalp, we send you the video to download, and prasad comes to your home.', 'A4 og:description (WEB-SEO-AUTO-1)');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
const ogImageUrl = meta(html, 'og:image');
assert(ogImageUrl, 'Homepage has a share image');
assert.match(ogImageUrl, /^https:\/\/saathum\.com\/og\/home\/home\.png\?v=[a-f0-9]{64}$/, 'Homepage uses a versioned generated share image');
assert.doesNotMatch(ogImageUrl, /avatok-creator-constellation/, 'Share image is not the retired creator hero (A4.1, D10)');
assert.equal(meta(html, 'twitter:image'), ogImageUrl);
assert.match(html, /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/saathum\.com\/"/, 'Homepage canonical is the root URL');
assert.equal(meta(html, 'og:url'), 'https://saathum.com/');
assert.doesNotMatch(sitemap, /<loc>https:\/\/saathum\.com\/india(?:-next)?\/?<\/loc>/, 'Retired and preview routes stay out of the sitemap');
console.log('Homepage title, description, canonical and share image passed.');

// [SHV2-S10] Attach the new /organisers contract check to THIS existing CI
// step (web-deploy.yml "Check homepage links and archive"; typecheck.yml
// "Check public homepage and help before deployment") instead of adding a
// new workflow step or trigger — B2 rule 8, S10 brief phase 1. Same pattern
// check-performance.mjs already uses to fan out to its sub-checks.
// [WEB-OLD-PAGES-GONE-1 2026-09-27] /organisers was DELETED (410), so check-organisers.mjs no longer runs.

// [WEB-SEO-REBRAND-1 2026-09-27] Brand-leak guard rides this same CI step.
execFileSync(process.execPath, ['scripts/check-brand-leaks.mjs'], { stdio: 'inherit' });
