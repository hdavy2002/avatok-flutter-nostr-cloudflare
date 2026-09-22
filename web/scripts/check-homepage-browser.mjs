// Browser checks for the grand Saathum homepage. Run only from the web build workflow.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('dist');
const manifest = JSON.parse(await readFile(resolve('src/lib/publicImageManifest.json'), 'utf8'));
const borderSource = '/assets/saathum-bright/border.png';
const borderImmutable = manifest[borderSource];
assert(borderImmutable, 'immutable border asset is in the public image manifest');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    pathname = pathname.replace(/^\/cdn-cgi\/image\/[^/]+\//, '/');
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) return response.writeHead(403).end();
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(4179, '127.0.0.1', done));
const browser = await chromium.launch();
await mkdir('homepage-review', { recursive: true });
try {
  for (const [name, width, height] of [['ultra-wide', 2560, 1400], ['wide', 1920, 1200], ['desktop', 1440, 1000], ['desktop-breakpoint', 1122, 1000], ['tablet', 820, 1000], ['menu-breakpoint', 1100, 900], ['mobile', 390, 844], ['small-mobile', 320, 740]]) {
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
      hero: (() => { const r = document.querySelector('.grand-hero-art').getBoundingClientRect(); return { x:r.x, width:r.width, height:r.height }; })(),
    }));
    if (width > 1100) {
      const headerGeometry = await page.locator('header').evaluate(header => {
        const nav = header.querySelector('.avh-nav')?.getBoundingClientRect();
        const auth = header.querySelector('.avh-right')?.getBoundingClientRect();
        return { navRight: nav?.right ?? 0, authLeft: auth?.left ?? innerWidth };
      });
      assert(headerGeometry.navRight < headerGeometry.authLeft, name + ': header links and auth controls do not collide');
      const headerType = await page.locator('header').evaluate(header => ({
        logoSize: header.querySelector('.avh-logo-text')?.getBoundingClientRect().height ?? 0,
        navSize: parseFloat(getComputedStyle(header.querySelector('.avh-nav a')).fontSize),
        barRight: header.querySelector('.avh-bar')?.getBoundingClientRect().right ?? 0,
      }));
      assert(headerType.logoSize >= 28, name + ': header logo remains large');
      assert(headerType.navSize >= 16, name + ': header navigation remains readable');
      assert(headerType.barRight <= width + 1, name + ': header bar stays inside viewport');
    }
    await page.locator('#experiences').scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await page.locator('.grand-category-grid').screenshot({ path: 'homepage-review/' + name + '-categories.png' });
    await page.locator('.grand-hero').screenshot({ path: 'homepage-review/' + name + '-hero.png' });
    await page.locator('.grand-belonging').screenshot({ path: 'homepage-review/' + name + '-belonging.png' });
    await page.locator('.grand-culture').screenshot({ path: 'homepage-review/' + name + '-culture.png' });
    await page.locator('#home-events').scrollIntoViewIfNeeded();
    await page.locator('.grand-listing-grid').screenshot({ path: 'homepage-review/' + name + '-listings.png' });
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.locator('footer').screenshot({ path: 'homepage-review/' + name + '-footer.png' });
    await page.evaluate(async () => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await page.screenshot({ path: 'homepage-review/' + name + '.png', fullPage: true });
    assert(geometry.content <= width + 1, name + ': no horizontal overflow');
    assert.equal(geometry.broken, 0, name + ': all artwork loads');
    assert.match(geometry.heading, /Come home/);
    assert.match(await page.locator('.folk-site h1').evaluate(el => getComputedStyle(el).fontFamily), /Comfortaa/i, name + ': Comfortaa headings');
    assert.match(await page.locator('.folk-site').evaluate(el => getComputedStyle(el).fontFamily), /Nunito/i, name + ': Nunito body');
    assert(await page.locator('[data-grand-artwork="hero"]').isVisible(), name + ': grand hero is visible');
    const categoryArt = await page.locator('.booking-artwork--category').evaluateAll(elements => elements.map(image => {
      const rect = image.getBoundingClientRect(); return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth };
    }));
    assert.equal(categoryArt.length, 6, name + ': six category scenes');
    for (const [index, art] of categoryArt.entries()) {
      assert(art.width > 0 && art.height > 0 && art.naturalWidth > 0, name + ': category scene paints #' + index);
      assert(Math.abs(art.width - art.height) < 2, name + ': category scene remains square #' + index);
      if (width <= 600) assert(art.width >= 150, name + ': phone category art stays legible #' + index);
    }
    const listingArt = await page.locator('.booking-artwork--listing').evaluateAll(elements => elements.map(image => {
      const rect = image.getBoundingClientRect(); return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth };
    }));
    assert.equal(listingArt.length, 3, name + ': three listing photos');
    for (const [index, art] of listingArt.entries()) {
      assert(art.width > 0 && art.height > 0 && art.naturalWidth > 0, name + ': listing photo paints #' + index);
      assert(art.width > art.height, name + ': listing photo is landscape #' + index);
    }
    assert.equal(await page.locator('.grand-listing').evaluateAll(els => els.filter(el => getComputedStyle(el).transform !== 'none').length), 0, name + ': listings stay straight');
    assert.equal(await page.locator('.folk-seal, .folk-handnote, .folk-event-stamp').count(), 0, name + ': no retired stamps');
    assert.equal(await page.locator('.grand-elephant').count(), 2, name + ': organiser has two elephant artworks');
    assert(await page.locator('[data-folk-artwork="satsang"]').isVisible(), name + ': guru art visible');
    assert(await page.locator('[data-folk-artwork="culture"]').isVisible(), name + ': culture art visible');
    assert.notEqual(await page.locator('.grand-belonging-art .folk-artwork').evaluate(el => getComputedStyle(el).filter), 'none', name + ': guru art retains lifted shadow');
    const footer = page.locator('footer');
    for (const label of ['Grievance Redressal', 'Child Safety', 'Cookies', 'Payouts', 'Careers']) {
      assert(await footer.getByRole('link', { name: label, exact: true }).isVisible(), name + ': footer link visible: ' + label);
    }
    const footerBoxes = await footer.locator('.bf-col, .bf-legal-links').evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, border: style.borderStyle, radius: style.borderRadius, shadow: style.boxShadow };
    }));
    for (const box of footerBoxes) {
      assert.equal(box.background, 'rgba(0, 0, 0, 0)', name + ': footer menu background is open');
      assert.equal(box.border, 'none', name + ': footer menu has no enclosing border');
      assert.equal(box.radius, '0px', name + ': footer menu has no rounded panel');
      assert.equal(box.shadow, 'none', name + ': footer menu has no card shadow');
    }
    assert.equal(await footer.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(7, 95, 91)', name + ': teal grand footer');
    assert(await footer.locator('.bf-col a').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 15), name + ': footer links remain readable');
    const borderBackgrounds = await page.evaluate(async expectedPath => {
      const decode = (element, pseudo) => new Promise(resolve => {
        const css = getComputedStyle(element, pseudo).backgroundImage;
        const match = css.match(/url\(["']?([^"')]+)["']?\)/);
        if (!match) return resolve({ path: null, width: 0, height: 0 });
        const image = new Image();
        image.onload = () => resolve({ path: new URL(match[1], location.href).pathname.replace(/^\/cdn-cgi\/image\/[^/]+\//, '/'), width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ path: null, width: 0, height: 0 });
        image.src = new URL(match[1], location.href).href;
      });
      return Promise.all([decode(document.querySelector('.folk-ribbon'), null), decode(document.querySelector('footer'), '::after')]);
    });
    for (const [index, background] of borderBackgrounds.entries()) {
      assert.equal(background.path, borderImmutable, name + ': immutable border URL #' + index);
      assert(background.width > 0 && background.height > 0, name + ': border decodes #' + index);
    }
    if (width >= 1920) {
      const heroWidth = geometry.hero.width;
      assert(heroWidth > 600, name + ': wide hero artwork is generously sized');
      assert(await page.locator('.grand-belonging-art img').evaluate(el => el.getBoundingClientRect().width >= 480), name + ': guru art is large');
      assert(await page.locator('.grand-culture-art img').evaluate(el => el.getBoundingClientRect().width >= 500), name + ': culture art is large');
      assert(await page.locator('.grand-elephant img').first().evaluate(el => el.getBoundingClientRect().width >= 250), name + ': elephants are large');
    }
    if (width <= 1100) {
      const mobileHeader = await page.locator('header').evaluate(header => {
        const logo = header.querySelector('.avh-logo')?.getBoundingClientRect();
        const burger = header.querySelector('.avh-burger')?.getBoundingClientRect();
        return { logoRight: logo?.right ?? 0, burgerLeft: burger?.left ?? innerWidth, burgerRight: burger?.right ?? 0 };
      });
      assert(mobileHeader.logoRight + 8 < mobileHeader.burgerLeft, name + ': mobile logo clears menu button');
      assert(mobileHeader.burgerRight <= width + 1, name + ': mobile menu button stays inside viewport');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      assert(await page.locator('#avh-drawer').evaluate(dialog => dialog.open), name + ': mobile menu opens');
      await page.keyboard.press('Escape');
      await page.locator('#avh-drawer').waitFor({ state: 'hidden' });
      assert(await page.getByRole('button', { name: 'Open menu', exact: true }).evaluate(el => el === document.activeElement), name + ': Escape restores focus');
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.locator('#avh-drawer').getByRole('link', { name: 'Experiences', exact: true }).click();
      assert(!(await page.locator('#avh-drawer').evaluate(dialog => dialog.open)), name + ': anchor selection closes menu');
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