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
  for (const [name, width, height] of [['reference',1122,1402],['desktop',1440,1000],['tablet',820,1000],['menu-breakpoint',1100,900],['mobile',390,844],['small-mobile',320,740]]) {
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
    assert.equal(geometry.broken, 0, name + ': all sticker artwork loads');
    assert.match(geometry.heading, /Close to your roots\./);
    const footer = page.locator('footer');
    for (const label of ['Grievance Redressal', 'Child Safety', 'Cookies', 'Payouts', 'Careers']) {
      assert(await footer.getByRole('link', { name: label, exact: true }).isVisible(), name + ': footer link visible: ' + label);
    }
    for (const selector of ['.folk-site', '.folk-moments', '.folk-organise-panel', '.bazaar-footer--folk', '.folk-category', '.folk-moment-art']) {
      const colors = await page.locator(selector).evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
      for (const color of colors) {
        const [r,g,b] = color.match(/[\d.]+/g).map(Number);
        assert(!(g > r + 12 || b > r + 12), name + ': no green/teal/blue field: ' + selector + ' ' + color);
      }
    }
    if (width === 1122) {
      assert(geometry.hero.x >= 0 && geometry.hero.x < width, 'Reference hero is inside the viewport');
      assert(geometry.hero.width > width * .45 && geometry.hero.width < width * .65, 'Reference hero keeps its balanced width');
    }
    if (width <= 1100) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      assert(await page.locator('#avh-drawer').evaluate(dialog => dialog.open), 'Mobile menu opens');
      await page.keyboard.press('Escape');
      await page.locator('#avh-drawer').waitFor({ state: 'hidden' });
      assert(await page.getByRole('button', { name: 'Open menu', exact: true }).evaluate(el => el === document.activeElement), 'Escape restores keyboard focus');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.locator('#avh-drawer').getByRole('link', { name: 'Experiences', exact: true }).click();
      assert(!(await page.locator('#avh-drawer').evaluate(dialog => dialog.open)), 'Anchor selection closes menu');
    }
    // Exercise the shared header's existing cookie-derived display hint only;
    // this does not authenticate a session or contact the real auth service.
    await page.context().addCookies([{ name: '__client_uat', value: '1', url: 'http://127.0.0.1:4179' }]);
    await page.reload({ waitUntil: 'networkidle' });
    if (width <= 1100) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const authNav = page.locator(width <= 1100 ? '#avh-drawer' : 'header');
    assert(await authNav.getByRole('link', { name: 'Dashboard', exact: true }).isVisible(), name + ': signed-in dashboard');
    assert(await authNav.getByRole('link', { name: 'Sign out', exact: true }).isVisible(), name + ': signed-in sign-out');
    assert(!(await authNav.getByRole('link', { name: 'Log in', exact: true }).isVisible()), name + ': signed-out login hidden');
    console.log(name, JSON.stringify(geometry));
    await page.close();
  }
} finally { await browser.close(); server.close(); }
