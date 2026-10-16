// [HF-HOME-NATIVE-3] Native Indian zine, responsive layout and shared Explore chrome. Run only in manually dispatched GitHub CI.
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
const brandConfig = JSON.parse(await readFile(resolve('../Specs/brand.json'), 'utf8'));
const homepageIdentity = brandConfig.homepageIdentity;

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
    const groups = [[14,'main h1, main h2, main h3, main p, main a, main button, main li, main small, main figcaption, main [data-meme-sticker], main [data-app-store-status], header a, header button, footer a, footer p, footer summary, dialog h2, dialog p, dialog a, dialog button']];
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
    const panels = 'main section, header, footer, dialog[open]';
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
                (/hidden|clip|scroll|auto/.test(style.overflowY) && !(el.tagName === 'DIALOG' && /scroll|auto/.test(style.overflowY)) && (rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2))) {
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
    checkSiblings('[data-approved-actions], [data-approved-creator-grid], [data-approved-steps]');
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
      actionGroups: document.querySelectorAll('[data-approved-actions]').length,
      creatorGrids: document.querySelectorAll('[data-approved-creator-grid]').length,
      stepGroups: document.querySelectorAll('[data-approved-steps]').length,
      creatorPreviews: document.querySelectorAll('[data-approved-creator]').length,
      videoActions: document.querySelectorAll('[data-preview-action="video"]').length,
      profileActions: document.querySelectorAll('[data-preview-action="profile"]').length,
      footerLinks: document.querySelectorAll('[data-callvaal-footer-group] li a').length,
      vectors: document.querySelectorAll('main svg[data-indian-art]').length,
      navigation: document.querySelectorAll('[data-callvaal-navigation]').length,
      menuToggles: document.querySelectorAll('[data-callvaal-menu-toggle]').length,
    };
    const layout = {
      shellWidth: document.querySelector('[data-native-home]')?.getBoundingClientRect().width,
      mainWidth: document.querySelector('#main-content')?.getBoundingClientRect().width,
      heroWidth: document.querySelector('[data-home-section="hero"]')?.getBoundingClientRect().width,
      headingSize: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),
    };
    return { fontFailures, fontCounts, clipping, overlaps, viewportOverflow, contractCoverage, layout };
  });
}
try {
  await new Promise(done => server.listen(4179, '127.0.0.1', done));
  browser = await chromium.launch();
  for (const width of [320,390,767,768,820,1024,1039,1440,1920,2560,3440]) {
    const name = 'home-' + width;
    const page = await browser.newPage({ viewport:{width,height:1000},deviceScaleFactor:1,reducedMotion:'reduce' });
    const browserErrors=[], mutations=[];
    await page.addInitScript(() => {
      window.__previewNotificationRequests=0;
      if ('Notification' in window) Notification.requestPermission=async()=>{window.__previewNotificationRequests++;return 'denied';};
    });
    page.on('pageerror', error=>browserErrors.push(String(error)));
    page.on('request',request=>{if(/\/api\//.test(request.url())&&!['GET','HEAD'].includes(request.method()))mutations.push(request.url());});
    await page.route('**/*', route => {
      const u=new URL(route.request().url());
      return u.origin!=='http://127.0.0.1:4179'||u.pathname.startsWith('/api/') ? route.abort() : route.continue();
    });
    try {
      await page.goto('http://127.0.0.1:4179/',{waitUntil:'networkidle'});
      await page.locator('html[data-homepage-ready="true"]').waitFor({state:'attached'});
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.querySelectorAll('main img')].map(image => {
          image.loading = 'eager';
          return image.complete ? Promise.resolve() : new Promise(done => { image.addEventListener('load', done, { once:true }); image.addEventListener('error', done, { once:true }); });
        }));
      });
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText('From reels. To real talks.');
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://'+homepageIdentity.domain+'/');
      await expect(page.locator('[data-approved-creator]')).toHaveCount(4);
      await expect(page.locator('main')).toContainText('Your number stays private. The influencer’s does too.');
      await expect(page.locator('main')).toContainText('We call you both and connect the conversation.');
      const textStructure=await page.evaluate(()=>({
        images:[...document.querySelectorAll('main img')].map(e=>({loaded:e.complete&&e.naturalWidth>0,width:e.width,height:e.height,naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight,srcset:e.srcset,sizes:e.sizes})),
        imageEffects:[...document.querySelectorAll('main img, main svg[data-indian-art]')].flatMap(image=>{
          const failures=[];
          for(let element=image;element&&element!==document.body;element=element.parentElement){
            const style=getComputedStyle(element);
            if(style.filter!=='none'||Number(style.opacity)!==1||style.mixBlendMode!=='normal') failures.push({element:element.className.baseVal??element.className,filter:style.filter,opacity:style.opacity,blend:style.mixBlendMode});
          }
          return failures;
        }),
        rasterInVector:document.querySelectorAll('main svg image, main svg foreignObject').length,
        headings:[...document.querySelectorAll('main h1,main h2,main h3')].every(e=>getComputedStyle(e).fontFamily.includes('Nunito')),
        body:[...document.querySelectorAll('main p,main button,main a')].filter(e=>!e.closest('[data-meme-sticker]')).every(e=>getComputedStyle(e).fontFamily.includes('Comfortaa')),
        gradients:[...document.querySelectorAll('main *,header,footer')].filter(e=>/gradient\(/.test(getComputedStyle(e).backgroundImage)).map(e=>e.className),
      }));
      assert(textStructure.images.length>=4,name+': distinct creator portraits are rendered as individual images');
      // naturalWidth is density-corrected for srcset; file resolution is checked by check-homepage.mjs.
      assert(textStructure.images.every(e=>e.loaded&&e.width>0&&e.height>0),name+': all individual portraits loaded');
      assert(textStructure.images.every(e=>/\b2048w\b/.test(e.srcset)&&e.sizes.length>0),name+': all photos have 2048px responsive candidates and sizes');
      assert.deepEqual(textStructure.imageEffects,[],name+': photos and native art have no blur, fading or blend effects');
      assert.equal(textStructure.rasterInVector,0,name+': native SVG art has no embedded raster');
      assert(textStructure.headings&&textStructure.body,name+': approved two-font system');
      const loadedFaces = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replaceAll('"','')));
      for (const family of ['Nunito','Comfortaa']) assert(loadedFaces.includes(family), name + ': actual local font loaded: ' + family);
      assert.deepEqual(textStructure.gradients,[],name+': no gradients');
      const readability=await inspectReadability(page);
      metrics.push({name,width,images:textStructure.images,...readability});
      for(const [key,count] of Object.entries({footerGroups:5,actionGroups:1,creatorGrids:1,stepGroups:1,creatorPreviews:4,profileActions:4,footerLinks:36,navigation:1,menuToggles:1})) assert.equal(readability.contractCoverage[key],count,name+': expected '+key+' coverage');
      assert(readability.contractCoverage.videoActions>=4,name+': each creator has a video sample');
      assert(readability.contractCoverage.vectors>=3,name+': native decorative SVG coverage');
      const artwork = await page.locator('main svg[data-indian-art]').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').map(e=>({name:e.getAttribute('data-indian-art'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})));
      metrics.at(-1).artwork=artwork;
      if(width>=1440) assert(artwork.filter(a=>a.width>=180&&a.height>=80).length>=2,name+': Indian art is a major visible part of the desktop composition');
      if(width<=390) assert(artwork.filter(a=>a.width>=80&&a.height>=40).length>=2,name+': meaningful Indian art survives on mobile');
      const stickers=await page.locator('main [data-meme-sticker]').evaluateAll(elements=>elements.map(e=>({tag:e.tagName,text:e.textContent.trim(),visible:e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden,fontSize:parseFloat(getComputedStyle(e).fontSize),fontFamily:getComputedStyle(e).fontFamily})));
      metrics.at(-1).stickers=stickers;
      assert(stickers.filter(s=>s.visible&&s.text.length>=3&&s.fontSize>=14&&/Nunito/.test(s.fontFamily)&&!['IMG','SVG','IMAGE','CANVAS'].includes(s.tag)).length>=3,name+': at least three readable meme stickers are native HTML');
      assert(Math.abs(readability.layout.mainWidth-readability.layout.shellWidth)<=1,name+': main fills the shared Explore shell');
      if(width>=1440){
        assert(Math.abs(readability.layout.shellWidth-Math.min(width-64,1760))<=1,name+': fluid Explore gutters and 1760px maximum');
        assert(readability.layout.heroWidth>=readability.layout.mainWidth*.95,name+': hero fills the fluid page');
      }
      await expect(page.locator('[data-home-section]')).toHaveCount(6);
      await expect(page.locator('#sample-disclosure')).toHaveCount(0);
      await expect(page.locator('main [class^="as-"], main [class*=" as-"]')).toHaveCount(0);
      assert(!/Design concept|Design preview · Illustrative creators/i.test(await page.locator('body').innerText()),name+': obsolete design paragraph is absent');
      const download=page.locator('[data-home-section="download"]');
      await expect(download.locator('[data-home-cta="download-google-play"]')).toHaveAttribute('href',`https://play.google.com/store/apps/details?id=${brandConfig.hfPlayPackageId}`);
      const apple=download.locator('[data-home-cta="download-app-store"]');
      if(await apple.count()) await expect(apple).toHaveAttribute('href',/^https:\/\/apps\.apple\.com\/.*\/id\d+/);
      else {
        const comingSoon=download.locator('[data-app-store-status="coming-soon"]');
        await expect(comingSoon).toContainText(/Coming soon/i);
        await expect(comingSoon).toHaveAttribute('aria-disabled','true');
        assert.notEqual(await comingSoon.evaluate(e=>e.tagName),'A',name+': unknown Apple listing cannot navigate');
      }
      assert.deepEqual(readability.fontFailures,[],name+': text floor');
      assert.deepEqual(readability.clipping,[],name+': no clipped text');
      assert.deepEqual(readability.overlaps,[],name+': no overlapping controls');
      assert(readability.viewportOverflow.content<=width+1,name+': no horizontal overflow');
      await page.screenshot({path:'homepage-review/'+name+'.png',fullPage:true});
      const dialog=page.locator('#approved-preview-dialog');
      const triggers=await page.locator('[data-preview-action]').all();
      assert(triggers.length>=8,name+': video and profile sample controls exist and are all exercised');
      for (const trigger of triggers) {
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(/illustrative|sample/i);
        await expect(dialog).toContainText(/no video plays/i);
        await expect(dialog).toContainText(/no video plays, call is booked or payment is taken|no call or payment|no call.*no payment/i);
        assert(await dialog.evaluate(e=>e.contains(document.activeElement)),name+': dialog gets focus');
        await dialog.locator('[data-close-preview]').press('Enter');
        await waitForPreviewClose(dialog,trigger,name);
        await trigger.press('Enter');
        await expect(dialog).toBeVisible();
        for(const key of ['Tab','Tab','Shift+Tab']){
          await page.keyboard.press(key);
          assert(await dialog.evaluate(e=>e.contains(document.activeElement)),name+': keyboard focus remains in the modal');
        }
        await page.keyboard.press('Escape');
        await waitForPreviewClose(dialog,trigger,name);
      }
      const menu=page.locator('[data-callvaal-menu-toggle]');
      const compactMenu=await menu.isVisible();
      if(compactMenu){await menu.click();await expect(menu).toHaveAttribute('aria-expanded','true');}
      const nav=page.locator('[data-callvaal-navigation]');
      await expect(nav.locator('a:visible')).toHaveText(['Explore','Blog','Sign in']);
      await page.evaluate(()=>{localStorage.setItem('saathum_guest_jwt','homepage-contract-session-hint');window.dispatchEvent(new Event('site:active-session-changed'));});
      await expect(nav.locator('a:visible')).toHaveText(['Explore','Blog','Dashboard','Sign out']);
      await page.evaluate(()=>{localStorage.removeItem('saathum_guest_jwt');window.dispatchEvent(new Event('site:active-session-changed'));});
      if(compactMenu){
        await page.keyboard.press('Escape');await expect(menu).toHaveAttribute('aria-expanded','false');await expect(menu).toBeFocused();
      }
      const groups=page.locator('[data-callvaal-footer-group]');
      await expect(groups).toHaveCount(5);
      await expect(groups.locator('summary')).toHaveText(footerGroups);
      await expect(groups.locator('li a')).toHaveCount(36);
      for(const group of await groups.all()){
        const summary=group.locator('summary');
        const wasOpen=await group.evaluate(e=>e.open);
        if(!wasOpen) await summary.click();
        for(const link of await group.locator('li a').all()) await expect(link).toBeVisible();
        if(!wasOpen) await summary.click();
      }
      await page.evaluate(()=>{document.documentElement.style.fontSize='200%';document.querySelectorAll('[data-callvaal-footer-group]').forEach(group=>{group.open=true;});});
      const enlarged=await inspectReadability(page);metrics.at(-1).enlarged=enlarged;
      assert.deepEqual(enlarged.fontFailures,[],name+': 200% text floor');
      assert.deepEqual(enlarged.clipping,[],name+': 200% text unclipped');
      assert.deepEqual(enlarged.overlaps,[],name+': 200% controls do not overlap');
      assert(enlarged.viewportOverflow.content<=width+1,name+': 200% no horizontal overflow');
      await page.screenshot({path:'homepage-review/'+name+'-text-200.png',fullPage:true});
      const enlargedTrigger=page.locator('[data-preview-action]').first();
      await enlargedTrigger.click();
      await expect(dialog).toBeVisible();
      const enlargedDialog=await inspectReadability(page);metrics.at(-1).enlargedDialog=enlargedDialog;
      assert.deepEqual(enlargedDialog.fontFailures,[],name+': enlarged modal text floor');
      assert.deepEqual(enlargedDialog.clipping,[],name+': enlarged modal content is unclipped');
      assert(enlargedDialog.viewportOverflow.content<=width+1,name+': enlarged modal has no horizontal overflow');
      await page.screenshot({path:'homepage-review/'+name+'-dialog-text-200.png',fullPage:true});
      await page.keyboard.press('Escape');
      await waitForPreviewClose(dialog,enlargedTrigger,name+': enlarged dialog');
      const missingAnchors=await page.locator('a[href^="#"]:visible').evaluateAll(links=>links.map(a=>a.hash.slice(1)).filter(id=>id&&!document.getElementById(id)));
      assert.deepEqual(missingAnchors,[],name+': anchors resolve');
      assert.deepEqual(mutations,[],name+': samples never mutate backend');
      assert.equal(await page.evaluate(()=>window.__previewNotificationRequests),0);
      assert.deepEqual(browserErrors,[],name+': no browser errors');
    } catch(error) {
      await page.screenshot({path:'homepage-review/'+name+'-failure.png',fullPage:true}).catch(()=>undefined);
      failures.push({name,error:String(error),browserErrors}); console.error(name,error);
    } finally {await page.close();}
  }

  // The 1760px desktop shell must grow beyond 1440, then stop growing on ultrawide screens.
  // Compare measured geometry; fixed screenshot/poster containers cannot pass this check.
  const wide=Object.fromEntries(metrics.filter(m=>[1440,1920,2560,3440].includes(m.width)).map(m=>[m.width,m.layout]));
  if(Object.keys(wide).length===4){
    try {
      assert(wide[1920].mainWidth>wide[1440].mainWidth+300,'Main layout grows with the wider viewport');
      for(const width of [2560,3440]) assert(Math.abs(wide[width].mainWidth-wide[1920].mainWidth)<=1,`${width}: page caps at Explore width`);
      assert(wide[1920].headingSize>=wide[1440].headingSize,'Wide typography does not shrink');
    }catch(error){failures.push({name:'wide-layout',error:String(error)});}
  } else failures.push({name:'wide-layout',error:'Missing one or more required wide layout measurements'});

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
      assert.equal(await page.title(), `Talking safely on a call | ${homepageIdentity.name}`, name + ': title uses configured homepage identity');
      assert(guide.bodyText.includes(homepageIdentity.name), name + ': visible chrome uses configured homepage identity');
      assert.match(guide.bodyText, /Rules for talking safely on a call/, name + ': guide heading is visible');
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
        const datedPolicies = new Set(['/terms', '/privacy', '/disclaimer', '/community-guidelines', '/about', '/contact', '/press', '/hosts/agreement', '/hosts/kyc', '/report', '/grievance', '/cookies', '/data-deletion', '/intermediary-policy']);
        await expect(page.locator('.hf-date')).toHaveText(datedPolicies.has(path) ? /^Last updated: \d{4}-\d{2}-\d{2}$/ : 'Last updated: {{DATE}}');
      }
      await expect(page.locator('[data-callvaal-footer-group] li')).toHaveCount(36);
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
