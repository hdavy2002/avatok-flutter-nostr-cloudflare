// [CALLVAAL-NOTEBOOK-HOME-1] Browser review, GitHub Actions only.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
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
try {
  for (const [name, width, height] of [['wide', 1920, 1200], ['desktop', 1440, 1000], ['reference', 1154, 1000], ['tablet', 820, 1000], ['mobile', 390, 844], ['small-mobile', 360, 780]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route(/posthog|\/api\//, route => route.abort());
    await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (const image of document.images) image.loading = 'eager';
      await Promise.all([...document.images].map(image => image.decode().catch(() => undefined)));
    });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
      broken: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
      heading: document.querySelector('h1')?.textContent,
      headingFont: getComputedStyle(document.querySelector('h1')).fontFamily,
      bodyFont: getComputedStyle(document.body).fontFamily,
      categories: [...document.querySelectorAll('.category-card')].map(el => Math.round(el.getBoundingClientRect().top)),
    }));
    assert(geometry.content <= width + 1, name + ': no horizontal overflow');
    assert.equal(geometry.broken, 0, name + ': portraits load');
    assert.match(geometry.heading, /Life ka sawaal/);
    assert.match(geometry.headingFont, /Comfortaa/i);
    assert.match(geometry.bodyFont, /Nunito/i);
    assert.equal(await page.locator('.profile-card').count(), 3);
    assert.equal(await page.locator('.category-card').count(), 6);
    assert.equal(await page.locator('.steps li').count(), 4);
    if (width >= 1154) assert.equal(new Set(geometry.categories).size, 2, name + ': reference 3 by 2 category grid');
    const faq = page.locator('#faq details').first();
    await faq.locator('summary').click();
    assert(await faq.evaluate(el => el.open), name + ': FAQ opens');
    await faq.locator('summary').click();
    assert(!(await faq.evaluate(el => el.open)), name + ': FAQ closes');
    const anchors = await page.locator('a[href^="#"]').evaluateAll(links => links.map(a => a.getAttribute('href').slice(1)).filter(id => id && !document.getElementById(id)));
    assert.deepEqual(anchors, [], name + ': all in-page destinations exist');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
    await page.locator('.notebook-hero').screenshot({ path: 'homepage-review/' + name + '-hero.png' });
    console.log(name, JSON.stringify(geometry));
    await page.close();
  }
} finally { await browser.close(); server.close(); }
