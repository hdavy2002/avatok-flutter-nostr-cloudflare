// Exercise the built Astro endpoint inside workerd. Importing the renderer in
// Node is insufficient: this catches missing WASM modules and bundling defects.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

const entry = resolve('dist/_worker.js/index.js');
assert(existsSync(entry), `Missing built Cloudflare worker: ${entry}`);

const runtime = new Miniflare({
  scriptPath: entry,
  modules: true,
  modulesRules: [
    { type: 'ESModule', include: ['**/*.js', '**/*.mjs'], fallthrough: true },
    { type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true },
  ],
  // Keep these aligned with web/wrangler.toml; nodejs_compat breaks this app's
  // React edge renderer and must not make CI more permissive than production.
  compatibilityDate: '2025-05-05',
  kvNamespaces: ['SESSION'],
  cf: false,
  // The OG route does not read assets; this mirrors Pages' binding defensively.
  serviceBindings: { ASSETS: async () => new Response('Not found', { status: 404 }) },
});

try {
  const response = await runtime.dispatchFetch('https://saathum.com/og/collection/help.png');
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
} finally {
  await runtime.dispose();
}
