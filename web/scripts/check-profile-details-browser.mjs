// [CALLVAAL-CATEGORY-DETAILS-1] Opt-in browser contract for a CI-produced dist.
// Run only when explicitly requested in GitHub CI: node scripts/check-profile-details-browser.mjs
// Not part of the automatic release aggregate; never visits the live service.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('dist');
const identity = JSON.parse(await readFile(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/cdn-cgi\/image\/[^/]+\//, '/');
    if (pathname.endsWith('/')) pathname += 'index.html';
    else if (!extname(pathname)) pathname += '/index.html';
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) return void response.writeHead(403).end();
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { if (!response.writableEnded) response.writeHead(404).end(); }
});
const profiles = [['dr-ananya', 'Ananya'], ['sana', 'Sana'], ['neha', 'Neha'], ['kavya', 'Kavya'], ['priya', 'Priya']];
const failures = [];
let browser;
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir('profile-detail-review', { recursive: true });
  browser = await chromium.launch();
  for (const [id, name] of profiles) {
    for (const width of [320, 390, 699, 700, 768, 1099, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const mutations = [];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin !== origin || url.pathname.startsWith('/api/') ? route.abort() : route.continue();
      });
      // Exercise the selectable-link fallback without accessing a real clipboard.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard unavailable in contract'); } } });
      });
      try {
        await page.goto(`${origin}/people/${id}?private=do-not-share#about`, { waitUntil: 'domcontentloaded' });
        await page.locator('html[data-profile-ready="true"]').waitFor({ state: 'attached' });
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (const image of document.querySelectorAll('#profile-main img')) { image.loading = 'eager'; await image.decode(); }
        });
        await expect(page.locator('h1')).toHaveText(name);
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        const canonicalUrl = new URL(canonical);
        assert.equal(canonicalUrl.origin, `https://${identity.domain}`, `${id}/${width}: canonical domain`);
        assert.equal(canonicalUrl.pathname.replace(/\/$/, ''), `/people/${id}`, `${id}/${width}: canonical path`);
        await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical);
        await expect(page.locator('header[data-callvaal-chrome] .cv-wordmark')).toContainText(identity.name);
        await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(37);

        const layout = await page.evaluate(() => {
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const controls = [...document.querySelectorAll('#profile-main button, .cv-profile-tabs a, .cv-mobile-booking button')].filter(visible);
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            smallControls: controls.filter(el => { const r = el.getBoundingClientRect(); return r.width < 43 || r.height < 43; }).map(el => el.outerHTML),
            railPosition: getComputedStyle(document.querySelector('.cv-booking-rail')).position,
            mobileVisible: Boolean(visible(document.querySelector('.cv-mobile-booking'))),
          };
        });
        assert(layout.overflow <= 2, `${id}/${width}: no horizontal overflow`);
        assert.deepEqual(layout.smallControls, [], `${id}/${width}: touch controls at least 44px`);
        assert.equal(layout.mobileVisible, width <= 699, `${id}/${width}: mobile call bar breakpoint`);
        assert.equal(layout.railPosition, width <= 699 ? 'static' : 'sticky', `${id}/${width}: booking layout`);
        const save = page.locator('[data-profile-save]');
        await save.click();
        await expect(save).toHaveAttribute('aria-pressed', 'true');
        await save.click();
        await expect(save).toHaveAttribute('aria-pressed', 'false');
        for (const action of ['call', 'book']) {
          const trigger = page.locator(`[data-profile-preview="${action}"]:visible`).first();
          await trigger.click();
          const dialog = page.locator('#cv-profile-preview');
          await expect(dialog).toBeVisible();
          await expect(dialog.locator('h2')).toHaveText('Before you call');
          await expect(dialog).toContainText('Calls, bookings and payments are unavailable.');
          await page.keyboard.press('Escape');
          await expect(dialog).toBeVisible();
          await dialog.locator('[data-disclaimer-ack]').click();
          await expect(dialog).not.toBeVisible();
          await expect(trigger).toBeFocused();
        }
        await expect(page.locator('[data-gallery-index]')).toHaveCount(0);
        await expect(page.locator('#gallery')).toHaveCount(0);
        const share = page.locator('[data-profile-share]');
        await share.click();
        await expect(page.locator('#cv-share-dialog')).toBeVisible();
        await expect(page.locator('#cv-share-url')).toHaveValue(`${origin}/people/${id}`);
        await expect(page.locator('[data-share-status]')).toHaveText('Select and copy the link above.');
        await page.keyboard.press('Escape');
        await expect(share).toBeFocused();
        // Mock native sharing too; the contract must never send a real message.
        await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__profileShared = data; } }));
        await share.click();
        await expect.poll(() => page.evaluate(() => window.__profileShared?.url)).toBe(`${origin}/people/${id}`);
        await expect(page.locator('#cv-share-dialog')).not.toBeVisible();
        if (width <= 699) {
          await page.locator('.cv-profile-tabs a[href="#moods"]').click();
          await expect(page.locator('.cv-profile-tabs a[href="#moods"]')).toHaveAttribute('aria-current', 'location');
        }
        await page.screenshot({ path: `profile-detail-review/${id}-${width}.png`, fullPage: true });
        assert.deepEqual(mutations, [], `${id}/${width}: no business API writes`);
        assert.deepEqual(errors, [], `${id}/${width}: no uncaught browser errors`);
        if (width === 390) {
          // Base sets this attribute for the existing native-app UA contract.
          await page.evaluate(() => document.documentElement.setAttribute('data-site-embed', ''));
          await expect(page.locator('.cv-mobile-booking')).not.toBeVisible();
          await expect(page.locator('.cv-booking-card > [data-profile-preview="call"]')).toBeVisible();
          await expect(page.locator('.cv-booking-card > .cv-rate')).toBeVisible();
        }
      } catch (error) {
        failures.push(`${id}/${width}: ${error.stack || error}`);
        await page.screenshot({ path: `profile-detail-review/${id}-${width}-failure.png`, fullPage: true }).catch(() => {});
      } finally { await page.close(); }
    }
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
assert.deepEqual(failures, [], 'Profile browser contract failures');
console.log('Five profile pages passed responsive, disclaimer, moods, save, share, focus and embed checks.');
