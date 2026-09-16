import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

function manifestFor(cwd = '.') {
  const file = resolve(cwd, 'src/lib/publicImageManifest.json');
  assertFile(file, 'Generated public image manifest');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(Object.entries(manifest).map(([original, immutable]) => [immutable, original]));
}

function assertFile(file, label) {
  if (!existsSync(file)) throw new Error(`${label} missing: ${file}`);
}

function validateUrl(url, root, reverse, cwd) {
  const decoded = decodeURIComponent(url);
  const match = decoded.match(/^\/cdn-cgi\/image\/[^/]+(\/_images\/[^?#"'<>\s]+)/);
  // API media can also use Cloudflare transforms; only our content-addressed
  // public originals are owned by this check.
  if (!match) return url;
  const immutable = match[1];
  const name = immutable.split('/').at(-1);
  if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp|avif)$/i.test(name)) {
    throw new Error(`Malformed immutable image source: ${immutable}`);
  }
  const original = reverse.get(immutable);
  if (!original) throw new Error(`Image transform source is absent from publicImageManifest: ${immutable}`);
  const file = resolve(root, '.' + immutable);
  assertFile(file, `Immutable image source for ${url}`);
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  const expected = name.split('.')[0];
  if (actual !== expected) throw new Error(`Immutable image hash mismatch for ${immutable}`);
  const originalFile = resolve(cwd, 'public' + original);
  assertFile(originalFile, `Original public image source for ${immutable}`);
  const originalHash = createHash('sha256').update(readFileSync(originalFile)).digest('hex');
  if (originalHash !== actual) throw new Error(`Immutable image differs from original source: ${original}`);
  return original;
}

export function normalizeBuiltImages(html, { root = resolve('dist'), cwd = '.' } = {}) {
  const reverse = manifestFor(cwd);
  return html.replace(/\/cdn-cgi\/image\/[^"'<>\s]+/g, (url) => validateUrl(url, root, reverse, cwd));
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(file);
  }
  return files;
}

export function validateBuiltImageSources(root = resolve('dist'), cwd = '.') {
  for (const file of walk(root)) normalizeBuiltImages(readFileSync(file, 'utf8'), { root, cwd });
}
