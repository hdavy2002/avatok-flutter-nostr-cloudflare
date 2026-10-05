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
const categoryLabels = ['Doctors', 'Legal', 'Tax & money', 'Career & workplace', 'Relationships & marriage', 'Counsellor', 'Listener', 'Astrology', 'Practice'];
// Inspect computed sizes at every viewport so later media queries cannot silently undo floors.
async function inspectReadability(page) {
  return page.evaluate(() => {
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const groups = [
      [16, '#privacy-note h2, .privacy-intro, .privacy-diagram li>p, .privacy-diagram li>p span, .privacy-diagram strong, .privacy-bottom, .privacy-bottom button, .people-toolbar button, .people-toolbar select, .person-copy h3, .person-copy p:not(.person-talks):not(.person-topic):not(.verification-badge), .person-price, .sample-call, #earn h2, .earn-copy>p, .earn-steps li, .earn-steps span, .join-button, #apps h2, #apps>p, .download-button strong, .category-copy strong, .footer-group summary, .footer-group a, .footer-group button'],
      [15, '.sample-label, .profile-disclosure, .selected-category-label, .person-rating small, .person-talks, .person-topic, .earn-copy>small, .download-button small, #apps>small, .category-topic, .category-caveat, .listener-note, .footer-brand p, .footer-copyright'],
      [14, '.category-credential, .verification-badge, .verification-badge span'],
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
    const panels = '#privacy-note, .people-toolbar, .person-copy, .earn-copy, #apps, .category-copy, .footer-group[open]';
    for (const panel of document.querySelectorAll(panels)) {
      if (!visible(panel)) continue;
      if (panel.scrollWidth > panel.clientWidth + 2) clipping.push({ panel: panel.className, reason: 'horizontal overflow' });
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent.trim() || !visible(text.parentElement) || text.parentElement.closest('.sr-only, option, svg')) continue;
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
    checkSiblings('.privacy-diagram, .privacy-diagram li, .people-toolbar, .people-filters, .person-heading, .person-actions, .earn-copy, .earn-steps, .download-grid, .download-button, .footer-columns, .category-card, .category-copy');
    const badges = [...document.querySelectorAll('.category-credential, .verification-badge')].map(el => {
      const rect = el.getBoundingClientRect();
      const card = el.closest('.category-card, .profile-card').getBoundingClientRect();
      const style = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const textFits = [...range.getClientRects()].every(text => text.left >= rect.left - 2 && text.right <= rect.right + 2 && text.top >= rect.top - 2 && text.bottom <= rect.bottom + 2);
      const arrow = el.closest('.category-card')?.querySelector('.category-arrow')?.getBoundingClientRect();
      return { text: el.textContent.trim(), visible: visible(el), wraps: style.whiteSpace !== 'nowrap', fits: textFits && rect.left >= card.left - 2 && rect.right <= card.right + 2 && rect.top >= card.top - 2 && rect.bottom <= card.bottom + 2, arrowOverlap: arrow ? intersects(rect, arrow) : false };
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
    return { fontFailures, fontCounts, clipping, overlaps, badges, viewportOverflow };
  });
}
try {
  for (const [name, width, height] of [['reference', 1024, 1536], ['ultrawide', 2560, 1269], ['reference-desktop', 1760, 1100], ['wide', 1920, 1200], ['desktop', 1440, 1000], ['small-desktop', 1100, 900], ['below-small-desktop', 1099, 900], ['desktop-breakpoint', 900, 1000], ['below-desktop', 899, 1000], ['tablet', 820, 1000], ['small-tablet', 768, 1000], ['tablet-breakpoint', 600, 1000], ['below-tablet', 599, 900], ['large-mobile', 480, 900], ['reference-mobile', 452, 830], ['mobile', 390, 844], ['small-mobile', 360, 780], ['compact-mobile', 320, 740]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
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
      for (const [section, selector] of [['privacy', '#privacy-note'], ['people-toolbar', '.people-toolbar'], ['people-cards', '.people-grid'], ['earning', '#earn'], ['downloads', '#apps']]) {
        await page.locator(selector).screenshot({ path: `homepage-review/${name}-${section}.png` });
      }
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
      const readability = await inspectReadability(page);
      metrics.at(-1).readability = readability;
      assert(readability.fontCounts.every(group => group.count > 0), name + ': font checks cover each text class');
      assert.deepEqual(readability.fontFailures, [], name + ': normal/control 16px, secondary 15px, verification 14px floors');
      assert.deepEqual(readability.clipping, [], name + ': section text does not clip');
      assert.deepEqual(readability.overlaps, [], name + ': controls, headings and text do not overlap');
      assert.equal(readability.badges.length, 8, name + ': four category and four profile badges');
      assert(readability.badges.every(badge => badge.visible && badge.wraps && badge.fits && !badge.arrowOverlap), name + ': complete badges remain visible and can wrap');
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
        assert(geometry.profileTextSize >= 16, name + ': readable mobile profile text');
        assert(geometry.callButtonHeight >= 44, name + ': comfortable mobile call target');
      }
      assert.equal(await page.locator('.profile-card').count(), 9);
      assert.equal(geometry.profileColumns, width >= 900 ? 3 : width >= 600 ? 2 : 1, name + ': responsive profile columns');
      assert(geometry.photoLayout.every(photo => photo.above && photo.fullWidth), name + ': full-width photos above profile text');
      assert.equal(await page.locator('.category-card').count(), 9);
      assert.deepEqual(await page.locator('.category-copy strong').allTextContents(), categoryLabels, name + ': exact tile labels');
      assert.deepEqual((await page.locator('#category-filter option').allTextContents()).slice(1), categoryLabels, name + ': exact dropdown labels');
      assert.doesNotMatch(await page.locator('body').innerText(), /Home & property|Learning & skills|Wellbeing/, name + ': retired categories absent');
      const expectedRegistries = new Map([['Doctors', 'NMC'], ['Legal', 'Bar Council'], ['Tax & money', 'ICAI'], ['Counsellor', 'RCI']]);
      for (const [label, registry] of expectedRegistries) {
        const tile = page.locator('.category-card').filter({ has: page.locator('strong', { hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
        assert.match(await tile.locator('.category-credential').innerText(), new RegExp(registry));
        const id = await tile.getAttribute('data-category');
        const badge = page.locator(`.profile-card[data-category="${id}"] .verification-badge`);
        assert.equal(await badge.count(), 1, name + ': one matching illustrative badge for ' + label);
        assert.match(await badge.innerText(), new RegExp(registry));
        assert.match(await badge.getAttribute('aria-label'), /illustrative/i, name + ': sample verification is accessible');
      }
      const disclosure = await page.locator('.profile-disclosure').innerText();
      for (const detail of [/illustrative/i, /profiles/i, /qualifications/i, /verification badges/i]) assert.match(disclosure, detail, name + ': disclosure explains illustrative credentials');
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
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), name + ': dialog receives focus');
      await dialog.locator('[data-close-preview]').press('Enter');
      assert(!(await dialog.evaluate(el => el.open)), name + ': keyboard closes modal');
      assert(await previewButton.evaluate(el => document.activeElement === el), name + ': keyboard close returns focus');
      await previewButton.press('Enter');
      assert(await dialog.evaluate(el => el.open), name + ': keyboard opens modal');
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
      const exploreGroup = page.locator('.footer-group').filter({ has: page.locator('summary', { hasText: /^Explore$/ }) });
      const footerCategories = exploreGroup.locator('[data-category-select]');
      assert.equal(await exploreGroup.locator('li').count(), 11, name + ': eleven Explore entries');
      assert.deepEqual(await footerCategories.allTextContents(), categoryLabels, name + ': footer category labels');
      const categoryIds = await page.locator('.category-card').evaluateAll(tiles => tiles.map(tile => tile.dataset.category));
      for (const [index, id] of categoryIds.entries()) {
        for (const surface of ['tile', 'dropdown', 'footer']) {
          await page.locator('[data-reset-filters]').first().click();
          if (surface === 'tile') {
            const tile = page.locator('.category-card').nth(index);
            await tile.focus();
            await tile.press('Enter');
          } else if (surface === 'dropdown') await page.locator('#category-filter').selectOption(id);
          else {
            if (!(await exploreGroup.evaluate(el => el.open))) await exploreGroup.locator('summary').click();
            const footerCategory = footerCategories.nth(index);
            await footerCategory.focus();
            await footerCategory.press('Space');
          }
          assert.equal(await page.locator('#category-filter').inputValue(), id, `${name}: ${surface} selects ${categoryLabels[index]}`);
          const selectedCategory = page.locator('[data-selected-category-label]');
          assert(await selectedCategory.isVisible(), name + ': full selected category is visible outside native select');
          assert.equal(await selectedCategory.innerText(), 'Selected category: ' + categoryLabels[index]);
          assert(await selectedCategory.evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 15 && el.scrollWidth <= el.clientWidth + 2), name + ': selected category wraps readably');
          const visibleCategories = await page.locator('.profile-card:visible').evaluateAll(cards => cards.map(card => card.dataset.category));
          assert.deepEqual(visibleCategories, [id], `${name}: ${surface} shows matching sample for ${categoryLabels[index]}`);
          assert.equal(await page.locator('.category-card').nth(index).getAttribute('aria-pressed'), 'true', name + ': tile state follows filter');
          assert.equal(await footerCategories.nth(index).getAttribute('aria-pressed'), 'true', name + ': footer state follows filter');
          assert(!(await dialog.evaluate(el => el.open)), name + ': category navigation filters without preview dialog');
        }
      }
      await page.locator('[data-reset-filters]').first().click();
      await page.locator('#language-filter').selectOption('Kannada');
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': language filter works');
      await page.locator('[data-reset-filters]').first().click();
      await page.locator('#price-filter').selectOption('15');
      assert.equal(await page.locator('.profile-card:visible').count(), 6, name + ': price filter works');
      await page.locator('[data-reset-filters]').first().click();
      const firstSample = await page.locator('.profile-card').first().evaluate(card => ({ category: card.dataset.category, language: card.dataset.languages.split(', ')[0], price: Number(card.dataset.price), name: card.querySelector('h3').textContent.trim() }));
      await page.locator('#category-filter').selectOption(firstSample.category);
      await page.locator('#language-filter').selectOption(firstSample.language);
      await page.locator('#price-filter').selectOption(String([15, 20, 25].find(price => price >= firstSample.price)));
      await search.fill(firstSample.name);
      await search.press('Enter');
      assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': combined category/language/price/name filters');
      await page.locator('[data-reset-filters]').first().click();
      assert.equal(await search.inputValue(), '', name + ': reset clears query');
      for (const selector of ['#category-filter', '#language-filter', '#price-filter']) assert.equal(await page.locator(selector).inputValue(), '', name + ': reset clears ' + selector);
      assert.equal(await page.locator('[data-category-select][aria-pressed="true"]').count(), 0, name + ': reset clears category states');
      assert(!(await page.locator('[data-selected-category-label]').isVisible()), name + ': reset clears selected category label');
      assert.equal(await page.locator('.profile-card:visible').count(), 9, name + ': combined reset restores nine');
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
        assert(await menu.evaluate(el => document.activeElement === el), name + ': Escape returns menu focus');
        await menu.click();
        await page.locator('#main-navigation a[href="#categories"]').click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false', name + ': navigation closes menu');
        await page.locator('.footer-group summary').first().click();
        assert(await page.locator('.footer-group').first().evaluate(el => el.open), name + ': mobile footer accordion');
        await page.locator('#earn').scrollIntoViewIfNeeded();
        const mobileNav = page.locator('.mobile-bottom-nav');
        assert(await mobileNav.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return getComputedStyle(el).position === 'fixed' && rect.bottom <= innerHeight + 1 && rect.top < innerHeight && rect.bottom > 0;
        }), name + ': mobile quick navigation stays visible while scrolling');
      }
      assert.equal(await page.locator('.footer-group').count(), 5, name + ': five footer columns');
      assert.equal(await page.locator('.footer-group li').count(), 43, name + ': complete footer');
      for (const group of await page.locator('.footer-group').all()) {
        if (!(await group.evaluate(el => el.open))) await group.locator('summary').click();
      }
      await page.locator('.notebook-footer').screenshot({ path: `homepage-review/${name}-footer-open.png` });
      const openFooterReadability = await inspectReadability(page);
      metrics.at(-1).openFooterReadability = openFooterReadability;
      assert.deepEqual(openFooterReadability.fontFailures, [], name + ': open footer preserves font floors');
      assert.deepEqual(openFooterReadability.clipping, [], name + ': open footer text is not clipped');
      assert.deepEqual(openFooterReadability.overlaps, [], name + ': open footer does not overlap');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': open footer has no horizontal overflow');
      for (const platform of ['iPhone', 'Android', 'Mac', 'Windows']) {
        await page.locator(`[data-preview-action="download"][data-preview-label="${platform}"]`).click();
        assert.match(await dialog.innerText(), /downloads are not available yet/);
        await dialog.locator('[data-close-preview]').click();
      }
      const legalGroup = page.locator('.footer-group').last();
      if (!(await legalGroup.evaluate(el => el.open))) await legalGroup.locator('summary').click();
      await legalGroup.locator('[data-preview-label="Privacy policy"]').click();
      assert.match(await dialog.innerText(), /not published for this service yet/);
      await dialog.locator('[data-close-preview]').click();
      if ([320, 452, 1024].includes(width)) {
        await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await page.waitForTimeout(50);
        await page.locator('#category-filter').selectOption('relationships');
        assert.equal(await page.locator('.profile-card:visible').count(), 1, name + ': 200% text category filter remains usable');
        await page.locator('[data-reset-filters]').first().click();
        if (width < 600) {
          const menu = page.locator('.menu-toggle');
          await menu.click();
          assert.equal(await menu.getAttribute('aria-expanded'), 'true', name + ': 200% text mobile menu opens');
          await page.keyboard.press('Escape');
          assert.equal(await menu.getAttribute('aria-expanded'), 'false', name + ': 200% text mobile menu closes');
        }
        for (const group of await page.locator('.footer-group').all()) {
          if (!(await group.evaluate(el => el.open))) await group.locator('summary').click();
        }
        const enlarged = await inspectReadability(page);
        metrics.at(-1).enlargedReadability = enlarged;
        await page.screenshot({ path: `homepage-review/${name}-text-200.png`, fullPage: true });
        assert.deepEqual(enlarged.fontFailures, [], name + ': 200% text preserves font floors');
        assert.deepEqual(enlarged.clipping, [], name + ': 200% text does not clip');
        assert.deepEqual(enlarged.overlaps, [], name + ': 200% text does not overlap');
        assert(enlarged.viewportOverflow.content <= enlarged.viewportOverflow.viewport + 1,
          name + ': 200% text has no horizontal overflow: ' + JSON.stringify(enlarged.viewportOverflow));
      }
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
