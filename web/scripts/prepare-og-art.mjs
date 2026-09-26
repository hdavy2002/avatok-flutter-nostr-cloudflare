// [SEO-OG-ART-1 2026-09-26] Small JPEG copies of the site's own ritual/listing
// artwork for the social-card renderer.
//
// Why this exists: the OG endpoint (/og/<kind>/<key>.png) used to fetch its
// artwork from https://saathum.com/cdn-cgi/image/... — a subrequest from the
// Pages Function back to its own zone's image transformer. That subrequest
// fails inside workerd, so EVERY article card silently fell back to the brand
// hero (header X-SEO-OG-Fallback: art) and WhatsApp showed the same peacock
// picture for the home page and every ritual guide.
//
// The renderer now reads /_og-art/<sha>.jpg straight from the Pages ASSETS
// binding (no network, no transformer). The files are derived from the
// content-addressed /_images/<sha>.<ext> copies, so the name changes whenever
// the source picture changes. Runs after prepare-public-images.mjs.
import { mkdir, readFile, access } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const web = fileURLToPath(new URL('../', import.meta.url));
const publicDir = join(web, 'public');
const outDir = join(publicDir, '_og-art');
const manifest = JSON.parse(await readFile(join(web, 'src/lib/publicImageManifest.json'), 'utf8'));
// Only artwork the OG resolver can actually point at (ritual guides + Saathum listing art).
const eligible = Object.entries(manifest).filter(([original]) => /^\/assets\/saathum[^/]*\//.test(original));

await mkdir(outDir, { recursive: true });
let made = 0;
for (const [, immutable] of eligible) {
  const sha = basename(immutable, extname(immutable));
  const target = join(outDir, `${sha}.jpg`);
  try { await access(target); continue; } catch { /* build it */ }
  await sharp(join(publicDir, immutable))
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff8e8' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(target);
  made++;
}
console.log(`Prepared ${eligible.length} OG artwork copies (${made} new) in public/_og-art`);
