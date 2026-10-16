// [HF-HOME-DESI-1] Owner-approved dashboard-style landing (was HF-HOME-HOST-FAN-1). Run only in manually dispatched GitHub CI.
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
const homepageIdentity = JSON.parse(await readFile(resolve('../Specs/brand.json'), 'utf8')).homepageIdentity;

let browser;
try {
  await new Promise(done => server.listen(4179, '127.0.0.1', done));
  browser = await chromium.launch();
  for (const width of [320, 390, 767, 768, 820, 1023, 1024, 1440, 1920, 2560, 3440]) {
    const name = `home-${width}`;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const mutations = [];
    const browserErrors = [];
    await page.addInitScript(() => {
      window.__previewNotificationRequests = 0;
      if ('Notification' in window) Notification.requestPermission = async () => {
        window.__previewNotificationRequests++;
        return 'denied';
      };
    });
    page.on('pageerror', error => browserErrors.push(String(error)));
    page.on('request', request => {
      if (/\/api\//.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:4179' || url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    try {
      await page.goto('http://127.0.0.1:4179/', { waitUntil: 'domcontentloaded' });
      await page.locator('html[data-homepage-ready="true"]').waitFor({ state: 'attached' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        const images = [...document.images].filter(image => image.getClientRects().length);
        for (const image of images) image.loading = 'eager';
        await Promise.all(images.map(image => image.decode()));
      });
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://${homepageIdentity.domain}/`);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', `https://${homepageIdentity.domain}/`);
      // [HF-HOME-DESI-1] Landing = the dashboard's shell and cards with an animated hero.
      await expect(page.locator('h1')).toHaveText('Your favourite creators. One conversation away.');
      await expect(page.locator('.hfh-beta')).toHaveCount(0);
      await expect(page.locator('.hfs[role="img"]')).toBeVisible();
      await expect(page.locator('.h3-ticker')).toBeVisible();
      await expect(page.locator('[data-creator-preview]')).toHaveCount(0);
      await expect(page.locator('.cv-footer-brand p')).toHaveCount(0);
      for (const [action, href] of [
        ['explore-hosts', '/marketplace'], ['become-host', '/hosts/join'], ['apply-host', '/hosts/join'],
        ['women-hosts', '/marketplace?lane=women#people'], ['lgbtq-hosts', '/marketplace?lane=lgbtq#people'],
      ]) await expect(page.locator('[data-home-cta="' + action + '"]')).toHaveAttribute('href', href);
      const shell = await page.evaluate(() => {
        const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const small = [];
        for (const el of document.querySelectorAll('main *')) {
          if (!visible(el) || el.closest('.sr-only, svg, .hfs')) continue;
          const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
          if (own && parseFloat(getComputedStyle(el).fontSize) < 14) small.push({ el: el.className || el.tagName, text: el.textContent.trim().slice(0, 40), size: getComputedStyle(el).fontSize });
        }
        const fam = sel => [...document.querySelectorAll(sel)].filter(visible).map(el => getComputedStyle(el).fontFamily);
        return {
          side: shown(document.querySelector('.h3-side')), sideLabels: shown(document.querySelector('.h3-side .lbl')), bottom: shown(document.querySelector('.h3-bottom')),
          small, headings: fam('main h1, main h2, main h3').every(f => f.includes('Nunito')), body: fam('main p').every(f => f.includes('Comfortaa')),
          smallControls: [...document.querySelectorAll('main .h3-btn:not(.sm), .h3-bottom a')].filter(visible).filter(el => el.getBoundingClientRect().height < 43.9).map(el => el.textContent.trim()),
          ids: [...document.querySelectorAll('[id]')].map(el => el.id),
          overflow: document.documentElement.scrollWidth,
        };
      });
      const shellWidth = await page.locator('.hf3').evaluate(el => el.getBoundingClientRect().width);
      assert.equal(shell.side, shellWidth >= 736, name + ': section sidebar from 46rem');
      assert.equal(shell.sideLabels, shellWidth >= 1152, name + ': full sidebar labels from 72rem, icon rail below');
      assert.equal(shell.bottom, shellWidth < 736, name + ': bottom tabs on phones');
      assert.deepEqual(shell.small, [], name + ': no text under 14px');
      assert(shell.headings && shell.body, name + ': Nunito headings and Comfortaa body text');
      assert.deepEqual(shell.smallControls, [], name + ': 44px minimum control height');
      assert.equal(new Set(shell.ids).size, shell.ids.length, name + ': IDs unique');
      assert(shell.overflow <= width + 1, name + ': no horizontal overflow');
      metrics.push({ name, shell });
      await page.locator('#people').scrollIntoViewIfNeeded();
      await expect(page.locator('[data-live-creators="empty"]'), name + ': honest empty state when the live list is unreachable').toBeVisible({ timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, 700));
      const stickyHeader = await page.locator('header').evaluate(el => ({ position: getComputedStyle(el).position, top: el.getBoundingClientRect().top }));
      assert.equal(stickyHeader.position, 'sticky', name + ': sticky header');
      assert(Math.abs(stickyHeader.top) <= 1, name + ': header remains at the top on scroll');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
      const menu = page.locator('[data-callvaal-menu-toggle]');
      if (await menu.isVisible()) {
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
        await expect(menu).toBeFocused();
      }
      await expect(page.locator('[data-callvaal-footer-group]')).toHaveCount(5);
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(36);
      for (const group of await page.locator('[data-callvaal-footer-group]').all()) {
        if (!(await group.evaluate(element => element.open))) await group.locator('summary').click();
      }
      await expect(page.locator('[data-callvaal-footer-group] summary')).toHaveText(footerGroups);
      const privacy = page.locator('[data-callvaal-footer-group] a[href="/privacy"]');
      await expect(privacy).toBeVisible();
      await expect(privacy).toHaveAttribute('href', '/privacy');
      await expect(page.locator('[data-footer-preview]')).toHaveCount(0);
      if ([320, 390, 768, 1024, 1440].includes(width)) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        assert(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, name + ': 200% text no horizontal overflow');
        await page.screenshot({ path: `homepage-review/${name}-text-200.png`, fullPage: true });
      }
      const missingAnchors = await page.locator('a[href^="#"]:visible').evaluateAll(links => links.map(a => a.hash.slice(1)).filter(id => id && !document.getElementById(id)));
      assert.deepEqual(missingAnchors, [], name + ': visible anchors resolve');
      assert.deepEqual(mutations, [], name + ': no backend mutations');
      assert.equal(await page.evaluate(() => window.__previewNotificationRequests), 0, name + ': preview never requests notification permission');
      assert.deepEqual(browserErrors, [], name + ': no uncaught browser errors');
    } catch (error) {
      await page.screenshot({ path: `homepage-review/${name}-failure.png`, fullPage: true }).catch(() => undefined);
      failures.push({ name, error: String(error), browserErrors });
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
