// Exercise the built Astro endpoint inside workerd. Importing the renderer in
// Node is insufficient: this catches missing WASM modules and bundling defects.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { BRAND, reEscape } from './brand.mjs';

const workerRoot = resolve('dist/_worker.js');
const entry = resolve(workerRoot, 'index.js');
assert(existsSync(entry), `Missing built Cloudflare worker: ${entry}`);

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = resolve(directory, item.name);
    return item.isDirectory() ? walkFiles(path) : [path];
  });
}

function moduleType(path) {
  if (path.endsWith('.wasm')) return 'CompiledWasm';
  if (path.endsWith('.txt')) return 'Text';
  if (path.endsWith('.bin')) return 'Data';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'ESModule';
  return null;
}

// Astro's renderer registry uses a computed dynamic import. Miniflare cannot
// discover those chunks from scriptPath, so register the complete Pages bundle.
const modules = [entry, ...walkFiles(workerRoot).filter((path) => path !== entry)]
  .map((path) => ({ type: moduleType(path), path }))
  .filter((module) => module.type !== null);

const runtime = new Miniflare({
  modules,
  modulesRoot: workerRoot,
  // Keep these aligned with web/wrangler.toml; nodejs_compat breaks this app's
  // React edge renderer and must not make CI more permissive than production.
  compatibilityDate: '2025-05-05',
  kvNamespaces: ['SESSION'],
  cf: false,
  // [SEO-OG-ART-1] The OG route reads the page's own artwork from ASSETS
  // (/_og-art/<sha>.jpg). Serve dist/ exactly like Pages does.
  serviceBindings: {
    ASSETS: async (request) => {
      const path = resolve('dist', '.' + new URL(request.url).pathname);
      if (!path.startsWith(resolve('dist')) || !existsSync(path)) return new Response('Not found', { status: 404 });
      const type = path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      return new Response(readFileSync(path), { headers: { 'Content-Type': type } });
    },
  },
});

try {
  const response = await runtime.dispatchFetch(BRAND.webOrigin + '/og/collection/help.png');
  if (response.status !== 200) assert.fail(`OG endpoint returned ${response.status}: ${await response.text()}`);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-seo-og-fallback'), null, 'OG endpoint silently returned its fallback image');
  assert.match(response.headers.get('x-seo-og-revision') ?? '', /^[a-f0-9]{64}$/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 10_000, 'OG endpoint returned an implausibly small image');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'OG endpoint did not return PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(16), 1200, 'OG runtime image width mismatch');
  assert.equal(view.getUint32(20), 630, 'OG runtime image height mismatch');
  console.log(`OG workerd endpoint OK: ${bytes.byteLength} bytes.`);

  // Exercise SSR pages too: static output checks cannot see this route family.
  const index = await runtime.dispatchFetch(BRAND.webOrigin + '/blog/');
  assert.equal(index.status, 200);
  const indexHtml = await index.text();
  assert.equal((indexHtml.match(/data-idea-card/g) || []).length, 20);
  const links = [...new Set([...indexHtml.matchAll(/href="(\/blog\/[a-z0-9-]+\/)"/g)].map(match => match[1]))];
  assert.equal(links.length, 20, 'Exactly 20 published articles');
  const sitemap = readFileSync(resolve('dist/sitemap-pages.xml'), 'utf8');
  const titles = new Set();
  for (const path of ['/blog/', ...links]) {
    const response = await runtime.dispatchFetch(BRAND.webOrigin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /name="robots" content="noindex/); // [HF-BLOG-ARCHIVE-1] blog archived
    assert(html.includes('href="' + BRAND.webOrigin + path + '"'), 'Canonical matches ' + path);
    assert(!sitemap.includes('<loc>' + BRAND.webOrigin + path + '</loc>'), 'Archived blog out of sitemap: ' + path);
    assert.match(html, /data-callvaal-chrome/);
    assert.doesNotMatch(html, /assets\/rituals|Puja &amp; Havan|prasad|temple priests/i);
    assert.match(html, /application\/ld\+json/);
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/)?.[1];
    assert(title && !titles.has(title), 'Unique title: ' + path);
    titles.add(title);
    if (path !== '/blog/') {
      assert.match(html, /data-blog-article/);
      assert.match(html, /guide-sidebar/);
      assert.match(html, /BreadcrumbList/);
      assert.match(html, /property="og:type" content="article"/);
    }
  }
  for (const path of ['/blog/never-miss-a-call', '/blog/creator-ideas/old-post', '/blog/unknown-retired-post/', '/rituals/ganapati-havan/', '/rituals/navagraha-havan', '/rituals/unknown/nested', '/llms-rituals.txt']) {
    const response = await runtime.dispatchFetch(BRAND.webOrigin + path);
    assert.equal(response.status, 410, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  }
  for (const path of ['/rituals', '/rituals/']) {
    const response = await runtime.dispatchFetch(BRAND.webOrigin + path, { redirect: 'manual' });
    assert.equal(response.status, 301, path);
    assert.equal(new URL(response.headers.get('location'), BRAND.webOrigin).pathname, '/blog/');
  }
  console.log('Blog runtime contract OK: 20 articles, metadata, discovery and retired routes.');
} finally {
  await runtime.dispose();
}
