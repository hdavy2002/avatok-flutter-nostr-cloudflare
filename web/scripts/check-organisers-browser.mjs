// Runs against the CI-only server owned by check-homepage-browser.mjs.
import assert from 'node:assert/strict';

export async function checkOrganisersBrowser(browser) {
  for (const [name, width, height] of [['wide',2560,1400],['desktop',1440,1000],['tablet',820,1000],['mobile',390,844],['small-mobile',320,740]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route(/posthog|api\.avatok\.ai/, route => route.abort());
    await page.goto('http://127.0.0.1:4179/organisers/', { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const images = [...document.images];
      images.forEach(image => image.loading = 'eager');
      await Promise.all(images.map(image => image.decode().catch(() => undefined)));
    });
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      broken: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
      heading: getComputedStyle(document.querySelector('h1')).fontFamily,
      footer: getComputedStyle(document.querySelector('footer')).backgroundColor,
    }));
    assert(!geometry.overflow, name + ': organisers no horizontal overflow');
    assert.equal(geometry.broken, 0, name + ': organisers artwork loads');
    assert.match(geometry.heading, /Comfortaa/i);
    assert.equal(geometry.footer, 'rgb(255, 248, 232)');
    const hero = page.locator('#organisers-hero [data-folk-artwork="satsang"]');
    assert(await hero.isVisible(), name + ': saved guru hero visible');
    assert.equal(await hero.getAttribute('loading'), 'eager');
    if (width >= 1440) assert(await hero.evaluate(el => el.getBoundingClientRect().width >= 450), name + ': organiser hero artwork stays large');
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('.experience-topics-grid--organiser .rail-idea').count(), 13, name + ': every spiritual topic retained');
    assert.equal(await page.locator('#faq details').count(), 7);
    assert.equal(await page.locator('#guides a[href^="/blog/creator-ideas/"]').count(), 4);
    for (const label of ['All pujas','Refund policy','Contact']) assert(await page.locator('footer').getByRole('link', {name:label,exact:true}).isVisible(), name + ': complete footer ' + label);
    assert.equal(await page.locator('#organisers-hero .avh-auth-out').getAttribute('href'), '/sign-up');
    assert(await page.locator('#organisers-hero .avh-auth-out').isVisible());
    assert(!(await page.locator('#organisers-hero .avh-auth-in').isVisible()));
    // Exercise the preserved planner rather than checking only server-rendered defaults.
    await page.locator('[data-planner="participants"]').fill('100');
    await page.locator('[data-planner="costs"]').fill('1000');
    assert.equal(await page.locator('[data-planner-proceeds]').innerText(), '₹32,000');
    assert.equal(await page.locator('[data-planner-remainder]').innerText(), '₹31,000');
    await page.locator('[data-planner="ticketPrice"]').fill('10');
    assert(await page.locator('[data-planner-error]').isVisible(), name + ': invalid ticket error visible');
    assert(!(await page.locator('[data-planner-result]').isVisible()), name + ': invalid estimate hidden');
    await page.locator('[data-planner="ticketPrice"]').fill('500');
    assert(await page.locator('[data-planner-result]').isVisible(), name + ': valid estimate recovers');
    assert(!(await page.locator('[data-planner-error]').isVisible()));
    await page.locator('[data-planner="participants"]').fill('50');
    await page.locator('[data-planner="costs"]').fill('0');
    const withdrawal = page.locator('#faq details').filter({has:page.getByText('When can I withdraw?',{exact:true})});
    await withdrawal.locator('summary').click();
    assert.match(await withdrawal.innerText(), /Withdrawals are not available yet/);
    // [SAATHUM-ENTITY-1] Payouts link removed with the page.
    assert.equal(await withdrawal.getByRole('link',{name:'Read our Payouts page',exact:true}).count(), 0);
    await withdrawal.locator('summary').click();
    if (width <= 1100) {
      await page.getByRole('button',{name:'Open menu',exact:true}).click();
      assert(await page.locator('#avh-drawer').evaluate(el => el.open));
      await page.keyboard.press('Escape');
      await page.locator('#avh-drawer').waitFor({state:'hidden'});
    }
    for (const [suffix, selector] of [['hero','#organisers-hero'],['planner','[data-organiser-planner]'],['topics','#what-to-organise'],['footer','footer']]) {
      await page.locator(selector).screenshot({path:'homepage-review/organisers-' + name + '-' + suffix + '.png'});
    }
    await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:'homepage-review/organisers-' + name + '.png',fullPage:true});
    await page.context().addCookies([{name:'__client_uat',value:'1',url:'http://127.0.0.1:4179'}]);
    await page.reload({waitUntil:'networkidle'});
    assert(await page.locator('#organisers-hero .avh-auth-in').isVisible(), name + ': authenticated organiser CTA visible');
    assert.equal(await page.locator('#organisers-hero .avh-auth-in').getAttribute('href'), '/dashboard/listings/new');
    assert(!(await page.locator('#organisers-hero .avh-auth-out').isVisible()));
    console.log('organisers-' + name, JSON.stringify(geometry));
    await page.close();
  }
}
