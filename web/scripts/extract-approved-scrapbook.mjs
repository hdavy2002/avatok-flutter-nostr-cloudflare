import sharp from 'sharp';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const out = fileURLToPath(new URL('../public/assets/hf-approved-scrapbook/', import.meta.url));
await mkdir(out, { recursive: true });
const source = process.argv[2] || path.join(out, 'approved-reference.png');
if (source !== path.join(out, 'approved-reference.png')) await copyFile(source, path.join(out, 'approved-reference.png'));
const bytes = await readFile(source);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const { width, height } = await sharp(bytes).metadata();
const crops = [];
const rect = (left, top, width, height) => ({ left, top, width, height });
async function crop(name, region, options = {}) {
  let buffer = await sharp(bytes).extract(region).png().toBuffer();
  const patches = options.patches || [];
  for (const patch of patches) {
    const input = await sharp(bytes).extract(patch.source).resize(patch.width, patch.height, { fit: 'fill' }).png().toBuffer();
    buffer = await sharp(buffer).composite([{ input, left: patch.left, top: patch.top }]).png().toBuffer();
  }
  if (options.polygon) {
    const mask = Buffer.from(`<svg width="${region.width}" height="${region.height}"><polygon points="${options.polygon}" fill="white"/></svg>`);
    buffer = await sharp(buffer).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  }
  const output = await sharp(buffer).webp({ quality: 94 }).toBuffer();
  await writeFile(path.join(out, `${name}.webp`), output);
  crops.push({ file: `${name}.webp`, sourceRect: region, patches, polygon: options.polygon || null, width: region.width, height: region.height, sha256: createHash('sha256').update(output).digest('hex') });
}
await crop('paper', rect(410, 0, 165, 39));
await crop('hero-collage', rect(470, 96, 569, 474), { polygon: '84,0 569,0 569,474 49,474 49,406 62,390 58,285 45,211 0,188 0,107 49,100' });
await crop('header-doodle', rect(938, 12, 101, 106));
await crop('hero-doodle', rect(399, 109, 124, 90));
await crop('building-top', rect(0, 59, 96, 160));
await crop('building-side', rect(0, 306, 59, 241));
await crop('privacy-strip', rect(0, 544, 1039, 135), { patches: [{ source: rect(219, 554, 110, 20), left: 160, top: 29, width: 675, height: 81 }] });
await crop('step-watch', rect(34, 740, 321, 190), { patches: [{ source: rect(266, 775, 44, 27), left: 51, top: 77, width: 242, height: 91 }] });
await crop('step-find', rect(365, 740, 305, 190), { patches: [{ source: rect(573, 776, 56, 30), left: 57, top: 77, width: 220, height: 91 }] });
await crop('step-connect', rect(680, 740, 319, 190), { patches: [{ source: rect(927, 775, 37, 29), left: 46, top: 77, width: 253, height: 99 }] });
await crop('step-doodle', rect(738, 674, 196, 73));
await crop('step-leaves', rect(0, 868, 80, 83));
await crop('step-flower', rect(945, 843, 90, 101));
await crop('creator-doodle', rect(736, 950, 197, 55));
for (const [name, left, width] of [['meera', 57, 225], ['kabir', 289, 227], ['ananya', 519, 222], ['rohan', 748, 228]]) {
  await crop(`creator-${name}`, rect(left, 1001, width, 255), { patches: [{ source: rect(185, 1190, 53, 14), left: 12, top: 193, width: width - 25, height: 51 }] });
}
await crop('creators-left', rect(0, 1058, 58, 207));
await crop('creators-right', rect(974, 1068, 65, 203));
await crop('connect-banner', rect(0, 1258, 1039, 213), { patches: [{ source: rect(302, 1340, 70, 90), left: 275, top: 27, width: 500, height: 157 }] });
await writeFile(path.join(out, 'crop-manifest.json'), JSON.stringify({ source: 'approved-reference.png', sourceSha256, sourceDimensions: { width, height }, method: 'Deterministic sharp extraction; patches reuse only blank paper from the same approved source to make room for accessible live text. No generated replacement art.', crops }, null, 2) + '\n');
console.log(`Extracted ${crops.length} approved artwork regions (${sourceSha256}).`);
