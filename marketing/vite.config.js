import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA for Cloudflare Pages. `npm run build` → dist/ → `npm run deploy`.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
