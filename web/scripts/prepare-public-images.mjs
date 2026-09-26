// Run during the existing authorized CI build: preserve originals, publish immutable copies.
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../', import.meta.url));
const publicDir = join(web, 'public');
const manifest = {};
const inventory = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === '_images' || item.name === '_og-art') continue;
    const source = join(dir, item.name);
    if (item.isDirectory()) { await walk(source); continue; }
    if (!item.isFile() || !/\.(png|jpe?g|webp|avif)$/i.test(item.name)) continue;
    const bytes = await readFile(source);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const target = `/_images/${hash}${extname(item.name).toLowerCase()}`;
    await mkdir(dirname(join(publicDir, target)), { recursive: true });
    await copyFile(source, join(publicDir, target));
    const originalPath = '/' + relative(publicDir, source).split('\\').join('/');
    manifest[originalPath] = target;
    inventory.push({ originalPath, immutablePath: target, originalBytes: bytes.length, sha256: hash, delivery: 'cloudflare-format-auto', measuredSavings: null });
  }
}
await walk(publicDir);
await writeFile(join(web, 'src/lib/publicImageManifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(web, 'image-delivery-report.json'), JSON.stringify({ assets: inventory, note: 'Output bytes/cache hits require post-deployment inspection; no compression claim yet.' }, null, 2) + '\n');
console.log(`Prepared ${Object.keys(manifest).length} immutable public image references`);
