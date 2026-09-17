import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),
  resolve:{alias:{'posthog-js':fileURLToPath(new URL('./posthog-fixture.ts',import.meta.url))}},
  esbuild:{jsx:'automatic',jsxImportSource:'react'},
  server:{host:'127.0.0.1',port:4179,strictPort:true,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}},
});
