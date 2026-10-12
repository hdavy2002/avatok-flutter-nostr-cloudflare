// [HF-HOME-HOST-FAN-1] Owner-approved host/fan homepage. Run only in manually dispatched GitHub CI.
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
async function waitForPreviewClose(dialog, trigger, message) {
  // Native focus restoration can precede the application's queued close handler.
  await expect(dialog, message + ': dialog closed').not.toBeVisible();
  await expect(trigger, message + ': trigger focus restored').toBeFocused();
}
// Inspect computed sizes at every viewport so later media queries cannot silently undo floors.
async function inspectReadability(page) {
  return page.evaluate(() => {
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const groups = [
      [16, '.hfh-hero-copy>p, .hfh-button, .hfh-section-heading p, .hfh-card-heading h3, .hfh-rate, .hfh-privacy p, .hfh-lane-copy>p:not(.hfh-kyc), .hfh-steps p, .hfh-host-copy p, [data-callvaal-footer-group] summary, [data-callvaal-footer-group] a, [data-callvaal-footer-group] button'],
      [15, 'footer[data-callvaal-chrome] .cv-footer-brand p, footer[data-callvaal-chrome] .cv-footer-copyright'],
      [14, '.hfh-sample-label, .hfh-disclosure, .hfh-eligibility, .hfh-availability, .hfh-category, .hfh-rating, .hfh-voice, .hfh-kyc, .hfh-picker, .hfh-share, .hfh-proof li'],
    ];
    const fontFailures = [];
    const fontCounts = [];
    for (const [floor, selector] of groups) {
      const elements = [...document.querySelectorAll(selector)].filter(visible);
      fontCounts.push({ floor, count: elements.length });
      for (const el of elements) {
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < floor) fontFailures.push({ selector: el.className || el.tagName, text: el.textContent.trim(), floor, size });
      }
    }
    const clipping = [];
    const panels = '.hfh-hero-copy, .hfh-picker, .hfh-share, .hfh-card-copy, #women-only, #privacy-note, .hfh-host-copy, #safety, .hfh-lane-copy, .hfh-steps, [data-callvaal-footer-group][open]';
    for (const panel of document.querySelectorAll(panels)) {
      if (!visible(panel)) continue;
      if (panel.scrollWidth > panel.clientWidth + 2) clipping.push({ panel: panel.className, reason: 'horizontal overflow' });
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent.trim() || !visible(text.parentElement) || text.parentElement.closest('.sr-only, .hf-safety-sr-only, option, svg')) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          for (let el = text.parentElement; el && el !== document.body; el = el.parentElement) {
            const style = getComputedStyle(el);
            const bounds = el.getBoundingClientRect();
            if ((/hidden|clip|scroll|auto/.test(style.overflowX) && (rect.left < bounds.left - 2 || rect.right > bounds.right + 2)) ||
                (/hidden|clip|scroll|auto/.test(style.overflowY) && (rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2))) {
              clipping.push({ text: text.textContent.trim(), ancestor: el.className, reason: 'clipped text' });
              break;
            }
          }
        }
      }
    }
    const overlaps = [];
    const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    const checkSiblings = selector => {
      for (const parent of document.querySelectorAll(selector)) {
        const children = [...parent.children].filter(el => visible(el) && !el.classList.contains('sr-only'));
        for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
          if (intersects(children[i].getBoundingClientRect(), children[j].getBoundingClientRect())) overlaps.push({ parent: parent.className, first: children[i].className || children[i].tagName, second: children[j].className || children[j].tagName });
        }
      }
    };
    checkSiblings('.hfh-actions, .hfh-proof, .hfh-card-heading, .hfh-category, .hfh-creator-grid, .hfh-steps, .hfh-host-copy, footer[data-callvaal-chrome] nav[aria-label="Footer"]');
    const viewportOverflow = {
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
      elements: [...document.body.querySelectorAll('*')]
        .filter(el => visible(el) && !el.closest('.sr-only, svg'))
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { element: el.id ? `#${el.id}` : el.className || el.tagName,
            left: Math.round(rect.left * 100) / 100, right: Math.round(rect.right * 100) / 100,
            width: Math.round(rect.width * 100) / 100, content: el.scrollWidth,
            text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 100) };
        })
        .filter(el => el.left < -1 || el.right > innerWidth + 1)
        .slice(0, 40),
    };
    const contractCoverage = {
      footerGroups: document.querySelectorAll('[data-callvaal-footer-group]').length,
      creatorPreviews: document.querySelectorAll('[data-creator-preview]').length,
      navigation: document.querySelectorAll('[data-callvaal-navigation]').length,
      menuToggles: document.querySelectorAll('[data-callvaal-menu-toggle]').length,
    };
    return { fontFailures, fontCounts, clipping, overlaps, viewportOverflow, contractCoverage };
  });
}
try {
  await new Promise(done => server.listen(4179, '127.0.0.1', done));
  browser = await chromium.launch();
  for (const width of [320, 390, 767, 768, 820, 1023, 1024, 1440, 1920]) {
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
      await expect(page.locator('h1')).toHaveText('Talk to your favourite social media influencers over a private phone call.');
      await expect(page.locator('.hfh-beta')).toContainText('INVITE ONLY · BETA PHASE');
      await expect(page.locator('.hfh-creator-card')).toHaveCount(4);
      await expect(page.locator('.hfh-card-heading h3')).toHaveText(['Neha', 'Arjun', 'Meera', 'Rohit']);
      await expect(page.locator('.hfh-rate')).toHaveText(['₹3.99/min', '₹4.50/min', '₹3.50/min', '₹3.25/min']);
      await expect(page.locator('.hfh-availability')).toHaveText(['Online now', 'Online now', 'In 30 mins', 'Online now']);
      await expect(page.locator('.hfh-category>span:first-of-type')).toHaveText(['Beauty & Style', 'Gaming', 'Fitness', 'Film & Culture']);
      await expect(page.locator('#people-title')).toHaveText('Book time with creators you follow');
      await expect(page.locator('#privacy-title')).toHaveText('Your number stays yours.');
      await expect(page.locator('.hfh-connection')).toContainText(homepageIdentity.name);
      await expect(page.locator('.hfh-connection figcaption')).toHaveText('Two private calls. One conversation.');
      await expect(page.locator('.hfh-kyc')).toHaveText(['Video KYC required', 'Video KYC required']);
      await expect(page.locator('.hfh-eligibility')).toContainText('not their gender or sexual orientation');
      await expect(page.locator('.hfh-steps h3')).toHaveText(['Choose a host', 'Book and pay', 'Talk privately']);
      await expect(page.locator('.hfh-share-url')).toHaveText(homepageIdentity.domain + '/yourname');
      await expect(page.locator('#sample-disclosure')).toBeVisible();
      await expect(page.locator('.hfh-disclosure')).toContainText('No audio plays and no call or payment is made.');
      await expect(page.locator('.hfh-collage button, .hfh-collage a')).toHaveCount(0);
      for (const [action, href] of [
        ['explore-hosts', '/marketplace'], ['view-all-hosts', '/marketplace'],
        ['become-host', '/hosts/join'], ['apply-host', '/hosts/join'],
        ['women-hosts', '/marketplace?lane=women#people'], ['lgbtq-hosts', '/marketplace?lane=lgbtq#people'],
        ['privacy', '/privacy'], ['safety', '/safety'],
      ]) await expect(page.locator('[data-home-cta="' + action + '"]')).toHaveAttribute('href', href);
      const geometry = await page.evaluate(() => {
        const columns = selector => getComputedStyle(document.querySelector(selector)).gridTemplateColumns.split(' ').length;
        return {
          hero: columns('.hfh-hero'), creators: columns('.hfh-creator-grid'), privacy: columns('.hfh-privacy'),
          lanes: columns('.hfh-lanes'), steps: columns('.hfh-steps'),
          ribbonBottom: document.querySelector('.hfh-beta').getBoundingClientRect().bottom,
          headerTop: document.querySelector('header').getBoundingClientRect().top,
          headerBottom: document.querySelector('header').getBoundingClientRect().bottom,
          smallControls: [...document.querySelectorAll('.hfh-home button, .hfh-home a')].filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 43.9).map(el => el.textContent),
          ids: [...document.querySelectorAll('[id]')].map(el => el.id),
        };
      });
      assert.equal(geometry.hero, width >= 768 ? 2 : 1, name + ': hero columns');
      assert.equal(geometry.creators, width >= 1024 ? 4 : width >= 768 ? 2 : 1, name + ': creator columns');
      assert.equal(geometry.privacy, width >= 1024 ? 2 : 1, name + ': privacy columns');
      assert.equal(geometry.lanes, width >= 1024 ? 2 : 1, name + ': lane columns');
      assert.equal(geometry.steps, width >= 768 ? 3 : 1, name + ': steps columns');
      assert(geometry.ribbonBottom <= geometry.headerTop + 1, name + ': reference beta ribbon above header');
      assert.deepEqual(geometry.smallControls, [], name + ': 44px minimum control height');
      assert.equal(new Set(geometry.ids).size, geometry.ids.length, name + ': IDs unique');
      const readability = await inspectReadability(page);
      metrics.push({ name, readability, geometry });
      assert.deepEqual(readability.fontFailures, [], name + ': readable fonts');
      assert.deepEqual(readability.clipping, [], name + ': unclipped content');
      assert.deepEqual(readability.overlaps, [], name + ': controls and text do not overlap');
      assert(readability.viewportOverflow.content <= width + 1, name + ': no horizontal overflow');
      const imageGeometry = await page.locator('main img').evaluateAll(images => images.filter(image => image.getClientRects().length).map(image => ({
        alt: image.alt, loaded: image.complete && image.naturalWidth > 0,
        width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
      })));
      assert(imageGeometry.length === 11 && imageGeometry.every(image => image.loaded && image.alt && image.width > 0 && image.height > 0), name + ': all separate photographic assets load');
      await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
      const dialog = page.locator('#preview-dialog');
      for (const trigger of await page.locator('.hfh-creator-card [data-preview-action]').all()) {
        await trigger.click();
        await expect(dialog).toBeVisible();
        const voice = await trigger.getAttribute('data-preview-action') === 'voice';
        await expect(dialog).toContainText(voice ? 'No recording is playing.' : 'No call has been booked and no payment is made.');
        assert(await dialog.evaluate(element => element.contains(document.activeElement)), name + ': modal receives focus');
        await dialog.locator('[data-close-preview]').press('Enter');
        await waitForPreviewClose(dialog, trigger, name);
        await trigger.press('Enter');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await waitForPreviewClose(dialog, trigger, name);
      }
      const menu = page.locator('[data-callvaal-menu-toggle]');
      if (await menu.isVisible()) {
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
        await expect(menu).toBeFocused();
      }
      await expect(page.locator('[data-callvaal-footer-group]')).toHaveCount(5);
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(37);
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
        const enlarged = await inspectReadability(page);
        metrics.at(-1).enlarged = enlarged;
        assert.deepEqual(enlarged.clipping, [], name + ': 200% text unclipped');
        assert.deepEqual(enlarged.overlaps, [], name + ': 200% text does not overlap');
        assert(enlarged.viewportOverflow.content <= width + 1, name + ': 200% text no horizontal overflow');
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
      assert.equal(await page.title(), `Talking safely with strangers | ${homepageIdentity.name}`, name + ': title uses configured homepage identity');
      assert(guide.bodyText.includes(homepageIdentity.name), name + ': visible chrome uses configured homepage identity');
      assert.match(guide.bodyText, /Rules for talking safely with strangers/, name + ': guide heading is visible');
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
        const datedPolicies = new Set(['/terms', '/privacy', '/disclaimer', '/community-guidelines']);
        await expect(page.locator('.hf-date')).toHaveText(datedPolicies.has(path) ? /^Last updated: \d{4}-\d{2}-\d{2}$/ : 'Last updated: {{DATE}}');
      }
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(37);
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
