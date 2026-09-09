// Production-build smoke check: homepage links, art and archive must resolve.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert.match(html, /data-design="station-static-2026-09"/, 'Expected railway homepage');
assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'One readable main heading');
assert.equal((html.match(/data-home-idea=/g) || []).length, 6, 'Six earning ideas');
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
assert.match(html, /href="\/sign-up"/, 'Signup remains reachable');
assert.match(html, /href="\/marketplace/, 'Marketplace remains reachable');
assert.doesNotMatch(html, /data-motion-toggle|data-rail-train/, 'Old train animation removed');
assert.match(html, /station-art/, 'Static station artwork exists');
assert.match(html, /class="bazaar-footer"/, 'Existing footer remains');
const archive = readFileSync(resolve(root, 'archive/home-2026-09-09/index.html'), 'utf8');
assert.match(archive, /noindex, nofollow/, 'Archive must not compete in search');
assert.match(archive, /hero-poster-nonav.png/, 'Previous hero remains archived');
console.log('Homepage smoke checks passed: six ideas, anchors, assets, signup, marketplace, footer and archive.');

// Creator inspiration is a separate editorial route, never fake marketplace inventory.
const ideas = readFileSync(resolve(root, 'ideas/index.html'), 'utf8');
assert.equal((ideas.match(/data-idea-card/g) || []).length, 115, 'All 115 creator ideas are present');
assert.equal((ideas.match(/<h1[ >]/g) || []).length, 1, 'Ideas page has one main heading');
assert.match(html, /href="\/ideas"[^>]*data-home-cta="hero-ideas"/, 'Hero links to the ideas page');
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

const sitemap = readFileSync(resolve(root,'sitemap.xml'),'utf8');
for (const href of new Set(guideLinks)) assert(sitemap.includes('https://avatok.ai'+href),'Guide missing from sitemap: '+href);
for (const match of ideas.matchAll(/src="(\/assets\/ideas\/guides\/[^"]+)"/g)) {
 assert(existsSync(resolve(root,match[1].slice(1))),'Missing responsive card image: '+match[1]);
}
