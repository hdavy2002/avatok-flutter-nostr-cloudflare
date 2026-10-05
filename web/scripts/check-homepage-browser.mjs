// Owner-approved reference replica. Run only in manually dispatched GitHub CI.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

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
await new Promise(done => server.listen(4179, '127.0.0.1', done));
const browser = await chromium.launch();
await mkdir('homepage-review', { recursive: true });
const failures = [];
const metrics = [];
try {
  for (const [name, width, height] of [['reference', 1024, 1536], ['ultrawide', 2560, 1440], ['wide', 1920, 1200], ['desktop', 1440, 1000], ['small-desktop', 1100, 900], ['desktop-breakpoint', 900, 1000], ['tablet', 820, 1000], ['small-tablet', 768, 1000], ['tablet-breakpoint', 600, 1000], ['large-mobile', 480, 900], ['mobile', 390, 844], ['small-mobile', 360, 780], ['compact-mobile', 320, 740]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const mutations = [];
    page.on('request', request => {
      if (/\/api\//.test(request.url()) && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    try {
      await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        for (const image of document.images) image.loading = 'eager';
        await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
        const artwork = new Image();
        artwork.src = '/assets/callvaal/scrapbook/category-stickers.png';
        await artwork.decode();
        if (artwork.naturalWidth < 1024 || artwork.naturalWidth !== artwork.naturalHeight) throw new Error('Category sprite did not load as a high-resolution square');
      });
      await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
      await page.locator('.notebook-hero').screenshot({ path: 'homepage-review/' + name + '-hero.png' });
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        broken: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
        heading: document.querySelector('h1')?.textContent,
        headingFont: getComputedStyle(document.querySelector('h1')).fontFamily,
        bodyFont: getComputedStyle(document.body).fontFamily,
        siteWidth: document.querySelector('.notebook-site').getBoundingClientRect().width,
        profileTextSize: parseFloat(getComputedStyle(document.querySelector('.person-copy p')).fontSize),
        callButtonHeight: document.querySelector('.sample-call').getBoundingClientRect().height,
        clippedText: [...document.querySelectorAll('.person-copy,.category-copy,.hero-copy,.earn-copy,.notebook-nav')]
          .filter(el => el.scrollWidth > el.clientWidth + 2)
          .map(el => ({ className: el.className, width: el.clientWidth, content: el.scrollWidth })),
        categories: [...document.querySelectorAll('.category-card')].map(el => ({ top: el.offsetTop, left: el.offsetLeft })),
        profileColumns: getComputedStyle(document.querySelector('.people-grid')).gridTemplateColumns.split(' ').length,
        photoLayout: [...document.querySelectorAll('.profile-card')].map(card => {
          const photo = card.querySelector('.portrait-wrap').getBoundingClientRect();
          const text = card.querySelector('.person-copy').getBoundingClientRect();
          return { above: photo.bottom <= text.top + 1, fullWidth: Math.abs(photo.width - text.width) < 2 };
        }),
      }));
      metrics.push({ name, ...geometry });
      assert(geometry.content <= width + 1, name + ': no horizontal overflow');
      assert.deepEqual(geometry.clippedText, [], name + ': important text is not clipped inside its panel');
      assert.equal(geometry.broken, 0, name + ': source art loads');
      assert.match(geometry.heading, /Baat karo\./);
      assert.match(geometry.headingFont, /Nunito/i);
      assert.match(geometry.bodyFont, /Comfortaa/i);
      if (width >= 1088) {
        assert(Math.abs(geometry.siteWidth - Math.min(width - 64, 1760)) < 2, name + ': desktop uses available width up to readable cap');
      }
      if (width <= 480) {
        assert(geometry.profileTextSize >= 14, name + ': readable mobile profile text');
        assert(geometry.callButtonHeight >= 40, name + ': comfortable mobile call target');
      }
      assert.equal(await page.locator('.profile-card').count(), 9);
      assert.equal(geometry.profileColumns, width >= 900 ? 3 : width >= 600 ? 2 : 1, name + ': responsive profile columns');
      assert(geometry.photoLayout.every(photo => photo.above && photo.fullWidth), name + ': full-width photos above profile text');
      assert.equal(await page.locator('.category-card').count(), 9);
      if (width >= 1024) {
        const banner = await page.evaluate(() => {
          const heading = document.querySelector('#earn h2');
          const range = document.createRange();
          range.selectNodeContents(heading);
          const text = range.getBoundingClientRect();
          const button = document.querySelector('#earn button').getBoundingClientRect();
          return { separated: text.right <= button.left || text.left >= button.right || text.bottom <= button.top || text.top >= button.bottom };
        });
        assert(banner.separated, name + ': earning headline does not overlap button');
        const rowTops = [...new Set(geometry.categories.map(card => card.top))];
        assert.equal(rowTops.length, 3, name + ': three category rows');
        for (const top of rowTops) {
          const row = geometry.categories.filter(card => card.top === top);
          assert.equal(row.length, 3, name + ': three cards per row');
          assert.equal(new Set(row.map(card => card.left)).size, 3, name + ': distinct category columns');
        }
      }
      const previewButton = page.locator('.profile-card [data-preview-action]').first();
      await previewButton.click();
      const dialog = page.locator('#preview-dialog');
      assert(await dialog.evaluate(el => el.open), name + ': preview dialog opens');
      await page.keyboard.press('Escape');
      assert(!(await dialog.evaluate(el => el.open)), name + ': Escape closes dialog');
      assert(await previewButton.evaluate(el => document.activeElement === el), name + ': focus returns');
      await page.locator('#earn [data-preview-action]').click();
      await dialog.locator('[data-close-preview]').click();
      assert(!(await dialog.evaluate(el => el.open)), name + ': close button works');
      const search = page.locator('#people-search input[name="q"]');
      await search.fill('Ananya');
      await search.press('Enter');
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': local name search');
      await page.locator('[data-reset-filters]').first().click();
      assert.equal(await page.locator('.profile-card:visible').count(), 9, name + ': reset restores samples');
      await page.locator('.category-card').first().click();
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': category filters locally');
      await page.locator('[data-reset-filters]').first().click();
      await page.locator('#language-filter').selectOption('Kannada');
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': language filter works');
      await page.locator('[data-reset-filters]').first().click();
      await page.locator('#price-filter').selectOption('15');
      assert.equal(await page.locator('.profile-card:visible').count(), 6, name + ': price filter works');
      await page.locator('[data-reset-filters]').first().click();
      await search.fill('no matching sample name');
      await search.press('Enter');
      assert(await page.locator('.no-results').isVisible(), name + ': empty state');
      await page.locator('.no-results [data-reset-filters]').click();
      const favourite = page.locator('[data-favourite]').first();
      await favourite.click();
      assert.equal(await favourite.getAttribute('aria-pressed'), 'true', name + ': bookmark selected');
      await favourite.click();
      assert.equal(await favourite.getAttribute('aria-pressed'), 'false', name + ': bookmark deselected');
      if (width < 600) {
        const menu = page.locator('.menu-toggle');
        await menu.click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'true', name + ': mobile menu opens');
        await page.keyboard.press('Escape');
        assert.equal(await menu.getAttribute('aria-expanded'), 'false', name + ': Escape closes mobile menu');
        await menu.click();
        await page.locator('#main-navigation a[href="#categories"]').click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false', name + ': navigation closes menu');
        await page.locator('.footer-group summary').first().click();
        assert(await page.locator('.footer-group').first().evaluate(el => el.open), name + ': mobile footer accordion');
      }
      assert.equal(await page.locator('.footer-group').count(), 5, name + ': five footer columns');
      assert.equal(await page.locator('.footer-group li').count(), 40, name + ': complete footer');
      for (const platform of ['iPhone', 'Android', 'Mac', 'Windows']) {
        await page.locator(`[data-preview-action="download"][data-preview-label="${platform}"]`).click();
        assert.match(await dialog.innerText(), /downloads are not available yet/);
        await dialog.locator('[data-close-preview]').click();
      }
      const legalGroup = page.locator('.footer-group').last();
      if (width < 600) await legalGroup.locator('summary').click();
      await legalGroup.locator('[data-preview-label="Privacy policy"]').click();
      assert.match(await dialog.innerText(), /not published for this service yet/);
      await dialog.locator('[data-close-preview]').click();
      const anchors = await page.locator('a[href^="#"]').evaluateAll(links => links.map(a => a.getAttribute('href').slice(1)).filter(id => id && !document.getElementById(id)));
      assert.deepEqual(anchors, [], name + ': section links resolve');
      assert.deepEqual(mutations, [], name + ': preview never posts to backend');
      console.log(name, JSON.stringify(geometry));
    } catch (error) {
      failures.push({ name, error: String(error) });
      console.error(name, error);
    } finally { await page.close(); }
  }
  await writeFile('homepage-review/metrics.json', JSON.stringify({ metrics, failures }, null, 2));
  assert.equal(failures.length, 0, JSON.stringify(failures));
} finally { await browser.close(); server.close(); }
