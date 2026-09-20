#!/usr/bin/env node
// [06-FREEZE-AVATOK] Mutates a checkout of web/ IN PLACE so it builds into a
// pure static snapshot of avatok.ai: deletes every route that needs the
// Worker at request time (export const prerender = false), deletes the
// sign-in/checkout/auth pages, forces noindex site-wide, and disallows all
// crawling. Run this ONLY against a throwaway checkout (a fresh CI checkout
// or `git worktree` of the frozen ref) — it deletes files and rewrites
// astro.config.mjs and Base.astro.
//
// Usage: node prepare-source.mjs <path-to-web-dir>
//
// See ../../Specs (this lane's REPORT.md at repo root) for the exact commit
// SHA this exclude list was built from and how it was verified.

import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const webDir = process.argv[2];
if (!webDir || !existsSync(join(webDir, 'astro.config.mjs'))) {
  console.error('Usage: node prepare-source.mjs <path-to-web-dir>');
  console.error('(expected an avatok web/ checkout — astro.config.mjs not found there)');
  process.exit(1);
}

const pagesDir = join(webDir, 'src', 'pages');

// Every one of these either has `export const prerender = false` (needs the
// Worker/D1 at request time) or is part of the auth/checkout funnel. Built
// from `grep -rl "prerender = false" src/pages` on the frozen commit, cross
// -checked against a full recursive listing of src/pages so no static file
// hiding in one of these directories gets swept away by accident.
const EXCLUDE = [
  '[username]', // per-creator dynamic profile pages
  'admin', // admin/agents, admin/listings, admin/reviews — all SSR
  'agent', // agent/[id].astro — dynamic agent profile
  'api', // api/careers-apply.ts, api/contact.ts, api/waitlist.ts — Worker endpoints
  'blog/ai-voice-agents.astro',
  'blog/earn-from-day-one.astro',
  'blog/real-people-safety.astro',
  'book', // book/[id].astro
  'c', // c/[handle].astro
  'consult', // consult/[booking].astro
  'dashboard.astro',
  'dashboard', // whole creator dashboard tree
  'e', // e/[event].astro
  'embed', // embed/listing.astro
  'explore.astro',
  'forgot-password.astro',
  'india.astro', // SSR; india-next.astro (static) stays
  'j', // j/[token].astro
  'l', // l/[id].astro
  'live', // live/[id].astro, live/[id]/host.astro
  'llms-creator-ideas.txt.ts', // AI-crawler feed — contradicts the noindex/disallow-all policy below
  'marketplace.astro',
  'pay', // pay/return.astro
  'session', // session/[booking].astro
  'sign-in.astro',
  'sign-out.astro',
  'sign-up.astro',
  'sitemap-creators.xml.ts', // enumerates live D1 rows at request time
  'sitemap-listings.xml.ts', // enumerates live D1 rows at request time
  'sitemap-pages.xml.ts', // only useful alongside the sitemap index below
  'sitemap.xml.ts', // <sitemapindex> pointing at the three files above
  'sso-callback.astro',
  'talk', // talk/[booking].astro
  'test', // test/upi.astro, test/upi/admin.astro — internal harness
  'vision', // vision/agent, vision/index, vision/session, vision/studio
  'watch', // watch/[id].astro
];

let removed = 0;
for (const rel of EXCLUDE) {
  const p = join(pagesDir, rel);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    removed++;
  } else {
    console.warn(
      `[avatok-freeze] expected to remove "${rel}" but it was not found — ` +
        'src/pages has drifted from the list this script was written against. ' +
        'Re-verify with `grep -rl "prerender = false" src/pages` before trusting this build.',
    );
  }
}
console.log(`[avatok-freeze] removed ${removed}/${EXCLUDE.length} SSR/auth/checkout routes from src/pages`);

// Force every remaining page to noindex, regardless of what it individually
// requests. Base.astro's own `noindex` prop already drives the
// <meta name="robots"> tag and skips the Organization JSON-LD (see that
// file) — pin it to true here instead of editing every page that imports it.
const basePath = join(webDir, 'src', 'layouts', 'Base.astro');
const base = readFileSync(basePath, 'utf8');
const marker = '  noindex = false,\n';
if (!base.includes(marker) || !base.includes('} = Astro.props;')) {
  console.error(
    '[avatok-freeze] layouts/Base.astro has changed shape (noindex default or ' +
      'the Astro.props destructure) — update prepare-source.mjs before trusting this build.',
  );
  process.exit(1);
}
const patchedBase = base
  .replace(marker, '  noindex: _requestedNoindex = false,\n')
  .replace(
    '} = Astro.props;',
    '} = Astro.props;\n\n' +
      '// [AVATOK-FREEZE] This is the frozen avatok.ai archive — avatok.ai moved to\n' +
      '// Saathum and this build is a historical snapshot, not the live site. Every\n' +
      '// page stays out of search no matter what it individually requested.\n' +
      'const noindex = true;',
  );
writeFileSync(basePath, patchedBase);
console.log('[avatok-freeze] layouts/Base.astro: noindex forced true site-wide');

// Disallow all crawling — belt-and-suspenders alongside the per-page meta tag
// above and the dist-level safety net in postprocess-dist.mjs.
writeFileSync(
  join(webDir, 'public', 'robots.txt'),
  `# avatok.ai — frozen historical snapshot.
# avatok.ai moved to Saathum; this is an archive of the old product, not the
# live site. Keep it out of search results and out of AI-crawler answers
# entirely.
User-agent: *
Disallow: /
`,
);
console.log('[avatok-freeze] public/robots.txt: disallow all');

// public/llms.txt is the same kind of AI-crawler discovery feed as
// llms-creator-ideas.txt.ts above (which is deleted via EXCLUDE) — it points
// crawlers at /marketplace and /sitemap.xml, both gone in this build, and its
// whole purpose (surface avaTOK to AI answer engines) contradicts the
// disallow-all/noindex policy this snapshot enforces everywhere else.
const llmsTxtPath = join(webDir, 'public', 'llms.txt');
if (existsSync(llmsTxtPath)) {
  rmSync(llmsTxtPath);
  console.log('[avatok-freeze] public/llms.txt: removed (AI-crawler feed, contradicts disallow-all)');
}

// public/_redirects sends a few retired URLs to /marketplace, which
// prepare-source.mjs just deleted from src/pages. Left alone, an old
// bookmark or backlink would 301 straight into a 404. Every other rule in
// this file already retargets a retired route to somewhere that still
// exists (e.g. /coming-soon -> /, /india -> /), so /marketplace targets get
// the same treatment: send them home instead of into a dead page.
const redirectsPath = join(webDir, 'public', '_redirects');
if (existsSync(redirectsPath)) {
  const redirects = readFileSync(redirectsPath, 'utf8');
  const patchedRedirects = redirects.replace(/^(\S+\s+)\/marketplace(\s+301\s*)$/gm, '$1/$2');
  if (patchedRedirects !== redirects) {
    writeFileSync(redirectsPath, patchedRedirects);
    console.log('[avatok-freeze] public/_redirects: retargeted /marketplace redirects to / (dead route)');
  }
}

// Static-only Astro config: no Cloudflare adapter, no SSR — every remaining
// page is prerendered to plain HTML. Safe because every `prerender = false`
// route was deleted above; leaving the adapter in would make this a Worker
// deploy again, which is exactly what this lane exists to avoid.
writeFileSync(
  join(webDir, 'astro.config.mjs'),
  `// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import publicImageCss from './scripts/public-image-css.mjs';
import remarkUiCopy from './scripts/remark-ui-copy.mjs';

// [AVATOK-FREEZE] Frozen static snapshot of avatok.ai — see
// tool/avatok-freeze/README.md at the repo root. No Cloudflare adapter and no
// SSR: every remaining page is prerendered to plain HTML. The dynamic
// (\`prerender = false\`) routes that needed the Worker — auth, checkout,
// dashboard, marketplace, live/consult/talk/watch, admin, vision, api/*,
// per-user profiles — were deleted from src/pages by prepare-source.mjs
// before this config is read, so \`output: 'static'\` with no adapter is
// valid: nothing left opts into on-demand rendering.
export default defineConfig({
  site: 'https://avatok.ai',
  output: 'static',
  markdown: { remarkPlugins: [remarkUiCopy] },
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  vite: {
    plugins: [publicImageCss()],
  },
});
`,
);
console.log('[avatok-freeze] astro.config.mjs: switched to static-only output (no adapter)');

console.log('[avatok-freeze] source prepared. Next: npm ci && npm run build, then run postprocess-dist.mjs on dist/.');
