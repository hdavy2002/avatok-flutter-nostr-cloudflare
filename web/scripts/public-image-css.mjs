// Rewrite known public raster CSS references before Vite hashes the bundle.
import { readFileSync } from 'node:fs';
const manifestPath = new URL('../src/lib/publicImageManifest.json', import.meta.url);
/** @returns {import('vite').Plugin} */
export default function publicImageCss() {
  let manifest = {};
  return {
    name: 'avatok-public-image-css',
    enforce: 'pre',
    apply: 'build',
    buildStart() { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); },
    transform(code, id) {
      if (process.env.PUBLIC_DISABLE_IMAGE_TRANSFORMS === '1') return null;
      if (!/\.(?:css|astro)(?:\?|$)/.test(id)) return null;
      const next = code.replace(/url\((['"]?)(\/[^)'"\s]+)\1\)/g, (original, quote, path) => {
        const hashed = manifest[path];
        if (!hashed) return original;
        return `url('${'/cdn-cgi/image/format=auto,quality=60,width=1280,fit=scale-down'}${hashed}')`;
      });
      return next === code ? null : { code: next, map: null };
    },
  };
}
