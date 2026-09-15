// Production-build smoke check: homepage links, art and archive must resolve.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve('dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert.match(html, /data-design="creator-marketplace-2026-09"/, 'Expected creator marketplace homepage');
assert.doesNotMatch(html, /In India\? Open your India experience/, 'Removed standalone India callout stays removed');
assert.match(html, /href="\/india"/, 'India remains available through global navigation');
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One readable main heading');
assert.equal((html.match(/class="category-cutout"/g) || []).length, 8, 'Eight illustrated creator categories');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
  const href = match[1].replaceAll('&amp;', '&');
  if (href.startsWith('#') || href.startsWith('/#')) {
    assert(ids.has(href.split('#')[1]), 'Missing homepage anchor: ' + href);
  }
}
for (const name of ['approved-hero.jpg', 'approved-ideas.jpg', 'creator-train.jpg']) {
  assert(existsSync(resolve(root, 'assets/railway', name)), 'Missing art: ' + name);
}
assert.match(html, /href="\/sign-up(?:\?|\")/, 'Signup remains reachable');
assert.match(html, /href="\/marketplace/, 'Marketplace remains reachable');
assert.match(html, /href="\/marketplace/, 'Marketplace remains reachable from global homepage');
assert.doesNotMatch(html, /data-motion-toggle|data-rail-train/, 'Old train animation removed');
assert.match(html, /<img\b[^>]*src="\/assets\/global-retro\/creator-club-clean\.png"/, 'Approved global hero is visible');
assert.match(html, /aria-controls="mobile-menu"/, 'Mobile menu is accessible');
assert.match(html, /href="\/sign-up\?role=creator(?:&amp;|&#38;|&)country=global"/, 'Creator CTA carries global country');
assert.doesNotMatch(html, /start-dialog|This design preview|noindex/, 'Production page has no preview placeholder or search exclusion');
for (const name of ['creator-club-clean', 'live-stage-70s', 'private-session-80s', 'group-session-90s', 'local-payday']) {
 assert(html.includes('/assets/global-retro/' + name + '.png'), 'Approved illustration is visible: ' + name);
 assert(existsSync(resolve(root, 'assets/global-retro', name + '.png')), 'Approved illustration resolves: ' + name);
}
assert.equal((html.match(/<header\b/g) || []).length, 1, 'Exactly one homepage header');
assert.equal((html.match(/<footer\b/g) || []).length, 1, 'Exactly one homepage footer');
for (const name of ['hero-creators', 'format-live', 'format-call', 'format-paid', 'payout-world', 'creator-marketplace-og']) {
 assert(existsSync(resolve(root, 'assets/global', name + '.png')), 'Missing global artwork: ' + name);
}
for (const image of html.matchAll(/<img\b[^>]*src="(\/assets\/global\/[^\"]+)"/g)) {
 assert(existsSync(resolve(root, image[1].slice(1))), 'Visible global artwork resolves: ' + image[1]);
 for (const width of [480, 960]) {
  const variant = image[1].replace(/\.png$/, '-' + width + '.webp');
  assert(existsSync(resolve(root, variant.slice(1))), 'Responsive artwork exists: ' + variant);
 }
}
const india = readFileSync(resolve(root, 'india/index.html'), 'utf8');
assert.match(india, /avatok-creator-constellation\.png/, 'Original India creator artwork remains');
assert.doesNotMatch(india, /\/assets\/global(?:-original)?\//, 'Global artwork must not replace the India design');
assert.equal((india.match(/<header\b/g) || []).length, 1, 'India retains one header');
assert.equal((india.match(/<footer\b/g) || []).length, 1, 'India retains one footer');
const indiaFooter = india.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || '';
const globalFooter = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || '';
for (const navigation of indiaFooter.matchAll(/<nav\b[\s\S]*?<\/nav>/g)) {
 for (const link of navigation[0].matchAll(/href="([^"]+)"/g)) {
  assert(globalFooter.includes('href="' + link[1] + '"'), 'Existing footer destination preserved globally: ' + link[1]);
 }
}
assert.match(html, /class="[^"]*bazaar-footer/, 'Existing footer remains');
const archive = readFileSync(resolve(root, 'archive/home-2026-09-09/index.html'), 'utf8');
assert.match(archive, /noindex, nofollow/, 'Archive must not compete in search');
assert.match(archive, /hero-poster-nonav.png/, 'Previous hero remains archived');
console.log('Homepage smoke checks passed: eight ideas, real artwork, anchors, signup, marketplace, India and archive.');

const globalIdeas = readFileSync(resolve(root, 'global-ideas/index.html'), 'utf8');
assert.equal((globalIdeas.match(/<header\b/g) || []).length, 1, 'Global catalog has no duplicate header');
assert.equal((globalIdeas.match(/<footer\b/g) || []).length, 1, 'Global catalog has no duplicate footer');
const globalLinks = [...globalIdeas.matchAll(/href="(\/blog\/global-creator-ideas\/[^\"]+)"/g)].map(m => m[1]);
assert.equal(new Set(globalLinks).size, 8, 'Eight distinct global guides');
const globalImageHashes = new Set();
for (const href of globalLinks) {
 const slug = href.split('/').filter(Boolean).at(-1);
 const page = readFileSync(resolve(root, href.slice(1), 'index.html'), 'utf8');
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
for (const page of [html, globalIdeas]) {
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

// Creator inspiration is a separate editorial route, never fake marketplace inventory.
const ideas = readFileSync(resolve(root, 'ideas/index.html'), 'utf8');
assert.equal((ideas.match(/data-idea-card/g) || []).length, 115, 'All 115 creator ideas are present');
assert.equal((ideas.match(/<h1[ >]/g) || []).length, 1, 'Ideas page has one main heading');
assert.equal((ideas.match(/class="idea-title-line(?: |")/g) || []).length, 2, 'Ideas hero keeps both headline phrases on horizontal lines');
assert.match(html, /href="\/global-ideas/, 'Global homepage links to the global ideas page');
assert.match(ideas, /class="bazaar-footer"/, 'Ideas uses shared footer');
assert.match(ideas, /avh--sticky/, 'Ideas uses shared header');
assert.match(ideas, /id="idea-search"/, 'Search has an accessible input');
assert.match(ideas, /data-topic="daily"/, 'Daily-life ideas included');
for (const format of ['live','private','group']) assert.match(ideas, new RegExp('data-format="' + format + '"'), 'Missing format ' + format);
assert(existsSync(resolve(root,'assets/ideas/creator-atlas.jpg')), 'Creator illustration atlas exists');
console.log('Creator ideas checks passed: 115 cards, three formats, shared chrome, artwork and hero link.');

// Every idea links to an individually illustrated, prerendered article.
const guideLinks = [...ideas.matchAll(/href="(\/blog\/creator-ideas\/[^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(guideLinks).size,115,'Every idea has its own article');
const imagePaths = new Set();
const imageHashes = new Set();
for (const href of new Set(guideLinks)) {
 const article = readFileSync(resolve(root,href.slice(1),'index.html'),'utf8');
 assert.equal((article.match(/<h1[ >]/g)||[]).length,1,'One article heading: '+href);
 assert.match(article,/data-creator-guide="idea-\d+"/,'Article identity');
 assert.match(article,/avh--sticky/,'Shared article header');
 assert.match(article,/class="bazaar-footer"/,'Shared article footer');
 for (const section of ['offer','plan','equipment','return','earnings','start']) assert(article.includes('id="'+section+'"'),'Missing '+section+' in '+href);
 const hero = article.match(/<figure class="guide-hero">[\s\S]*?<img[^>]+src="([^"]+)"/);
 assert(hero,'Article hero: '+href);
 assert(!imagePaths.has(hero[1]),'Repeated article artwork: '+hero[1]);
 imagePaths.add(hero[1]);
 const bytes = readFileSync(resolve(root,hero[1].slice(1)));
 const hash = createHash('sha256').update(bytes).digest('hex');
 assert(!imageHashes.has(hash),'Duplicate image bytes: '+hero[1]);
 imageHashes.add(hash);
 assert.match(article,/BlogPosting/,'Article structured data');
 assert.match(article,/href="\/pricing"/,'Pricing information link');
 assert.doesNotMatch(article,/data-earnings-example|₹|20%|10,000/,'No unresolved fee or earnings figures in articles');
 assert.doesNotMatch(article,/guide-earnings-slot/,'No empty earnings placeholder');
 assert.match(article,/href="\/sign-up"/,'Article creator CTA');
 assert.doesNotMatch(article,/creator-atlas\.jpg/,'No repeated atlas artwork');
}
assert.doesNotMatch(ideas,/creator-atlas\.jpg/,'No repeated atlas on idea cards');
console.log('115 unique article routes, hero images, sections and shared chrome passed.');

// [WEB-SEO-3] /sitemap.xml is now a sitemapindex; the static page URLs live in
// /sitemap-pages.xml. Check both exist and that the index points at the pages file.
const sitemapIndex = readFileSync(resolve(root,'sitemap.xml'),'utf8');
assert.match(sitemapIndex,/<sitemapindex/,'sitemap.xml is a sitemap index');
assert(sitemapIndex.includes('https://avatok.ai/sitemap-pages.xml'),'Index lists sitemap-pages.xml');
const sitemap = readFileSync(resolve(root,'sitemap-pages.xml'),'utf8');
for (const href of new Set(guideLinks)) assert(sitemap.includes('https://avatok.ai'+href),'Guide missing from sitemap: '+href);
for (const match of ideas.matchAll(/src="(\/assets\/ideas\/guides\/[^"]+)"/g)) {
 assert(existsSync(resolve(root,match[1].slice(1))),'Missing responsive card image: '+match[1]);
}

// Share previews and machine-readable discovery must match visible articles.
function meta(page, key) {
 const tags = page.match(/<meta\b[^>]*>/g) || [];
 const tag = tags.find(tag => tag.includes('property="'+key+'"') || tag.includes('name="'+key+'"'));
 return tag?.match(/content="([^"]*)"/)?.[1];
}
for (const href of new Set(guideLinks)) {
 const page = readFileSync(resolve(root,href.slice(1),'index.html'),'utf8');
 const hero = page.match(/<figure class="guide-hero">[\s\S]*?<img[^>]+src="([^"]+)"/)[1];
 assert.equal(meta(page,'og:image'),'https://avatok.ai'+hero,'Hero and OG image match');
 assert.equal(meta(page,'twitter:image'),meta(page,'og:image'));
 assert.equal(meta(page,'og:type'),'article');
 assert(meta(page,'og:title') && meta(page,'og:description'),'Share title and description');
 assert.equal(meta(page,'description'),meta(page,'og:description'));
 assert.equal(meta(page,'og:image:width'),'1536');
 assert.equal(meta(page,'og:image:height'),'1024');
 assert.match(page,/BreadcrumbList/);
 assert.match(page,/datePublished/);
 const index = readFileSync(resolve(root,'llms-creator-ideas.txt'),'utf8');
 assert(index.includes('https://avatok.ai'+href),'AI-readable article index');
}
assert.match(ideas,/CollectionPage/);
assert.match(ideas,/ItemList/);
assert(meta(ideas,'og:image')?.includes('/assets/ideas/guides/'),'Ideas-specific preview image');
assert.equal(meta(ideas,'twitter:image'),meta(ideas,'og:image'));
assert(meta(ideas,'og:title') && meta(ideas,'og:description'));
console.log('Sharing metadata and discovery checks passed for ideas and all 115 articles.');

// [WEB-GANESH-OG-2] One compact preview prevents WhatsApp choosing the tall poster.
const campaignImages = [...html.matchAll(/<meta property="og:image" content="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(campaignImages, [
 'https://avatok.ai/assets/global-original/hero-source.png',
], 'Global homepage advertises one creator preview image');
assert.equal(meta(html, 'og:title'), 'Turn your influence into live &#38; 1:1 income · avaTOK');
assert.equal(meta(html, 'og:description'), 'AvaTOK helps influencers earn from their audience through paid live streams and private 1:1 video sessions, with flexible pricing and local payouts.');
assert.equal(meta(html, 'twitter:title'), meta(html, 'og:title'));
assert.equal(meta(html, 'twitter:image'), campaignImages[0]);
assert.equal(meta(html, 'description'), meta(html, 'og:description'));
assert.equal(meta(html, 'og:image:width'), '1536');
assert.equal(meta(html, 'og:image:height'), '1024');
for (const image of campaignImages) {
 const bytes = readFileSync(resolve(root, new URL(image).pathname.slice(1)));
 assert(bytes.length > 1000, 'Global creator preview image is present');
}
console.log('Global homepage title, description and selected creator image passed.');
