// Build-only delivery variants. Generated originals remain unchanged.
// Sharp is already pinned by Astro in package-lock.json.
import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const directory = resolve('public/assets/global');
for (const name of (await readdir(directory)).filter(name => name.endsWith('.png'))) {
  if (name === 'creator-marketplace-og.png') continue;
  for (const width of [480, 960]) {
    await sharp(resolve(directory, name))
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toFile(resolve(directory, `${basename(name, '.png')}-${width}.webp`));
  }
}
console.log('Global artwork delivery variants prepared.');
