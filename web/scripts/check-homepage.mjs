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
assert.match(html, /<title[^>]*>Saathum — Sacred Rituals Performed for You, Watched Live/, 'Puja service page title');
// Headline spans and line breaks are presentational; compare readable text.
const visibleText = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
assert.match(visibleText, /Sab ki aahuti, sab ka ashirwad\./, 'Brief H1');
assert.match(visibleText, /LIVE HAVANS\s*(?:·|•|&middot;|&#183;|&#x[Bb]7;)\s*OPEN TO ALL/, 'Hero eyebrow');
for (const heading of ['What would you like to welcome into your life?', 'Sacred havans we perform for you', 'Done properly, even from far away.', 'Only joy, only blessings.']) {
  assert(visibleText.includes(heading), 'Approved homepage heading: ' + heading);
}
assert.match(html, /data-design="saathum-reference-v5"/, 'Approved grand booking design identity');
assert.match(html, /data-grand-artwork="hero"/, 'Grand hero artwork is rendered');
assert.doesNotMatch(html, /folk-seal|folk-handnote|folk-art-note/, 'Retired compact badges and notes are absent');
assert.doesNotMatch(html, /data-reference-artwork|saathum-reference\/approved-homepage|hero-poster-nonav|creator-constellation/i, 'Retired screenshot artwork is absent from the promoted homepage');
const renderedFolkArtwork = new Set(['satsang', 'lotus']);
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
// [SAATHUM-ARCHIVE-1 2026-09-25] Marketplace menu label renamed.
for (const [label, href] of [['Pujas','/marketplace?q=Puja'],['Havans','/marketplace?q=Havan'],['By intention','/#experiences'],['How it works','/how-it-works']]) {
  assert(headerHtml.includes('href="' + href + '"'), 'Restored header destination: ' + label);
  assert(headerHtml.includes('>' + label + '</a>'), 'Restored header label: ' + label);
}
const footerHtml = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';
// [SAATHUM-ARCHIVE-1 2026-09-25] Puja & Havan booking footer: kept pages must be
// linked; archived pages (src/lib/archivedPages.ts) must NOT be in the footer.
for (const href of ['/marketplace?q=Puja','/marketplace?q=Havan','/how-it-works','/help','/contact','/terms','/privacy','/cookies','/refunds']) {
  assert(footerHtml.includes('href="' + href + '"'), 'Footer destination remains discoverable: ' + href);
}
for (const href of ['/grievance','/about','/careers','/marketplace-terms','/consultation-terms','/acceptable-use','/recording','/biometric-retention','/dmca','/community-guidelines','/child-safety','/pricing-fees','/tokens','/payouts','/organisers']) {
  assert(!footerHtml.includes('href="' + href + '"'), 'Archived page is hidden from the footer: ' + href);
}
assert.doesNotMatch(footerHtml, /<details\b/, 'Footer menus are visible, not collapsed');
assert.match(visibleText, /Saathum performs pujas and havans for you\./, 'Service role is explained');
assert.match(visibleText, /You book and pay online; refunds follow our published policy\s*\./, 'Payment and refund explanation remains reachable');
assert.match(visibleText, /Saathum makes no claims of guaranteed outcomes\./, 'Brief disclaimer present');

// [SAATHUM-GUIDE-1 2026-09-25] Owner replaced the sample listing cards with eight
// havan KNOWLEDGE cards that open the Puja & Havan Guide — no prices, no fake slots.
const havanReadLinks = [...html.matchAll(/class="grand-booking-link" href="(\/rituals\/[a-z0-9-]+)"/g)].map(m => m[1]);
assert.equal(havanReadLinks.length, 8, 'Eight havan cards each link to their guide article');
assert(havanReadLinks.every(href => /-havan$/.test(href)), 'Homepage guide cards are all havans');
assert.match(html, /href="\/rituals"[^>]*>Explore more havans &amp; pujas/, 'Explore more havans & pujas button links to /rituals');
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
for (const term of ['Puja', 'Havan', 'Studies', 'Fresh start', 'Prosperity', 'Health', 'Family', 'Festival']) {
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
assert.doesNotMatch(html, /id="ideas-catalogue"|id="how-avatok-works"|id="addon-ideas"|id="addon-calculator"|id="consultations"/, 'Retired creator anchors removed (contracts.md §5)');
assert.doesNotMatch(html, /avatok-creator-constellation/, 'Retired creator hero art removed (A4.1, D10)');
assert.equal((html.match(/data-india-language-select/g) || []).length, 0, 'Language picker hidden on Saathum (D9)');
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
const archive = normalizeBuiltImages(readFileSync(resolve(root, 'archive/home-2026-09-09/index.html'), 'utf8'), { root });
assert.match(archive, /noindex, nofollow/, 'Existing archive must not compete in search');
assert.match(archive, /hero-poster-nonav.png/, 'Previous hero remains archived');
console.log('Homepage checks passed: grand hero, open sections, havan guide cards, anchors and India redirects.');

const globalIdeas = normalizeBuiltImages(readFileSync(resolve(root, 'global-ideas/index.html'), 'utf8'), { root });
for (const name of ['hero-creators', 'format-live', 'format-call', 'format-paid', 'payout-world', 'creator-marketplace-og']) {
 assert(existsSync(resolve(root, 'assets/global', name + '.png')), 'Missing global artwork: ' + name);
}
for (const image of globalIdeas.matchAll(/<img\b[^>]*src="(\/assets\/global\/[^\"]+)"/g)) {
 assert(existsSync(resolve(root, image[1].slice(1))), 'Visible global artwork resolves: ' + image[1]);
 for (const width of [480, 960]) {
  const variant = image[1].replace(/\.png$/, '-' + width + '.webp');
  assert(existsSync(resolve(root, variant.slice(1))), 'Responsive artwork exists: ' + variant);
 }
}
assert.equal((globalIdeas.match(/<header\b/g) || []).length, 1, 'Global catalog has no duplicate header');
assert.equal((globalIdeas.match(/<footer\b/g) || []).length, 1, 'Global catalog has no duplicate footer');
const globalLinks = [...globalIdeas.matchAll(/href="(\/blog\/global-creator-ideas\/[^\"]+)"/g)].map(m => m[1]);
assert.equal(new Set(globalLinks).size, 8, 'Eight distinct global guides');
const globalImageHashes = new Set();
for (const href of globalLinks) {
 const slug = href.split('/').filter(Boolean).at(-1);
 const page = normalizeBuiltImages(readFileSync(resolve(root, href.slice(1), 'index.html'), 'utf8'), { root });
 assert.equal((page.match(/<h1[ >]/g) || []).length, 1, 'One guide heading: ' + slug);
 assert.equal((page.match(/<header\b/g) || []).length, 1, 'One guide header: ' + slug);
 assert.equal((page.match(/<footer\b/g) || []).length, 1, 'One guide footer: ' + slug);
 assert(page.includes('data-global-guide="' + slug + '"'), 'Distinct global guide identity: ' + slug);
 assert.match(page, /BlogPosting/, 'Global guide structured data: ' + slug);
 const asset = '/assets/global-original/ideas-' + slug + '.png';
 assert(globalIdeas.includes(asset) && page.includes(asset), 'Guide artwork in catalog and article: ' + slug);
 const hash = createHash('sha256').update(readFileSync(resolve(root, asset.slice(1)))).digest('hex');
 assert(!globalImageHashes.has(hash), 'Each idea needs its own artwork: ' + slug);
 globalImageHashes.add(hash);
 assert.match(page, /href="\/global-ideas/, 'Guide links back to catalog');
}

// Owner-approved pixels must remain literal crops, not regenerated lookalikes.
const originalIdeas = resolve(root, 'assets/global-original/ideas-source.png');
const cropEdges = [0, 396, 772, 1140, 1536];
for (const [index, href] of globalLinks.entries()) {
 const slug = href.split('/').filter(Boolean).at(-1);
 const column = index % 4;
 const expected = await sharp(originalIdeas).extract({left:cropEdges[column], top:index < 4 ? 228 : 536, width:cropEdges[column + 1] - cropEdges[column], height:index < 4 ? 308 : 320}).removeAlpha().raw().toBuffer();
 const actual = await sharp(resolve(root, 'assets/global-original/ideas-' + slug + '.png')).removeAlpha().raw().toBuffer();
 assert(expected.equals(actual), 'Idea preserves every original pixel: ' + slug);
}
for (const page of [globalIdeas]) {
 for (const image of page.matchAll(/<img\b[^>]*src="(\/assets\/global-original\/[^\"]+)"/g)) {
  assert(existsSync(resolve(root, image[1].slice(1))), 'Original image resolves: ' + image[1]);
 }
 assert.doesNotMatch(page, /class="global-idea__copy"|class="global-format__copy"/, 'No duplicate text layered over printed artwork');
}
const originalManifest = JSON.parse(readFileSync(resolve('scripts/global-original-crops.json'), 'utf8'));
assert(originalManifest.protectedRegions?.length >= 3, 'Protect complete labels and paper edges, not just crop pixel identity');
for (const region of originalManifest.protectedRegions) {
 const [left, top, right, bottom] = region.box;
 for (const name of region.crops) {
  const crop = originalManifest.crops[name];
  assert.equal(crop.source, region.source, 'Protected region uses the correct original');
  const [cropLeft, cropTop, cropRight, cropBottom] = crop.box;
  assert(cropLeft <= left && cropTop <= top && cropRight >= right && cropBottom >= bottom, name + ' must retain ' + region.description);
 }
}
for (const [name, crop] of Object.entries(originalManifest.crops)) {
 const [left, top, right, bottom] = crop.box;
 const source = resolve(root, 'assets/global-original', originalManifest.sources[crop.source]);
 const expected = await sharp(source).extract({ left, top, width: right - left, height: bottom - top }).removeAlpha().raw().toBuffer();
 for (const extension of ['png', 'webp']) {
  const actual = await sharp(resolve(root, 'assets/global-original', name + '.' + extension)).removeAlpha().raw().toBuffer();
  assert(expected.equals(actual), 'Original source pixels preserved in ' + name + '.' + extension);
 }
}
console.log('Exact original artwork checks passed: hero, middle sections and all eight idea cards.');

// [SAATHUM-GUIDE-1 2026-09-25] The creator /ideas page (and its /blog/creator-ideas
// articles) was replaced by the Puja & Havan Guide at /rituals. /ideas is now an
// SSR 301 → /rituals, so it has no prerendered file. The creator checks that
// stood here are in git history (c32524ca) for restore.
assert(!existsSync(resolve(root, 'ideas/index.html')), '/ideas is a redirect, not a prerendered page');
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
const ritualLinks = [...new Set([...guide.matchAll(/href="(\/rituals\/[a-z0-9-]+)"/g)].map(m => m[1]))];
assert.equal(ritualLinks.length, 55, 'Every ritual has its own article');
const sitemap = readFileSync(resolve(root,'sitemap-pages.xml'),'utf8');
const sitemapIndex = readFileSync(resolve(root,'sitemap.xml'),'utf8');
assert.match(sitemapIndex,/<sitemapindex/,'sitemap.xml is a sitemap index');
assert(sitemapIndex.includes('https://saathum.com/sitemap-pages.xml'),'Index lists sitemap-pages.xml');
assert(sitemap.includes('<loc>https://saathum.com/rituals</loc>'), 'Guide is in the sitemap');
assert(!sitemap.includes('https://saathum.com/ideas<'), 'Retired /ideas is out of the sitemap');
assert(!sitemap.includes('https://saathum.com/blog/creator-ideas/'), 'Archived creator guides stay out of the sitemap');
assert(!sitemap.includes('https://saathum.com/organisers'), '/organisers archived: not in sitemap');
const ritualImages = new Set();
for (const href of ritualLinks) {
 const slug = href.split('/').pop();
 const article = normalizeBuiltImages(readFileSync(resolve(root, href.slice(1), 'index.html'), 'utf8'), { root });
 assert.equal((article.match(/<h1[ >]/g) || []).length, 1, 'One article heading: ' + href);
 assert.match(article, new RegExp('data-ritual-article="' + slug + '"'), 'Article identity: ' + href);
 for (const section of ['about','blessings','who','when','altar','from-home','prasad','good-to-know']) assert(article.includes('id="' + section + '"'), 'Missing ' + section + ' in ' + href);
 assert.match(article, /avh--sticky/, 'Shared article header: ' + href);
 assert.match(article, /class="bazaar-footer bazaar-footer--folk"/, 'Shared article footer: ' + href);
 assert.match(article, /href="\/marketplace\?q=/, 'Article booking CTA: ' + href);
 assert.match(article, /href="\/refunds"/, 'Refund policy link: ' + href);
 assert.match(article, /internationally/, 'International prasad courier explained: ' + href);
 assert.doesNotMatch(article, /guarantee(?:d|s)? (?:to|that|result|success|cure)|will cure|cures /i, 'No guaranteed outcomes or cures: ' + href);
 assert.equal(meta(article, 'og:type'), 'article');
 assert.match(article, /BreadcrumbList/);
 assert(sitemap.includes('https://saathum.com' + href + '<'), 'Article in sitemap: ' + href);
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
assert.equal(meta(html, 'og:title'), 'Saathum — Sacred Rituals Performed for You, Watched Live', 'A4 og:title (SAATHUM-REBRAND-1)');
assert.equal(meta(html, 'og:description'), 'Book a sacred ritual for exams, home, health, prosperity or peace. Our priests perform it for you at a real altar while you watch live, wherever you are. Prasad delivered to your door.', 'A4 og:description (SAATHUM-REBRAND-1)');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
const ogImageUrl = meta(html, 'og:image');
assert(ogImageUrl, 'Homepage has a share image');
assert.match(ogImageUrl, /saathum-grand\/hero/, 'Homepage share image uses the grand hero artwork');
assert.doesNotMatch(ogImageUrl, /avatok-creator-constellation/, 'Share image is not the retired creator hero (A4.1, D10)');
const ogImagePath = resolve(root, new URL(ogImageUrl).pathname.replace(/^\//, ''));
assert(existsSync(ogImagePath), 'Homepage share image resolves: ' + ogImageUrl);
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
execFileSync(process.execPath, ['scripts/check-organisers.mjs'], { stdio: 'inherit' });
