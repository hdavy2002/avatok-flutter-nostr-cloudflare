import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import yaml from '@rollup/plugin-yaml';
import path from 'path';
import { aliases, vueOptions } from './vite.shared';
export default defineConfig({
  root: path.resolve(__dirname),
  base: '/',
  plugins: [vue(vueOptions), yaml()],
  css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
  resolve: { alias: aliases },
  build: { outDir: 'hfdesk-dist', emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, 'hfdesk/index.html') }, chunkSizeWarningLimit: 5000 },
});
