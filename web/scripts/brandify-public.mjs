// [SAATHUM-BRAND-CENTRAL-WEB-3] Postbuild: web/public files are copied verbatim into dist, so
// they carry %BRAND_*% tokens instead of the brand. Substitute them from Specs/brand.json in
// the dist copies (public/ itself stays tokenised) and fail if any token is left over.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { BRAND } from './brand.mjs';

const dist = resolve('dist');
const TOKENS = {
  '%BRAND_NAME%': BRAND.name,
  '%BRAND_NAME_COMPACT%': BRAND.nameCompact,
  '%BRAND_DOMAIN%': BRAND.domain,
  '%BRAND_ORIGIN%': BRAND.webOrigin,
  '%BRAND_SUPPORT_EMAIL%': BRAND.emails.support,
};
const TEXT = new Set(['.txt', '.html', '.json', '.webmanifest', '.js', '.mjs', '.xml', '.css', '.svg', '', '.map']);
const SKIP_DIRS = new Set(['_worker.js', '_astro', '_images', '_og-art']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p); }
    else if (TEXT.has(extname(name))) yield p;
  }
}

let changed = 0;
const left = [];
for (const file of walk(dist)) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [token, value] of Object.entries(TOKENS)) after = after.split(token).join(value);
  if (after !== before) { writeFileSync(file, after); changed++; }
  if (/%BRAND_[A-Z_]+%/.test(after)) left.push(file);
}
if (left.length) {
  console.error('brandify-public FAILED — unreplaced %BRAND_*% tokens in:\n  ' + left.join('\n  '));
  process.exit(1);
}
console.log(`brandify-public: substituted brand tokens in ${changed} dist file(s); none left.`);
