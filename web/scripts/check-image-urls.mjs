// CI-only regression checks. Does not fetch images or deploy anything.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { configSource } from './config-source.mjs';
const source = configSource()
  .replace("import publicImageManifest from './publicImageManifest.json';", 'const publicImageManifest = {};')
  .replaceAll('import.meta.env.', '({}).')
  // [SAATHUM-BRAND-CENTRAL-WEB-1] config.ts imports BRAND; inline it (data: modules cannot resolve './brand').
  .replace("import { BRAND } from './brand';", await readFile(new URL('../src/lib/brand.ts', import.meta.url), 'utf8'));
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { cfImage, publicImage, publicImageSrcSet } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
assert.match(publicImage('/auth/horn-ok-please.png'), /^\/cdn-cgi\/image\//);
assert.match(cfImage('/public/poster.webp'), /^https:\/\/api\.saathum\.com\/cdn-cgi\/image\//);
assert.match(cfImage('https://saathum.com/poster.webp'), /^https:\/\/saathum\.com\/cdn-cgi\/image\//);
for (const path of ['https://evilsaathum.com/a.jpg', 'https://saathum.com.evil.test/a.jpg',
  'data:image/png;base64,AA', 'https://api.saathum.com/api/media/private-read?sig=keep',
  'https://api.saathum.com/private/photo.jpg', 'https://saathum.com/a.webp?signature=keep']) {
  assert.equal(cfImage(path), path);
  assert.equal(publicImage(path), path);
}
const once = publicImage('/auth/poster.png', { width: 641, fit: 'contain' });
assert.match(once, /width=900,fit=contain/);
assert.equal(publicImage(once), once);
assert.equal(cfImage('https://saathum.com' + once), 'https://saathum.com' + once);
assert.equal(publicImage('/mask.svg'), '/mask.svg');
assert.equal(publicImageSrcSet('/a.jpg', [639, 640]).split(', ').length, 1);
console.log('Image URL origin, privacy, idempotence and bounded variant checks passed');
