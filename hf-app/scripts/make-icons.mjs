// Renders the app icon and splash sources into assets/ (PNG), from the website's own
// favicon artwork (speech bubble + phone). Then `capacitor-assets generate --android` makes the
// Android resources. Run via `npm run icons`. Needs `sharp` (installed with @capacitor/assets).
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const sharp = require('sharp');
const out = resolve(root, 'assets');
mkdirSync(out, { recursive: true });

const RED = '#b73226';
const CREAM = '#fff8e8';
const BUBBLE = 'M32 2a29 29 0 0 0-25 44L3 62l17-6A29 29 0 1 0 32 2Z';
const PHONE = 'm19 16 7 10-5 5c3 6 7 10 13 13l5-5 10 7-3 7c-2 4-9 2-16-1C17 45 10 35 9 24c0-5 3-8 10-8Z';

// Phone glyph (white stroke) centred on a 1024 canvas, ~44% wide: inside the adaptive-icon safe zone.
const glyph = (size, widthPx) => {
  const k = widthPx / 41;
  const c = size / 2;
  return `<path d="${PHONE}" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"
    transform="translate(${c} ${c}) scale(${k}) translate(-29.5 -33.5)"/>`;
};
const svg = (size, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);

const jobs = {
  // legacy launcher icon (Android 7): full red square + glyph
  'icon-only.png': svg(1024, `<rect width="1024" height="1024" fill="${RED}"/>${glyph(1024, 520)}`),
  // adaptive icon layers
  'icon-foreground.png': svg(1024, glyph(1024, 700)),
  'icon-background.png': svg(1024, `<rect width="1024" height="1024" fill="${RED}"/>`),
  // splash: cream background, the full bubble logo in the middle
  'splash.png': svg(2732, `<rect width="2732" height="2732" fill="${CREAM}"/>
    <g transform="translate(${2732 / 2 - 256} ${2732 / 2 - 256}) scale(8)"><path fill="${RED}" d="${BUBBLE}"/>
    <path d="${PHONE}" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round" transform="translate(7 0) scale(.84)"/></g>`),
};
jobs['splash-dark.png'] = jobs['splash.png'];

for (const [name, buf] of Object.entries(jobs)) {
  await sharp(buf).png().toFile(resolve(out, name));
  console.log('wrote assets/' + name);
}
