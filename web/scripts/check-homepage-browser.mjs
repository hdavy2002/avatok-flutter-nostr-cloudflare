// Browser checks run only in the explicitly dispatched web build.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('dist');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // CI has no Cloudflare image endpoint: serve the identical immutable source.
    pathname = pathname.replace(/^\/cdn-cgi\/image\/[^/]+\//, '/');
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(4179, '127.0.0.1', done));
const browser = await chromium.launch();
await mkdir('homepage-review', { recursive: true });
try {
  for (const [name, width, height] of [['reference',1122,1402],['desktop',1440,1000],['mobile',390,844],['small-mobile',320,740]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route(/posthog|api\.avatok\.ai/, route => route.abort());
    await page.goto('http://127.0.0.1:4179/', { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const images = [...document.images];
      images.forEach(image => image.loading = 'eager');
      await Promise.all(images.map(image => image.decode()));
    });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth, content: document.documentElement.scrollWidth,
      heading: document.querySelector('h1')?.innerText,
      broken: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length,
      hero: (() => { const r = document.querySelector('.s-hero-art').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width }; })(),
    }));
    await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
    assert(geometry.content <= width + 1, name + ': no horizontal overflow');
    assert.equal(geometry.broken, 0, name + ': all original artwork loads');
    assert.match(geometry.heading, /Close to your roots\./);
    if (width === 1122) {
      assert(geometry.hero.x >= 0 && geometry.hero.x < width, 'Reference hero is inside the viewport');
      assert(geometry.hero.width > width * .45 && geometry.hero.width < width * .65, 'Reference hero keeps its balanced width');
    }
    if (width < 701) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      assert(await page.locator('#avh-drawer').evaluate(dialog => dialog.open), 'Mobile menu opens');
      await page.keyboard.press('Escape');
      assert(!(await page.locator('#avh-drawer').evaluate(dialog => dialog.open)), 'Escape closes mobile menu');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.locator('#avh-drawer').getByRole('link', { name: 'Experiences', exact: true }).click();
      assert(!(await page.locator('#avh-drawer').evaluate(dialog => dialog.open)), 'Anchor selection closes menu');
    }
    console.log(name, JSON.stringify(geometry));
    await page.close();
  }
} finally { await browser.close(); server.close(); }
