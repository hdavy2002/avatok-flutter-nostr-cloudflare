// CI-only: built browser images/CSS plus SSR/hydrated image callsites. No network.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import ts from 'typescript';
import { validateBuiltImageSources } from './built-image-source.mjs';
const web = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(join(web, 'src/lib/publicImageManifest.json'), 'utf8'));
const source = readFileSync(join(web, 'src/lib/config.ts'), 'utf8')
  .replace("import publicImageManifest from './publicImageManifest.json';", `const publicImageManifest = ${JSON.stringify(manifest)};`)
  .replaceAll('import.meta.env.', '({}).');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { publicImage, cfImage, IMAGE_WIDTHS } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function check(url, file) {
  url = url.replaceAll('&amp;', '&').trim();
  if (!url) return;
  // SVG paint-server fragments (for example url(%23noise)) are not image URLs.
  if (url.startsWith('#') || url.startsWith('%23')) return;
  // Font files are browser resources, not raster images, and are intentionally
  // served as immutable static assets rather than through image transforms.
  if (/\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url)) return;
  const transformed = url.match(/\/cdn-cgi\/image\/([^/]+)\//);
  // Helpers leave signed/private/external/blob/data/vector sources unchanged.
  const eligible = publicImage(url) !== url || cfImage(url) !== url;
  if (!transformed) {
    assert.ok(!eligible, `${relative(web, file)}: untransformed public browser image ${url}`);
    return;
  }
  // A transform of an external/private source is not ours to rewrite.
  if (!eligible && !/format=avif,quality=60,/.test(transformed[1])) return;
  const params = Object.fromEntries(transformed[1].split(',').map(part => part.split('=')));
  assert.equal(params.format, 'avif', `${file}: browser format ${url}`);
  assert.equal(params.quality, '60', `${file}: browser quality ${url}`);
  assert.ok(IMAGE_WIDTHS.includes(Number(params.width)), `${file}: unbounded browser image ${url}`);
}
function checkSrcset(value, file) {
  // CF option commas belong to the URL; candidates are separated after the descriptor.
  for (const match of value.matchAll(/(?:^|,\s+)(\S+?)(?:\s+\d+(?:\.\d+)?[wx])?(?=,\s+|$)/g)) check(match[1], file);
}
for (const file of walk(join(web, 'dist')).filter(file => /\.(html|css)$/.test(file))) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    // Social meta/link unfurls intentionally stay JPEG. Only browser media here.
    for (const tag of text.matchAll(/<(?:img|source|video|image)\b[^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(src|srcset|poster|href)=["']([^"']*)["']/gi)) {
        if (attr[1] === 'srcset') checkSrcset(attr[2], file);
        else if (!/^<video\b/i.test(tag[0]) || attr[1] === 'poster') check(attr[2], file);
      }
    }
  }
  for (const url of text.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g)) check(url[2], file);
}
// These are private reference/chat previews, not publicly cacheable images.
const privatePreviewFiles = new Set([
  'islands/agent-live/AgentTalkRoom.tsx', 'islands/consult-gs/SessionChat.tsx',
  'islands/live-gs/GsChat.tsx', 'islands/vision/session/SnapshotSheet.tsx',
]);
const derived = new Map([
  ['islands/dashboard/MyFavourites.tsx', new Set(['thumb'])],
  ['islands/admin/SubmissionPanel.tsx', new Set(['faceUrl'])],
]);
for (const file of walk(join(web, 'src')).filter(file => /\.(astro|tsx)$/.test(file))) {
  const name = relative(join(web, 'src'), file);
  if (privatePreviewFiles.has(name)) continue;
  const text = readFileSync(file, 'utf8');
  for (const tag of text.matchAll(/<img\b[\s\S]*?\/>/g)) {
    const expr = tag[0].match(/\bsrc=\{([\s\S]*?)\}(?=\s|\/?>)/)?.[1];
    if (!expr || /\b(?:cfImage|publicImage|optimizePublicArtwork)\(/.test(expr)) continue;
    // External QR endpoint is a public listing URL, not a raster artwork source.
    if (expr.startsWith('`https://api.qrserver.com/')) continue;
    assert.ok(derived.get(name)?.has(expr), `${name}: image src expression needs explicit public/private policy: ${expr}`);
  }
}
validateBuiltImageSources(join(web, 'dist'), web);
console.log('Browser image AVIF/q60 coverage, runtime callsites and immutable sources passed');
