#!/usr/bin/env node
// [SAATHUM-FREEZE-1] Mutates a checkout of web/ IN PLACE so it builds into a
// pure static archive of saathum.com: keeps ONLY the prerenderable public
// information pages (see KEEP_PAGES in freeze-config.mjs), swaps every island
// that talks to the API / Clerk for an empty component, cuts the API host out
// of the build, neutralises the contact form, writes a disallow-all robots.txt
// and a `_redirects` that sends every functional link to the new origin.
//
// Run this ONLY against a throwaway checkout (a fresh CI checkout, or a COPY of
// web/ in a scratch dir). It deletes files and rewrites astro.config.mjs and
// several src files. NEVER point it at the real web/ of a working tree.
//
// Usage: node prepare-source.mjs <path-to-web-dir> [--new-origin=https://...]
//        (NEW_ORIGIN may also come from the environment.)

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  KEEP_PAGES,
  REDIRECT_LIMITS,
  functionalRedirectRules,
  isDynamicRule,
  isRedirectedPath,
  resolveNewOrigin,
} from './freeze-config.mjs';

const TAG = '[saathum-freeze]';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in prepare-source.test.mjs)
// ---------------------------------------------------------------------------

/** Merge web/public/_redirects with the functional rules; returns file text + counts. */
export function buildRedirects(existingText, newOrigin) {
  const { statics, dynamics } = functionalRedirectRules(newOrigin);
  const seen = new Set([...statics, ...dynamics].map(([src]) => src));
  const keptStatic = [];
  const keptDynamic = [];
  for (const raw of (existingText || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [src, destRaw, code = '301'] = parts;
    if (seen.has(src)) continue; // already covered by a functional rule above
    seen.add(src);
    // A retired URL that used to land on a route which is gone from the archive
    // (e.g. /videos -> /marketplace) now lands on the live site instead.
    const dest = destRaw.startsWith('/') && isRedirectedPath(destRaw) ? `${newOrigin}${destRaw}` : destRaw;
    (isDynamicRule(src) ? keptDynamic : keptStatic).push([src, dest, code]);
  }
  const all = {
    statics: [...statics.map(([s, d]) => [s, d, '301']), ...keptStatic],
    dynamics: [...dynamics.map(([s, d]) => [s, d, '301']), ...keptDynamic],
  };
  if (all.statics.length > REDIRECT_LIMITS.static) throw new Error(`_redirects: ${all.statics.length} static rules > ${REDIRECT_LIMITS.static}`);
  if (all.dynamics.length > REDIRECT_LIMITS.dynamic) throw new Error(`_redirects: ${all.dynamics.length} dynamic rules > ${REDIRECT_LIMITS.dynamic}`);
  const fmt = (rules) => rules.map(([s, d, c]) => `${s} ${d} ${c}`).join('\n');
  const text =
    `# [SAATHUM-FREEZE-1] Frozen archive. Every functional path from old emails / WhatsApp /\n` +
    `# bookmarks is sent to the SAME path on the new origin. Pages keeps the incoming query\n` +
    `# string on a redirect whose destination has none. Static rules first, then dynamic\n` +
    `# (Cloudflare requires that order). Limits: ${REDIRECT_LIMITS.static} static / ${REDIRECT_LIMITS.dynamic} dynamic.\n\n` +
    `${fmt(all.statics)}\n\n${fmt(all.dynamics)}\n`;
  return { text, staticCount: all.statics.length, dynamicCount: all.dynamics.length };
}

export const ROBOTS_TXT =
  `# Frozen archive of the previous site. It moved; keep this copy out of search and out of\n` +
  `# AI-crawler answers entirely.\nUser-agent: *\nDisallow: /\n`;

// A kill-switch service worker. The old site registered /sw.js for dashboard users; this
// replaces it so any such browser clears the old caches and unregisters itself.
export const KILL_SWITCH_SW =
  `// [SAATHUM-FREEZE-1] Frozen archive: remove the old service worker and its caches.\n` +
  `self.addEventListener('install', () => self.skipWaiting());\n` +
  `self.addEventListener('activate', (event) => {\n` +
  `  event.waitUntil((async () => {\n` +
  `    try { for (const key of await caches.keys()) await caches.delete(key); } catch (e) { /* best effort */ }\n` +
  `    try { await self.registration.unregister(); } catch (e) { /* best effort */ }\n` +
  `  })());\n` +
  `});\n`;

export const noopIsland = (name) =>
  `// [SAATHUM-FREEZE-1] Frozen archive: this island used to call the API at run time.\n` +
  `// Replaced by a component that renders nothing (it already rendered nothing when\n` +
  `// there was no data), so no API client, auth SDK or chat code reaches the build.\n` +
  `// eslint-disable-next-line @typescript-eslint/no-unused-vars\n` +
  `export default function ${name}(_props?: unknown) {\n  return null;\n}\n`;

export function contactNotice(newOrigin) {
  return (
    `<div class="lg-cform">\n` +
    `        <p class="lg-intro">This is an archived copy of the {BRAND.name} website, so the contact form is switched off. ` +
    `You can still email us at support (@) {BRAND.domain}, or use the contact page on our new site: ` +
    `<a href="${newOrigin}/contact">${newOrigin}/contact</a>. For anything about your data, see our <a href="/privacy">Privacy Policy</a>.</p>\n` +
    `      </div>`
  );
}

/** Rewrite contact.astro: form -> notice, Turnstile + fetch script removed. Throws if the page drifted. */
export function patchContactPage(src, newOrigin) {
  const formRe = /<form id="contact-form"[\s\S]*?<\/form>/;
  if (!formRe.test(src)) throw new Error('contact.astro: <form id="contact-form"> not found — page drifted, update prepare-source.mjs');
  const scriptAt = src.indexOf('<script is:inline src="https://challenges.cloudflare.com');
  if (scriptAt === -1) throw new Error('contact.astro: Turnstile <script> not found — page drifted, update prepare-source.mjs');
  const withoutScripts = src.slice(0, scriptAt).trimEnd() + '\n';
  return withoutScripts.replace(formRe, contactNotice(newOrigin));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function die(msg) {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      removeEmptyDirs(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
    }
  }
}

function patchFile(path, fn, label) {
  if (!existsSync(path)) die(`${label}: ${path} not found — web/ drifted, update prepare-source.mjs`);
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) die(`${label}: pattern not found (no change made) — web/ drifted, update prepare-source.mjs`);
  writeFileSync(path, after);
  console.log(`${TAG} patched ${label}`);
}

function main() {
  const webDir = process.argv[2];
  if (!webDir || webDir.startsWith('--') || !existsSync(join(webDir, 'astro.config.mjs'))) {
    console.error('Usage: node prepare-source.mjs <path-to-web-dir> [--new-origin=https://...]');
    console.error('(expected a saathum web/ checkout — astro.config.mjs not found there)');
    process.exit(1);
  }
  const newOrigin = resolveNewOrigin();
  const src = join(webDir, 'src');
  const pagesDir = join(src, 'pages');

  // 1. Pages: allow-list. Every kept page must exist and must be prerendered.
  const keep = new Set(KEEP_PAGES);
  for (const rel of KEEP_PAGES) {
    const p = join(pagesDir, rel);
    if (!existsSync(p)) die(`kept page "${rel}" not found in src/pages — it was renamed or removed on this ref; update KEEP_PAGES`);
    if (/export\s+const\s+prerender\s*=\s*false/.test(readFileSync(p, 'utf8'))) {
      die(`kept page "${rel}" has prerender = false — it needs the Worker; remove it from KEEP_PAGES`);
    }
  }
  let removed = 0;
  const removedList = [];
  for (const file of walkFiles(pagesDir)) {
    const rel = relative(pagesDir, file).split(sep).join('/');
    if (keep.has(rel)) continue;
    rmSync(file);
    removed++;
    removedList.push(rel);
  }
  removeEmptyDirs(pagesDir);
  console.log(`${TAG} src/pages: kept ${KEEP_PAGES.length}, removed ${removed} files`);
  console.log(removedList.map((r) => `${TAG}   - ${r}`).join('\n'));

  // 2. Islands / mounts that call the API, Clerk or the chat backend -> render nothing.
  const stubs = [
    ['islands/shop/CartButton.tsx', 'CartButton'],
    ['islands/shop/CartDrawer.tsx', 'CartDrawer'],
    ['islands/home/BookNowShelf.tsx', 'BookNowShelf'],
    ['islands/freevideos/FreeVideosRow.tsx', 'FreeVideosRow'],
    ['islands/preeti/PreetiChat.tsx', 'PreetiChat'],
  ];
  for (const [rel, name] of stubs) {
    const p = join(src, rel);
    if (!existsSync(p)) die(`island ${rel} not found — web/ drifted, update prepare-source.mjs`);
    writeFileSync(p, noopIsland(name));
  }
  writeFileSync(
    join(src, 'components', 'PreetiMount.astro'),
    `---\n// [SAATHUM-FREEZE-1] Frozen archive: no chat widget.\n---\n`,
  );
  console.log(`${TAG} replaced ${stubs.length} API-backed islands and PreetiMount with empty components`);

  // 3. Keep the API / auth hosts out of every bundle. Nothing in the archive may name them.
  patchFile(
    join(src, 'lib', 'env.ts'),
    (s) => s.replace(/export const API_BASE: string = [^;\n]*;/, "export const API_BASE: string = ''; // [SAATHUM-FREEZE-1] no API in the archive"),
    'lib/env.ts (API_BASE -> empty)',
  );
  patchFile(
    join(src, 'lib', 'brand.ts'),
    (s) => s.replace(/^(\s*)(apiHost|apiOrigin|authHost|authOrigin): "[^"]*",/gm, '$1$2: "",'),
    'lib/brand.ts (api/auth hosts blanked)',
  );
  // Build-time "starting from" prices: fetched once during the build, never at run time.
  // CI can set FREEZE_PRICING_API to the live API origin to bake the current prices into the
  // HTML; with it unset the fetch fails and the built-in fallback price is used.
  patchFile(
    join(src, 'lib', 'pricing.ts'),
    (s) =>
      s.replace(
        "import { API_BASE } from './env';",
        "// [SAATHUM-FREEZE-1] build-time only; never reaches a browser bundle\nconst API_BASE: string = (typeof process !== 'undefined' && process.env.FREEZE_PRICING_API) || '';",
      ),
    'lib/pricing.ts (build-time API base)',
  );

  // Browser half of the pricing code re-reads /api/pricing on every page view. The archive has no API:
  // keep the price that was baked into the HTML at build time.
  writeFileSync(
    join(src, 'lib', 'pricingClient.ts'),
    '// [SAATHUM-FREEZE-1] Frozen archive: no run-time price refresh; the build-time price stays.\nexport {};\n',
  );
  // The contact form's Turnstile box is gone; drop its CSS rule so the word does not linger in the build.
  patchFile(
    join(src, 'styles', 'legal-folk.css'),
    (s) => s.replace(/^.*turnstile.*\n/gim, ''),
    'styles/legal-folk.css (Turnstile rule removed)',
  );

  // The live prebuild asserts that images resolve through the API origin (scripts/check-image-urls.mjs).
  // The archive has no API origin by design, and its postbuild _routes.json step has no adapter to
  // serve, so both live-site-only steps are dropped from the npm scripts.
  patchFile(
    join(webDir, 'package.json'),
    (s) => s.replace(' && node scripts/check-image-urls.mjs', '').replace(' && node scripts/dedupe-routes-json.mjs', ''),
    'package.json (live-site-only build checks dropped)',
  );

  // 4. Contact page: no form, no Turnstile, no fetch.
  patchFile(join(src, 'pages', 'contact.astro'), (s) => patchContactPage(s, newOrigin), 'pages/contact.astro (form neutralised)');

  // 5. public/: robots, crawler feeds, IndexNow key, service worker, redirects, headers.
  const pub = join(webDir, 'public');
  writeFileSync(join(pub, 'robots.txt'), ROBOTS_TXT);
  for (const name of readdirSync(pub)) {
    if (/^llms.*\.txt$/.test(name) || /^sitemap.*\.xml$/.test(name) || /^[a-f0-9]{32}\.txt$/.test(name)) {
      rmSync(join(pub, name));
      console.log(`${TAG} public/${name}: removed (crawler feed / IndexNow key)`);
    }
  }
  writeFileSync(join(pub, 'sw.js'), KILL_SWITCH_SW);
  const redirectsPath = join(pub, '_redirects');
  const built = buildRedirects(existsSync(redirectsPath) ? readFileSync(redirectsPath, 'utf8') : '', newOrigin);
  writeFileSync(redirectsPath, built.text);
  console.log(`${TAG} public/_redirects: ${built.staticCount} static + ${built.dynamicCount} dynamic rules -> ${newOrigin}`);
  const headersPath = join(pub, '_headers');
  const headers = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : '';
  writeFileSync(headersPath, `${headers.trimEnd()}\n\n# [SAATHUM-FREEZE-1] belt and braces next to the per-page meta tag\n/*\n  X-Robots-Tag: noindex\n`);

  // 6. Static-only Astro config: no adapter, no SSR, no Clerk bundling quirks.
  writeFileSync(
    join(webDir, 'astro.config.mjs'),
    `// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import publicImageCss from './scripts/public-image-css.mjs';
import remarkUiCopy from './scripts/remark-ui-copy.mjs';
import { BRAND } from './src/lib/brand.ts';
import remarkBrand from './src/lib/remarkBrand.mjs';

// [SAATHUM-FREEZE-1] Frozen static archive — see tool/saathum-freeze/README.md.
// No Cloudflare adapter and no SSR: every remaining page is prerendered. Safe
// because prepare-source.mjs deleted every \`prerender = false\` route first.
export default defineConfig({
  site: BRAND.webOrigin,
  output: 'static',
  markdown: { remarkPlugins: [remarkBrand, remarkUiCopy] },
  integrations: [react(), tailwind({ applyBaseStyles: false })],
  vite: { plugins: [publicImageCss()] },
});
`,
  );
  console.log(`${TAG} astro.config.mjs: static-only output (no adapter)`);
  console.log(`${TAG} source prepared. Next: (cd web && npm ci && npm run build), then postprocess-dist.mjs, then check-frozen-build.mjs.`);
}

if (process.argv[1] && process.argv[1].endsWith('prepare-source.mjs')) main();
