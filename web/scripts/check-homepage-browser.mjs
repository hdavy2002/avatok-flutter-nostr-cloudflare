// Owner-approved reference replica. Run only in manually dispatched GitHub CI.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

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
  for (const [name, width, height] of [['reference', 1024, 1536], ['wide', 1920, 1200], ['desktop', 1440, 1000], ['tablet', 820, 1000], ['mobile', 390, 844], ['small-mobile', 360, 780]]) {
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
        artwork.src = '/assets/callvaal/notebook/approved-reference.png';
        await artwork.decode();
        if (artwork.naturalWidth !== 1024 || artwork.naturalHeight !== 1536) throw new Error('Reference artwork did not load at original dimensions');
      });
      await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
      await page.locator('.notebook-hero').screenshot({ path: 'homepage-review/' + name + '-hero.png' });
      if (name === 'reference') {
        const actual = await page.screenshot({ fullPage: false });
        const expected = await readFile(resolve(root, 'assets/callvaal/notebook/approved-reference.png'));
        await sharp({ create: { width: 2048, height: 1536, channels: 3, background: '#fff' } })
          .composite([{ input: expected, left: 0, top: 0 }, { input: actual, left: 1024, top: 0 }])
          .png().toFile('homepage-review/reference-side-by-side.png');
        const difference = await sharp(expected).composite([{ input: actual, blend: 'difference' }]).png().toBuffer();
        await writeFile('homepage-review/reference-difference.png', difference);
        const stats = await sharp(difference).stats();
        metrics.push({ referencePixelDifferenceMean: stats.channels.slice(0, 3).map(channel => channel.mean), note: 'Diagnostic only; not a claim of pixel equivalence.' });
      }
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        broken: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
        heading: document.querySelector('h1')?.textContent,
        headingFont: getComputedStyle(document.querySelector('h1')).fontFamily,
        bodyFont: getComputedStyle(document.body).fontFamily,
        categories: [...document.querySelectorAll('.category-card')].map(el => ({ top: el.offsetTop, left: el.offsetLeft })),
      }));
      metrics.push({ name, ...geometry });
      assert(geometry.content <= width + 1, name + ': no horizontal overflow');
      assert.equal(geometry.broken, 0, name + ': source art loads');
      assert.match(geometry.heading, /Baat karo\./);
      assert.match(geometry.headingFont, /Fredoka/i);
      assert.match(geometry.bodyFont, /Nunito/i);
      assert.equal(await page.locator('.profile-card').count(), 8);
      assert.equal(await page.locator('.category-card').count(), 9);
      if (width >= 1024) {
        const banner = await page.evaluate(() => {
          const heading = document.querySelector('#earn h2');
          const range = document.createRange();
          range.selectNodeContents(heading);
          return { textRight: range.getBoundingClientRect().right, buttonLeft: document.querySelector('#earn button').getBoundingClientRect().left };
        });
        assert(banner.textRight < banner.buttonLeft, name + ': earning headline does not overlap button');
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
      assert.equal(await page.locator('.profile-card:visible').count(), 8, name + ': reset restores samples');
      await page.locator('.category-card').first().click();
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': category filters locally');
      await page.locator('[data-reset-filters]').first().click();
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
