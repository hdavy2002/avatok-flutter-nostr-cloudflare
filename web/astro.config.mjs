// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

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
      alias: {
        'react-dom/server': 'react-dom/server.edge',
      },
    },
  },
});
