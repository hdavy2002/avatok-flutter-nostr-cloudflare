// Owner-approved mood-led conversation homepage. Run only in manually dispatched GitHub CI.
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
      [16, '.social-proof-section h2, .proof-card strong, .proof-card span, .activity-preview-label strong, .activity-sequence>span, #privacy-note h2, .privacy-intro, .privacy-diagram li>p, .privacy-diagram li>p span, .privacy-diagram strong, .privacy-bottom, .privacy-bottom button, .people-toolbar button, .people-toolbar select, .person-copy h3, .person-copy p:not(.person-talks):not(.person-topic):not(.verification-badge), .person-price, .sample-call, #earn h2, .earn-copy>p, .earn-steps li, .earn-steps span, .join-button, .mood-group h3, [data-callvaal-footer-group] summary, [data-callvaal-footer-group] a, [data-callvaal-footer-group] button'],
      [15, '.safety-links a, .social-proof-heading>p, .sample-label, .profile-disclosure, .selected-category-label, .person-rating small, .person-talks, .person-topic, .earn-copy>small, .mood-chip, .crisis-note, footer[data-callvaal-chrome] .cv-footer-brand p, footer[data-callvaal-chrome] .cv-footer-copyright'],
      [11, '.verification-badge, .person-moods li'],
      [14, '.preview-kicker, .proof-card small, .activity-preview-label span, .service-disclaimer'],
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
    const panels = '.social-proof-section, .proof-card, .activity-preview, #women-only, #privacy-note, .people-toolbar, .person-copy, .earn-copy, #moods, #safety, .mood-group, [data-callvaal-footer-group][open]';
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
    checkSiblings('.privacy-diagram, .privacy-diagram li, .people-toolbar, .people-filters, .person-heading, .person-actions, .earn-copy, .earn-steps, footer[data-callvaal-chrome] nav[aria-label="Footer"], .mood-grid, .mood-chips, .safety-grid');
    const badges = [...document.querySelectorAll('.verification-badge')].map(el => {
      const rect = el.getBoundingClientRect();
      const card = el.closest('.profile-card').getBoundingClientRect();
      const style = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const textFits = [...range.getClientRects()].every(text => text.left >= rect.left - 2 && text.right <= rect.right + 2 && text.top >= rect.top - 2 && text.bottom <= rect.bottom + 2);
      return { text: el.textContent.trim(), visible: visible(el), wraps: style.whiteSpace !== 'nowrap', fits: textFits && rect.left >= card.left - 2 && rect.right <= card.right + 2 && rect.top >= card.top - 2 && rect.bottom <= card.bottom + 2 };
    });
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
      moodChips: document.querySelectorAll('.mood-chip').length,
      navigation: document.querySelectorAll('[data-callvaal-navigation]').length,
      menuToggles: document.querySelectorAll('[data-callvaal-menu-toggle]').length,
    };
    return { fontFailures, fontCounts, clipping, overlaps, badges, viewportOverflow, contractCoverage };
  });
}
try {
  await new Promise(done => server.listen(4179, '127.0.0.1', done));
  browser = await chromium.launch();
  for (const width of [320, 360, 390, 452, 599, 600, 699, 700, 899, 900, 1024, 1440, 1920, 2560]) {
    const name = `home-${width}`;
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const mutations = [];
    const browserErrors = [];
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
      await expect(page.locator('h1')).toHaveText(/Baat karo\.\s*Dil halka karo\./);
      await expect(page.locator('[data-person]')).toHaveCount(8);
      await expect(page.locator('.mood-group')).toHaveCount(4);
      await expect(page.locator('.mood-chip')).toHaveCount(17);
      await expect(page.locator('#women-only')).toBeVisible();
      await expect(page.locator('#women-only')).toContainText('A public preview of a private lane.');
      await expect(page.locator('#women-only .hf-women-proof li')).toHaveCount(2);
      await expect(page.locator('#women-only [data-women-preview]')).toBeEnabled();
      await expect(page.locator('.cv-navigation a[href="/#women-only"]')).toHaveCount(1);
      await expect(page.locator('#safety .hf-safety-rule')).toHaveCount(4);
      await expect(page.locator('#earn .earn-steps li')).toHaveCount(4);
      await expect(page.locator('#safety a[href="/recording-policy"]')).toBeVisible();
      await expect(page.locator('.service-disclaimer')).toContainText('18+ only.');
      const readability = await inspectReadability(page);
      metrics.push({ name, readability });
      assert.deepEqual(readability.fontFailures, [], name + ': readable fonts');
      assert.deepEqual(readability.clipping, [], name + ': unclipped content');
      assert.deepEqual(readability.overlaps, [], name + ': controls and text do not overlap');
      assert(readability.viewportOverflow.content <= width + 1, name + ': no horizontal overflow');
      const imageGeometry = await page.locator('main img').evaluateAll(images => images.map(image => ({
        alt: image.alt, loaded: image.complete && image.naturalWidth > 0,
        width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height,
      })));
      assert(imageGeometry.length === 12 && imageGeometry.every(image => image.loaded && image.alt && image.width > 0 && image.height > 0), name + ': hero, women photo collage, eight portraits and earn art load');
      await page.screenshot({ path: `homepage-review/${name}.png`, fullPage: true });
      const roster = await page.locator('[data-person]').evaluateAll(cards => cards.map(card => ({
        moods: card.dataset.moods.split(' '), languages: card.dataset.languages.split(', '),
        price: Number(card.dataset.price), online: card.dataset.online === 'true',
      })));
      const moodOptions = await page.locator('#mood-filter option').evaluateAll(options => options.filter(option => option.value).map(option => ({ slug: option.value, label: option.textContent })));
      assert.equal(moodOptions.length, 17);
      for (const { slug, label } of moodOptions) {
        await page.locator('#mood-filter').selectOption(slug);
        await expect(page.locator('[data-person]:visible')).toHaveCount(roster.filter(person => person.moods.includes(slug)).length);
        await expect(page.locator('[data-selected-mood-label]')).toHaveText(`Mood: ${label}`);
      }
      const reset = page.locator('[data-reset-filters]').first();
      await reset.click();
      for (const [selector, value, predicate] of [
        ['#language-filter', 'Kannada', person => person.languages.includes('Kannada')],
        ['#price-filter', '20', person => person.price <= 20],
      ]) {
        await page.locator(selector).selectOption(value);
        await expect(page.locator('[data-person]:visible')).toHaveCount(roster.filter(predicate).length);
        await reset.click();
      }
      await page.locator('#online-filter').check();
      await expect(page.locator('[data-person]:visible')).toHaveCount(roster.filter(person => person.online).length);
      await page.locator('#mood-filter').selectOption('kundli');
      await page.locator('#language-filter').selectOption('Kannada');
      await page.locator('#price-filter').selectOption('30');
      await expect(page.locator('[data-person]:visible')).toHaveCount(1);
      await page.locator('#price-filter').selectOption('20');
      await expect(page.locator('.no-results')).toBeVisible();
      await page.locator('.no-results [data-reset-filters]').click();
      await expect(page.locator('[data-person]:visible')).toHaveCount(8);
      for (const selector of ['#mood-filter', '#language-filter', '#price-filter']) await expect(page.locator(selector)).toHaveValue('');
      await expect(page.locator('#online-filter')).not.toBeChecked();
      await expect(page.locator('[data-selected-mood-label]')).not.toBeVisible();
      // Exercise a real mood link and its query-driven initialization.
      await page.locator('.mood-chip[href="/?mood=kundli#people"]').click();
      await page.locator('html[data-homepage-ready="true"]').waitFor({ state: 'attached' });
      await expect(page.locator('#mood-filter')).toHaveValue('kundli');
      await expect(page.locator('[data-person]:visible')).toHaveCount(1);
      await reset.click();
      const womenEntry = page.locator('#women-only [data-women-preview]');
      await womenEntry.click();
      const womenDialog = page.locator('#hf-women-dialog');
      await expect(womenDialog).toBeVisible();
      await expect(womenDialog.getByRole('button', { name: 'Start verification' })).toBeDisabled();
      await womenDialog.getByRole('button', { name: 'Later' }).click();
      await expect(womenDialog).not.toBeVisible();
      await expect(womenEntry).toBeFocused();
      await womenEntry.press('Enter');
      await expect(womenDialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(womenDialog).not.toBeVisible();
      await expect(womenEntry).toBeFocused();
      const dialog = page.locator('#preview-dialog');
      for (const selector of ['.profile-card [data-preview-action="call"]', '#earn [data-preview-action="join"]', '#privacy-note [data-preview-action="privacy"]']) {
        const trigger = page.locator(selector).first();
        await trigger.click();
        await expect(dialog).toBeVisible();
        assert(await dialog.evaluate(element => element.contains(document.activeElement)), name + ': modal receives focus');
        await dialog.locator('[data-close-preview]').press('Enter');
        await waitForPreviewClose(dialog, trigger, name);
        await trigger.press('Enter');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await waitForPreviewClose(dialog, trigger, name);
      }
      const favourite = page.locator('[data-favourite]').first();
      await favourite.click();
      await expect(favourite).toHaveAttribute('aria-pressed', 'true');
      await favourite.click();
      await expect(favourite).toHaveAttribute('aria-pressed', 'false');
      const menu = page.locator('[data-callvaal-menu-toggle]');
      if (await menu.isVisible()) {
        await menu.click();
        await expect(menu).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
        await expect(menu).toBeFocused();
      }
      await expect(page.locator('[data-callvaal-footer-group]')).toHaveCount(5);
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(34);
      for (const group of await page.locator('[data-callvaal-footer-group]').all()) {
        if (!(await group.evaluate(element => element.open))) await group.locator('summary').click();
      }
      await expect(page.locator('[data-callvaal-footer-group] summary')).toHaveText(footerGroups);
      const privacy = page.locator('[data-callvaal-footer-group] a[href="/privacy"]');
      await expect(privacy).toBeVisible();
      await expect(privacy).toHaveAttribute('href', '/privacy');
      await expect(page.locator('[data-footer-preview]')).toHaveCount(0);
      if ([320, 452, 1024].includes(width)) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        const enlarged = await inspectReadability(page);
        metrics.at(-1).enlarged = enlarged;
        assert.deepEqual(enlarged.clipping, [], name + ': 200% text unclipped');
        assert.deepEqual(enlarged.overlaps, [], name + ': 200% text does not overlap');
        assert(enlarged.viewportOverflow.content <= width + 1, name + ': 200% text no horizontal overflow');
        await page.locator('#mood-filter').selectOption('kundli');
        await expect(page.locator('[data-person]:visible')).toHaveCount(1);
        await page.screenshot({ path: `homepage-review/${name}-text-200.png`, fullPage: true });
      }
      const missingAnchors = await page.locator('a[href^="#"]:visible').evaluateAll(links => links.map(a => a.hash.slice(1)).filter(id => id && !document.getElementById(id)));
      assert.deepEqual(missingAnchors, [], name + ': visible anchors resolve');
      assert.deepEqual(mutations, [], name + ': no backend mutations');
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
      await expect(page.locator('.hf-hindi em')).toBeVisible();
      await expect(page.locator('.hf-date')).toHaveText('Last updated: {{DATE}}');
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(34);
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path}: 200% narrow text has no page overflow`);
      if (path === '/faq') {
        const item = page.locator('.hf-prose details').first();
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
