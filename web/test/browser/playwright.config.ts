import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'hdfc.spec.ts',fullyParallel:false,workers:1,
  use:{baseURL:'http://127.0.0.1:4179',browserName:'chromium',trace:'retain-on-failure'},
  webServer:{command:'npx --no-install vite --config test/browser/vite.config.ts',url:'http://127.0.0.1:4179',reuseExistingServer:false},
});
