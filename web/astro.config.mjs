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
      // Clerk's React SDK ships browser globals; keep it out of the SSR bundle
      // graph so prerendering the shell doesn't choke. Islands hydrate client-side.
      external: ['@clerk/clerk-react'],
    },
  },
});
