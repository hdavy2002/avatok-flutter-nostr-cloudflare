// Browser checks run only in the explicitly dispatched web build.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('dist');
const publicImageManifest = JSON.parse(await readFile(resolve('src/lib/publicImageManifest.json'), 'utf8'));
const borderSource = '/assets/saathum-bright/border.png';
const borderImmutable = publicImageManifest[borderSource];
assert(borderImmutable, 'public image manifest contains immutable border asset');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
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
      await Promise.all(images.map(image => image.decode().catch(() => undefined)));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
      heading: document.querySelector('h1')?.innerText,
      broken: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length,
      hero: (() => { const r = document.querySelector('.s-hero-art').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width }; })(),
    }));
    await page.locator('#experiences').scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await page.locator('.folk-category-grid').screenshot({ path: 'homepage-review/' + name + '-categories.png' });
    await page.locator('#home-events').scrollIntoViewIfNeeded();
    await page.locator('.folk-moment-grid').screenshot({ path: 'homepage-review/' + name + '-listings.png' });
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.locator('footer').screenshot({ path: 'homepage-review/' + name + '-footer.png' });
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
    assert(geometry.content <= width + 1, name + ': no horizontal overflow');
    assert.equal(geometry.broken, 0, name + ': all artwork loads');
    assert.match(geometry.heading, /Close to your roots\./);
    assert.match(await page.locator('.folk-site h1').evaluate(el => getComputedStyle(el).fontFamily), /Comfortaa/i, name + ': headings use Comfortaa');
    assert.match(await page.locator('.folk-site').evaluate(el => getComputedStyle(el).fontFamily), /Nunito/i, name + ': body uses Nunito');
    assert.notEqual(await page.locator('.folk-artwork').first().evaluate(el => getComputedStyle(el).filter), 'none', name + ': stickers retain a soft shadow');
    const categoryArt = await page.locator('.booking-artwork--category').evaluateAll(elements => elements.map(image => {
      const rect = image.getBoundingClientRect();
      return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    }));
    assert.equal(categoryArt.length, 6, name + ': six category scenes');
    for (const [index, art] of categoryArt.entries()) {
      assert(art.width > 0 && art.height > 0 && art.naturalWidth > 0 && art.naturalHeight > 0, name + ': category scene paints #' + index);
      assert(Math.abs(art.width - art.height) < 2, name + ': category scene remains square #' + index);
    }
    const listingArt = await page.locator('.booking-artwork--listing').evaluateAll(elements => elements.map(image => {
      const rect = image.getBoundingClientRect();
      return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
    }));
    assert.equal(listingArt.length, 3, name + ': three listing photos');
    for (const [index, art] of listingArt.entries()) {
      assert(art.width > 0 && art.height > 0 && art.naturalWidth > 0 && art.naturalHeight > 0, name + ': listing photo paints #' + index);
      assert(art.width > art.height, name + ': listing photo remains landscape #' + index);
    }
    assert.equal(await page.locator('.folk-moment').evaluateAll(els => els.filter(el => getComputedStyle(el).transform !== 'none').length), 0, name + ': listing cards stay straight');
    assert.equal(await page.locator('.folk-moment .folk-event-stamp').count(), 0, name + ': listings have no stamps');
    assert.equal(await page.locator('.folk-organise-elephant').count(), 2, name + ': organiser strip has two elephants');
    for (const asset of ['hero', 'satsang', 'culture', 'lotus']) {
      assert(await page.locator('[data-folk-artwork="' + asset + '"]').first().isVisible(), name + ': artwork is visible: ' + asset);
    }
    const footer = page.locator('footer');
    for (const label of ['Grievance Redressal', 'Child Safety', 'Cookies', 'Payouts', 'Careers']) {
      assert(await footer.getByRole('link', { name: label, exact: true }).isVisible(), name + ': footer link visible: ' + label);
    }
    assert.equal(await footer.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 248, 232)', name + ': cream folk footer is active');
    assert.equal(await footer.getByRole('link', { name: 'Careers', exact: true }).evaluate(el => getComputedStyle(el).color), 'rgb(22, 63, 60)', name + ': footer links keep readable teal ink');
    const borderBackgrounds = await page.evaluate(async expectedPath => {
      const decode = (element, pseudo) => new Promise(resolve => {
        const css = getComputedStyle(element, pseudo).backgroundImage;
        const match = css.match(/url\(["']?([^"')]+)["']?\)/);
        if (!match) return resolve({ css, path: null, width: 0, height: 0 });
        const image = new Image();
        const normalizedPath = () => new URL(match[1], location.href).pathname.replace(/^\/cdn-cgi\/image\/[^/]+\//, '/');
        image.onload = () => resolve({ css, path: normalizedPath(), width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ css, path: normalizedPath(), width: 0, height: 0 });
        image.src = new URL(match[1], location.href).href;
      });
      return Promise.all([decode(document.querySelector('.folk-ribbon'), null), decode(document.querySelector('footer'), '::after')]);
    });
    for (const [index, background] of borderBackgrounds.entries()) {
      assert.equal(background.path, borderImmutable, name + ': border background uses immutable manifest URL #' + index);
      assert(background.width > 0 && background.height > 0, name + ': border background decodes #' + index);
    }
    for (const selector of ['.folk-site', '.folk-moments', '.folk-organise-panel', '.bazaar-footer--folk', '.folk-category', '.folk-moment-art']) {
      const colors = await page.locator(selector).evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
      for (const color of colors) assert.notEqual(color, 'rgb(22, 22, 20)', name + ': legacy dark field is absent: ' + selector);
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