// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import publicImageCss from './scripts/public-image-css.mjs';
import remarkUiCopy from './scripts/remark-ui-copy.mjs';

// [WEB-DEVSERVER-1 2026-08-26] Is this `astro dev`, as opposed to build/preview?
// The `react-dom/server` → `.edge` alias below is REQUIRED for the Cloudflare
// Workers build but makes `astro dev` fail with "require is not defined" on
// every page: dev renders SSR in plain Node, and `react-dom/server.edge.js` is
// not loadable there. The result was a 500 on every route locally, which is why
// a local preview appeared impossible. Scope the alias to non-dev so `npm run
// dev` works and the deployed bundle is byte-for-byte unchanged.
const isDev = process.argv.includes('dev');

// saathum.com public web client.
//
// "hybrid" rendering on Astro 5 = `output: 'static'` + a server adapter:
// every page is prerendered to static HTML by default (fast, edge-cached),
// and a page opts INTO on-demand SSR with `export const prerender = false`.
// This keeps the marketplace shippable as HTML while letting auth'd islands
// (book / watch / consult / agent) run on the Cloudflare edge.
export default defineConfig({
  site: 'https://saathum.com',
  output: 'static',
  markdown: { remarkPlugins: [remarkUiCopy] },
  adapter: cloudflare({
    imageService: 'passthrough',
    // [SAATHUM-GUIDE-2 2026-09-25] The site sits at Cloudflare's 100-rule
    // _routes.json ceiling, so Astro's per-page excludes overflowed and every
    // prerendered /rituals/<slug> article went to the Function — which 404s.
    // One wildcard keeps all 55 guide articles on the static asset path.
    // Keep this; check-homepage.mjs asserts it.
    routes: { extend: { exclude: [{ pattern: '/rituals/*' }, { pattern: '/blog/creator-ideas/*' }] } }, // /blog/creator-ideas/* is all prerendered (archived guides) — one wildcard frees ~85 rules
  }),
  integrations: [
    react(),
    tailwind({
      // We own the base layer in src/styles/global.css (fonts + resets).
      applyBaseStyles: false,
    }),
  ],
  vite: {
    plugins: [publicImageCss()],
    build: {
      rollupOptions: {
        output: {
          // [WEB-SEO-AUTO-1] cf-workers-og imports its Workers-safe WASM from an
          // entry named `index`. The Cloudflare adapter tracks WASM rewrites by
          // Rollup chunk name, while this app also has a browser chunk named
          // `index`; that collision makes the adapter look for the browser file
          // inside _worker.js. Give the server-only OG runtime a stable,
          // collision-free chunk name. This is harmless in the client build,
          // where cf-workers-og is never imported.
          manualChunks(id) {
            if (id.includes('/node_modules/cf-workers-og/')) return 'og-renderer';
          },
        },
      },
    },
    ssr: {
      // Clerk's React SDK MUST be bundled into the SSR worker. Marking it
      // `external` makes the Cloudflare worker `import '@clerk/clerk-react'` at
      // runtime, but there is no node_modules on the edge → "No such module
      // chunks/@clerk/clerk-react" and a 500 on every page that renders an island
      // shell. `noExternal` forces Vite to bundle it into the worker instead.
      noExternal: ['@clerk/clerk-react'],
    },
    resolve: {
      // React 19's `react-dom/server.browser` constructs a `MessageChannel` at
      // module-init time, which Cloudflare Workers do not expose during worker
      // startup → "MessageChannel is not defined" and a 500 on every route.
      // The `.edge` build is purpose-built for edge runtimes and avoids it.
      //
      // DEV EXCEPTION ([WEB-DEVSERVER-1], see isDev above): `astro dev` renders
      // in Node, where the `.edge` build throws "require is not defined" — so
      // the fix for production was breaking local preview. Node's default
      // `react-dom/server` is correct in dev and never ships.
      alias: isDev ? {} : {
        'react-dom/server': 'react-dom/server.edge',
      },
    },
  },
});
