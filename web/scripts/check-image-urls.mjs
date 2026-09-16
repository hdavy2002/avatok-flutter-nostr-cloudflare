// CI-only regression checks. Does not fetch images or deploy anything.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = (await readFile(new URL('../src/lib/config.ts', import.meta.url), 'utf8'))
  .replace("import publicImageManifest from './publicImageManifest.json';", 'const publicImageManifest = {};')
  .replaceAll('import.meta.env.', '({}).');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { cfImage, publicImage, publicImageSrcSet } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
assert.match(publicImage('/auth/horn-ok-please.png'), /^\/cdn-cgi\/image\//);
assert.match(cfImage('/public/poster.webp'), /^https:\/\/api\.avatok\.ai\/cdn-cgi\/image\//);
assert.match(cfImage('https://avatok.ai/poster.webp'), /^https:\/\/avatok\.ai\/cdn-cgi\/image\//);
for (const path of ['https://evilavatok.ai/a.jpg', 'https://avatok.ai.evil.test/a.jpg',
  'data:image/png;base64,AA', 'https://api.avatok.ai/api/media/private-read?sig=keep',
  'https://api.avatok.ai/private/photo.jpg', 'https://avatok.ai/a.webp?signature=keep']) {
  assert.equal(cfImage(path), path);
  assert.equal(publicImage(path), path);
}
const once = publicImage('/auth/poster.png', { width: 641, fit: 'contain' });
assert.match(once, /width=900,fit=contain/);
assert.equal(publicImage(once), once);
assert.equal(cfImage('https://avatok.ai' + once), 'https://avatok.ai' + once);
assert.equal(publicImage('/mask.svg'), '/mask.svg');
assert.equal(publicImageSrcSet('/a.jpg', [639, 640]).split(', ').length, 1);
console.log('Image URL origin, privacy, idempotence and bounded variant checks passed');

// Browser policy, legacy transform normalization, explicit social exception.
for (const fn of [publicImage, cfImage]) {
  assert.match(fn('https://avatok.ai/poster.jpg', { quality: 95, format: 'webp', width: 99999 }), /format=avif,quality=60,width=2048/);
  assert.match(fn('https://avatok.ai/poster.jpg', { format: 'jpeg', quality: 75 }), /format=jpeg,quality=75/);
  assert.match(fn('https://avatok.ai/cdn-cgi/image/format=auto,quality=80,width=640,fit=contain/poster.jpg'), /format=avif,quality=60,width=640,fit=contain/);
  for (const path of [
    'https://blossom.avatok.ai/u/user/dm/photo.png',
    'https://blossom.avatok.ai/u/user/ava-readable/photo.png',
    'https://blossom.avatok.ai/u/user/%70rivate/photo.png',
    'https://unknown.avatok.ai/photo.png',
    'https://avatok.ai/cdn-cgi/image/width=900/https://external.test/a.png',
    'https://api.avatok.ai/public/photo.png?X-Amz-Signature=keep',
    'https://api.avatok.ai/public/photo.svg',
    'https://api.avatok.ai/public/photo.gif', 'blob:https://avatok.ai/local',
  ]) assert.equal(fn(path), path, `Must preserve private/external source: ${path}`);
}
assert.match(cfImage('https://blossom.avatok.ai/u/user/public/abc'), /format=avif,quality=60/);
assert.match(cfImage('https://blossom-staging.avatok.ai/u/user/public/posters/listing/a.png'), /format=avif,quality=60/);
assert.equal(cfImage('https://api.avatok.ai/account/photo.jpg'), 'https://api.avatok.ai/account/photo.jpg');
assert.equal(publicImageSrcSet('/a.jpg', [0, NaN, -1, 160, 160]), publicImage('/a.jpg', { width: 160 }) + ' 160w');
