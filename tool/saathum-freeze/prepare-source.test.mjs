// [SAATHUM-FREEZE-1] Zero-dependency tests for prepare-source.mjs. Plain `node`.
// Copies ONLY the handful of web/ paths the script touches into a temp dir and runs
// the CLI there — the real web/ is never modified.
//
// Usage: node tool/saathum-freeze/prepare-source.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEEP_PAGES } from './freeze-config.mjs';
import { KILL_SWITCH_SW, ROBOTS_TXT, noopIsland, patchContactPage } from './prepare-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoWeb = join(here, '..', '..', 'web');
const ORIGIN = 'https://new.example';

// --- patchContactPage -----------------------------------------------------------
{
  const src =
    '---\nconst a = 1;\n---\n<Layout>\n<form id="contact-form" class="x">\n<input name="a">\n</form>\n</Layout>\n\n' +
    '<script is:inline src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n' +
    "<script>\nfetch('/api/contact');\n</script>\n";
  const out = patchContactPage(src, ORIGIN);
  assert.doesNotMatch(out, /<form|turnstile|challenges|fetch|<input/i);
  assert.match(out, /<a href="https:\/\/new\.example\/contact">/);
  assert.match(out, /<Layout>[\s\S]*lg-cform[\s\S]*<\/Layout>/);
  assert.throws(() => patchContactPage('<p>nothing</p>', ORIGIN), /drifted/);
  assert.throws(() => patchContactPage('<form id="contact-form"></form>', ORIGIN), /drifted/);
}
console.log('patchContactPage: OK');

assert.match(noopIsland('Foo'), /export default function Foo\(_props\?: unknown\) \{\n {2}return null;/);
assert.match(ROBOTS_TXT, /User-agent: \*\nDisallow: \/\n/);
assert.match(KILL_SWITCH_SW, /unregister\(\)/);
console.log('stubs / robots / service worker: OK');

// --- the CLI on a minimal copy of the real web/ ------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'saathum-prepare-test-'));
  try {
    const web = join(tmp, 'web');
    const paths = [
      'astro.config.mjs', 'package.json', 'public/_redirects', 'public/_headers', 'public/robots.txt',
      'src/pages', 'src/lib/env.ts', 'src/lib/brand.ts', 'src/lib/pricing.ts', 'src/lib/pricingClient.ts',
      'src/styles/legal-folk.css', 'src/components/PreetiMount.astro',
      'src/islands/shop/CartButton.tsx', 'src/islands/shop/CartDrawer.tsx', 'src/islands/home/BookNowShelf.tsx',
      'src/islands/freevideos/FreeVideosRow.tsx', 'src/islands/preeti/PreetiChat.tsx',
    ];
    for (const p of paths) {
      mkdirSync(dirname(join(web, p)), { recursive: true });
      cpSync(join(repoWeb, p), join(web, p), { recursive: true });
    }
    mkdirSync(join(web, 'public'), { recursive: true });
    for (const name of ['llms.txt', 'sitemap.xml', 'a97b91804230a8c71e3bdf763cdfdef1.txt', 'sw.js']) {
      cpSync(join(repoWeb, 'package.json'), join(web, 'public', name));
    }

    const res = spawnSync('node', [join(here, 'prepare-source.mjs'), web], { env: { ...process.env, NEW_ORIGIN: ORIGIN }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const left = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else left.push(relative(join(web, 'src', 'pages'), p).split(sep).join('/'));
      }
    };
    walk(join(web, 'src', 'pages'));
    assert.deepEqual(left.sort(), [...KEEP_PAGES].sort(), 'src/pages holds exactly the kept pages');

    const read = (p) => readFileSync(join(web, p), 'utf8');
    for (const f of ['src/islands/shop/CartButton.tsx', 'src/islands/home/BookNowShelf.tsx', 'src/islands/preeti/PreetiChat.tsx']) {
      assert.match(read(f), /return null/, `${f} is a no-op island`);
    }
    assert.doesNotMatch(read('src/components/PreetiMount.astro'), /PreetiChat/);
    assert.match(read('src/lib/env.ts'), /API_BASE: string = '';/);
    assert.doesNotMatch(read('src/lib/brand.ts'), /api\.|clerk\./i);
    assert.match(read('src/lib/pricing.ts'), /FREEZE_PRICING_API/);
    assert.doesNotMatch(read('src/lib/pricingClient.ts'), /fetch/);
    assert.doesNotMatch(read('src/styles/legal-folk.css'), /turnstile/i);
    assert.doesNotMatch(read('package.json'), /check-image-urls|dedupe-routes-json/);
    assert.doesNotMatch(read('astro.config.mjs'), /@astrojs\/cloudflare|clerk/i);
    assert.match(read('astro.config.mjs'), /output: 'static'/);
    assert.match(read('public/robots.txt'), /Disallow: \/$/m);
    assert.match(read('public/_redirects'), new RegExp(`^/j/\\* ${ORIGIN}/j/:splat 301$`, 'm'));
    assert.match(read('public/_headers'), /X-Robots-Tag: noindex/);
    assert.match(read('public/sw.js'), /unregister/);
    for (const gone of ['llms.txt', 'sitemap.xml', 'a97b91804230a8c71e3bdf763cdfdef1.txt']) {
      assert.equal(existsSync(join(web, 'public', gone)), false, `public/${gone} removed`);
    }

    // not a web dir -> usage error, nothing touched
    const bad = spawnSync('node', [join(here, 'prepare-source.mjs'), tmp], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log('prepare-source CLI on a minimal web/ copy: OK');

console.log('\nAll prepare-source.mjs tests passed.');
