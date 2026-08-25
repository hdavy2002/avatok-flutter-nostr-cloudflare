// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

// [WEB-DEVSERVER-1 2026-08-26] Is this `astro dev`, as opposed to build/preview?
// The `react-dom/server` → `.edge` alias below is REQUIRED for the Cloudflare
// Workers build but makes `astro dev` fail with "require is not defined" on
// every page: dev renders SSR in plain Node, and `react-dom/server.edge.js` is
// not loadable there. The result was a 500 on every route locally, which is why
// a local preview appeared impossible. Scope the alias to non-dev so `npm run
// dev` works and the deployed bundle is byte-for-byte unchanged.
const isDev = process.argv.includes('dev');

// avatok.ai public web client.
//
// "hybrid" rendering on Astro 5 = `output: 'static'` + a server adapter:
// every page is prerendered to static HTML by default (fast, edge-cached),
// and a page opts INTO on-demand SSR with `export const prerender = false`.
// This keeps the marketplace shippable as HTML while letting auth'd islands
// (book / watch / consult / agent) run on the Cloudflare edge.
export default defineConfig({
  site: 'https://avatok.ai',
  output: 'static',
  adapter: cloudflare({
    imageService: 'passthrough',
  }),
  integrations: [
    react(),
    tailwind({
      // We own the base layer in src/styles/global.css (fonts + resets).
      applyBaseStyles: false,
    }),
  ],
  vite: {
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
