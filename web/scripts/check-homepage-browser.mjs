// [HF-DESI-HOME-1] Desi homepage, sticky shared header and shared Explore chrome. Run only in manually dispatched GitHub CI.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { contentRoutes, footerGroups } from './check-hello-fraands-pages.mjs';

const root = resolve('dist');
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
await mkdir('homepage-review', { recursive: true });
const failures = [];
const metrics = [];
const brandConfig = JSON.parse(await readFile(resolve('../Specs/brand.json'), 'utf8'));
const homepageIdentity = brandConfig.homepageIdentity;

let browser;
try {
  await new Promise(done => server.listen(4179, '127.0.0.1', done));
  browser = await chromium.launch();
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    const name = 'home-' + width;
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(String(error)));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      return u.origin !== 'http://127.0.0.1:4179' || u.pathname.startsWith('/api/') ? route.abort() : route.continue();
    });
    try {
      await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });
      await page.locator('html[data-homepage-ready="true"]').waitFor({ state: 'attached' });
      await expect(page.locator('h1')).toHaveCount(1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': no horizontal overflow');
      const broken = await page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0 && img.src.startsWith(location.origin)).map(img => img.src));
      assert.deepEqual(broken, [], name + ': every local image loads');
      // Owner 2026-10-17: bigger logo, no space above or below it, header sticks with a shadow.
      const top = await page.evaluate(() => {
        const header = document.querySelector('.cv-header'); const logo = header.querySelector('.cv-brand-logo');
        const h = header.getBoundingClientRect(), l = logo.getBoundingClientRect();
        return { headerHeight: h.height, logoHeight: l.height, gapAbove: l.top - h.top, gapBelow: h.bottom - l.bottom, position: getComputedStyle(header).position, shadow: getComputedStyle(header).boxShadow };
      });
      assert.equal(top.position, 'sticky', name + ': header is sticky');
      assert(top.logoHeight >= (width < 700 ? 76 : 104) - 1, name + ': logo is the enlarged size (' + top.logoHeight + ')');
      assert(top.gapAbove <= 1 && top.gapBelow <= 1, name + ': no space above/below the logo (' + top.gapAbove + '/' + top.gapBelow + ')');
      assert.notEqual(top.shadow, 'none', name + ': header has a shadow');
      await page.evaluate(() => window.scrollTo(0, 2500));
      await page.waitForTimeout(100);
      const stuck = await page.evaluate(() => document.querySelector('.cv-header').getBoundingClientRect().top);
      assert(Math.abs(stuck) <= 1, name + ': header stays at the top after scrolling (' + stuck + ')');
      await page.evaluate(() => window.scrollTo(0, 0));
      const nav = page.locator('#main-navigation');
      if (width < 700) {
        await page.locator('[data-callvaal-menu-toggle]').click();
        await expect(nav).toBeVisible();
      }
      for (const label of ['Explore', 'How it works', 'Blog', 'Sign in', 'Join us']) await expect(nav.getByRole('link', { name: label, exact: true }), name + ': header link ' + label).toBeVisible();
      await nav.getByRole('link', { name: 'How it works', exact: true }).click();
      await page.waitForTimeout(200);
      const target = await page.evaluate(() => ({ t: document.getElementById('how-it-works').getBoundingClientRect().top, h: document.querySelector('.cv-header').getBoundingClientRect().bottom }));
      assert(target.t >= target.h - 2, name + ': How it works is not hidden under the sticky header');
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(36);
      assert.deepEqual(browserErrors, [], name + ': no browser errors');
      metrics.push({ name, ...top });
      await page.screenshot({ path: `homepage-review/${name}.png`, fullPage: width <= 1440 });
    } catch (error) {
      await page.screenshot({ path: `homepage-review/${name}-failure.png` }).catch(() => undefined);
      failures.push({ name, error: String(error), browserErrors }); console.error(name, error);
    } finally { await page.close(); }
  }
  for (const [name, width, height, textScale] of [['safety-desktop', 1280, 900, 1], ['safety-compact-text-200', 320, 740, 2]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const browserErrors = [];
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
    page.on('pageerror', error => browserErrors.push(`page: ${String(error)}`));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin !== 'http://127.0.0.1:4179' || url.pathname.startsWith('/api/') ? route.abort() : route.continue();
    });
    try {
      await page.goto('http://127.0.0.1:4179/talk-safely', { waitUntil: 'domcontentloaded' });
      await page.locator('.safety-guide').waitFor({ state: 'visible', timeout: 10000 });
      if (textScale === 2) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.evaluate(() => document.fonts.ready);
      const guide = await page.evaluate(() => ({
        bodyText: document.body.innerText.replace(/\s+/g, ' '),
        contentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        fonts: [...document.querySelectorAll('.safety-guide__status, .safety-guide li, .safety-guide__home')].map(element => parseFloat(getComputedStyle(element).fontSize)),
      }));
      assert.equal(await page.title(), `Talking safely on a call | ${homepageIdentity.name}`, name + ': title uses configured homepage identity');
      assert(guide.bodyText.includes(homepageIdentity.name), name + ': visible chrome uses configured homepage identity');
      assert.match(guide.bodyText, /Rules for talking safely on a call/, name + ': guide heading is visible');
      for (const baseline of ['OTPs', 'passwords', 'financial details', 'home address', 'end it', 'Report the call']) assert(guide.bodyText.includes(baseline), name + ': interim rule is visible: ' + baseline);
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex,nofollow', name + ': placeholder is noindex');
      assert.equal(await page.locator('.notebook-site[data-design="callvaal-scrapbook"]').count(), 1, name + ': guide uses notebook chrome');
      assert(guide.fonts.length > 0 && guide.fonts.every(size => size >= 16 * textScale), name + ': guide keeps readable font floors');
      assert(guide.contentWidth <= guide.viewportWidth + 1, name + ': guide has no horizontal overflow');
      const backLink = page.locator('.safety-guide__home');
      await expect(backLink, name + ': return-home link is visible').toBeVisible();
      await expect(backLink, name + ': return-home route').toHaveAttribute('href', '/');
      await backLink.focus();
      assert.notEqual(await backLink.evaluate(element => getComputedStyle(element).outlineStyle), 'none', name + ': return-home link has visible focus');
      await page.screenshot({ path: `homepage-review/${name}.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `homepage-review/${name}-failure.png`, fullPage: true }).catch(() => undefined);
      failures.push({ name, error: String(error), browserErrors });
      console.error(name, error);
    } finally { await page.close(); }
  }
  // Visit every published content route at a narrow viewport. All traffic remains local.
  for (const path of contentRoutes) {
    const page = await browser.newPage({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin !== 'http://127.0.0.1:4179' || url.pathname.startsWith('/api/') ? route.abort() : route.continue();
    });
    try {
      const response = await page.goto(`http://127.0.0.1:4179${path}`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200, `${path}: published route`);
      await expect(page.locator('h1')).toHaveCount(1);
      if (path !== '/faq') { // [HELLO-FRAANDS-FAQ-1] /faq is a standalone help page without the legal summary/date line
        await expect(page.locator('.hf-hindi em')).toBeVisible();
        const datedPolicies = new Set(['/terms', '/privacy', '/disclaimer', '/community-guidelines', '/about', '/contact', '/press', '/hosts/agreement', '/hosts/kyc', '/report', '/grievance', '/cookies', '/data-deletion', '/intermediary-policy']);
        await expect(page.locator('.hf-date')).toHaveText(datedPolicies.has(path) ? /^Last updated: \d{4}-\d{2}-\d{2}$/ : 'Last updated: {{DATE}}');
      }
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(36);
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path}: 200% narrow text has no page overflow`);
      if (path === '/faq') {
        const item = page.locator('details.faq-item').first();
        await item.locator('summary').click();
        await expect(item.locator('p')).toBeVisible();
      }
      assert.deepEqual(errors, [], `${path}: no browser errors`);
    } catch (error) { failures.push({ name: path, error: String(error), browserErrors: errors }); }
    finally { await page.close(); }
  }
  await writeFile('homepage-review/metrics.json', JSON.stringify({ metrics, failures }, null, 2));
  assert.equal(failures.length, 0, JSON.stringify(failures));
} finally {
  await browser?.close().catch(() => undefined);
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
