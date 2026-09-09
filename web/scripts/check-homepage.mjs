// Production-build smoke check: homepage links, art and archive must resolve.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert.match(html, /data-design="railway-2026-09"/, 'Expected railway homepage');
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
assert.match(html, /data-motion-toggle/, 'Motion pause control exists');
assert.match(html, /class="bazaar-footer"/, 'Existing footer remains');
const archive = readFileSync(resolve(root, 'archive/home-2026-09-09/index.html'), 'utf8');
assert.match(archive, /noindex, nofollow/, 'Archive must not compete in search');
assert.match(archive, /hero-poster-nonav.png/, 'Previous hero remains archived');
console.log('Homepage smoke checks passed: six ideas, anchors, assets, signup, marketplace, footer and archive.');
