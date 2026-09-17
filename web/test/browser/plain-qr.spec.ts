import { test, expect } from '@playwright/test';
import { UPI_APPS, upiAppHref, upiPlatform } from '../../src/islands/checkout/upiAppLinks';

const upi = 'upi://pay?pa=synthetic%40example&pn=AvaTOK&am=1.00&cu=INR&tn=AvaTOK+test+payment';
const appNames = ['Paytm', 'Google Pay', 'PhonePe'];
const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const iphoneUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('anonymous visitor gets QR and three app choices without invitation or writes', async ({page}) => {
  const calls: {method: string; auth?: string; url: string}[] = [];
  await page.route('**/api/pay/hdfc-sms/**', async route => {
    const req = route.request();
    calls.push({method: req.method(), auth: req.headers()['authorization'], url: req.url()});
    await route.fulfill({json: {amount_paise: 100, currency: 'INR', upi_url: upi}});
  });
  await page.goto('/plain-qr?invite=ignored#invite=private-old-invitation');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  const choices = page.getByRole('navigation', {name: 'Payment apps'});
  await expect(choices.getByRole('link')).toHaveCount(3);
  await expect(choices.getByRole('link')).toHaveText(appNames);
  for (const name of appNames) {
    await expect(choices.getByRole('link', {name: `Pay ₹1 with ${name}`})).toHaveAttribute('href', '#payment-qr');
  }
  await expect(choices.locator('img')).toHaveCount(3);
  await expect(page.getByText('On your phone, open this page')).toBeVisible();
  await expect(page.getByRole('link', {name: 'Pay ₹1 with UPI', exact: true})).toHaveCount(0);
  await expect(page).toHaveURL('/plain-qr');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('GET'); expect(calls[0].auth).toBeUndefined();
  expect(new URL(calls[0].url).pathname).toBe('/api/pay/hdfc-sms/qr');
  expect(calls[0].url).not.toContain('invite');
  expect(await page.evaluate(() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage)}))).toEqual({local: [], session: []});
});

test.describe('Android payment app choices', () => {
  test.use({userAgent: androidUserAgent, viewport: {width: 320, height: 720}});
  test('target the selected package with the complete ₹1 query and clean QR fallback', async ({page}) => {
    let requests = 0;
    await page.route('**/api/pay/hdfc-sms/qr', route => {
      requests++;
      return route.fulfill({json: {amount_paise: 100, currency: 'INR', upi_url: upi}});
    });
    await page.goto('/plain-qr');
    await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
    const packages = ['net.one97.paytm', 'com.google.android.apps.nbu.paisa.user', 'com.phonepe.app'];
    const fallback = encodeURIComponent('https://avatok.ai/test/upi');
    for (const [index, name] of appNames.entries()) {
      const link = page.getByRole('link', {name: `Pay ₹1 with ${name}`});
      await expect(link).toHaveAttribute('href', `intent://pay${new URL(upi).search}#Intent;scheme=upi;package=${packages[index]};S.browser_fallback_url=${fallback};end`);
      await expect(link).not.toHaveAttribute('target', '_blank');
      const bounds = await link.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    await expect(page.getByText('If it does not open, scan this QR', {exact: false})).toBeVisible();
    // Inspect the hand-off without launching an installed app or initiating payment.
    await expect(page.locator('a[href^="upi:"]')).toHaveCount(0);
    await expect(page.locator('a[href*="whatsapp"]')).toHaveCount(0);
    await page.clock.install();
    await page.clock.fastForward(60_000);
    // Leaving the QR open, including after a missing-app return, never auto-launches or retries.
    await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
    await expect(page).toHaveURL('/plain-qr');
    expect(requests).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});

test.describe('iPhone payment app choices', () => {
  test.use({userAgent: iphoneUserAgent});
  test('each app uses its documented iOS UPI route', async ({page}) => {
    await page.route('**/api/pay/hdfc-sms/qr', route => route.fulfill({json: {amount_paise: 100, currency: 'INR', upi_url: upi}}));
    await page.goto('/plain-qr');
    const prefixes = ['paytm://upi/pay', 'gpay://upi/pay', 'phonepe://upi/pay'];
    for (const [index, name] of appNames.entries()) {
      await expect(page.getByRole('link', {name: `Pay ₹1 with ${name}`})).toHaveAttribute('href', `${prefixes[index]}${new URL(upi).search}`);
    }
    await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
    await expect(page.locator('a[href^="upi:"]')).toHaveCount(0);
  });
});

test('app links preserve encoded payee, note, reference and merchant fields', () => {
  const query = '?pa=person%2Bshop%40bank&pn=Ava%20%26%20Co&am=1.00&cu=INR&tn=Tea%2Bsnack%20%23%201&tr=ref%2Fone&mc=0000&url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2';
  for (const app of UPI_APPS) {
    const href = upiAppHref(app, `upi://pay${query}`, 'android');
    expect(href.slice('intent://pay'.length, href.indexOf('#Intent'))).toBe(query);
    expect(href).not.toContain('whatsapp');
    expect(href).not.toContain('invite');
    expect(upiAppHref(app, `upi://pay${query}`, 'desktop')).toBe('#payment-qr');
  }
  expect(upiPlatform(androidUserAgent)).toBe('android');
  expect(upiPlatform(iphoneUserAgent)).toBe('ios');
  expect(upiPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5)).toBe('ios');
  expect(upiPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0)).toBe('desktop');
});

test('unavailable rail hides QR and app choices, retry can recover', async ({page}) => {
  let paused = true;
  await page.route('**/api/pay/hdfc-sms/qr', route => route.fulfill(paused
    ? {status: 503, json: {error: 'rail_paused'}}
    : {json: {amount_paise: 100, currency: 'INR', upi_url: upi}}));
  await page.goto('/plain-qr');
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('link')).toHaveCount(0);
  paused = false;
  await page.getByRole('button', {name: 'Try again'}).click();
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  await expect(page.getByRole('navigation', {name: 'Payment apps'}).getByRole('link')).toHaveCount(3);
});
