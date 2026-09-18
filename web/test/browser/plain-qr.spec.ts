import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { UPI_APPS, upiAppHref, upiPlatform } from '../../src/islands/checkout/upiAppLinks';

const upi = 'upi://pay?pa=synthetic%40example&pn=AvaTOK&am=1.00&cu=INR&tn=AvaTOK+test+payment';
const intentId = '96a2a16d-aee0-409f-a8b1-673f98315bda';
const appNames = ['Paytm', 'Google Pay', 'PhonePe'];
const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const iphoneUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function pending(overrides: Record<string, unknown> = {}) {
  return {intent_id: intentId, status: 'pending', reason_code: null, amount_paise: 100,
    currency: 'INR', expires_at: Date.now() + 120_000, recover_until: Date.now() + 1_800_000,
    reference_revision: 0, upi_url: upi, ...overrides};
}
async function mockPayment(page: Page, overrides: Record<string, unknown> = {}) {
  const intent = pending(overrides);
  await page.route('**/api/pay/hdfc-sms/public/**', route =>
    route.fulfill({json: {ok: true, enabled: true, intent}}));
}

test('anonymous visitor automatically creates one recoverable payment without an invitation', async ({page}) => {
  const calls: {method: string; auth?: string; url: string; body: unknown}[] = [];
  await page.route('**/api/pay/hdfc-sms/**', async route => {
    const req = route.request();
    calls.push({method: req.method(), auth: req.headers()['authorization'], url: req.url(),
      body: req.method() === 'POST' ? req.postDataJSON() : null});
    await route.fulfill({json: {ok: true, enabled: true, intent: pending()}});
  });
  await page.goto('/plain-qr?invite=ignored#invite=private-old-invitation');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  const choices = page.getByRole('navigation', {name: 'Payment apps'});
  await expect(choices.getByRole('link')).toHaveText(appNames);
  for (const name of appNames) {
    await expect(choices.getByRole('link', {name: `Pay ₹1 with ${name}`})).toHaveAttribute('href', '#payment-qr');
  }
  await expect(page.getByText('Scan this QR using your phone. Keep this page open for confirmation.', {exact: false})).toBeVisible();
  await expect(page).toHaveURL('/plain-qr');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(calls.filter(call => call.url.endsWith('/order'))).toHaveLength(1);
  expect(calls[0].method).toBe('POST');
  expect(calls[0].auth).toMatch(/^Bearer [0-9a-f]{64}$/);
  expect(calls[0].body).toEqual({request_key: expect.stringMatching(/^[0-9a-f-]{36}$/)});
  expect(calls[0].url).not.toContain('invite');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(['hdfc-public-payment-v1']);
  await expect(page.getByRole('heading', {name: 'Payment received'})).toHaveCount(0);
});

test('verified receipt replaces waiting and payment controls with the confirmed amount and reference', async ({page}) => {
  let verified = false;
  await page.route('**/api/pay/hdfc-sms/public/**', route => route.fulfill({json: {
    ok: true, enabled: true, intent: pending(verified ? {status: 'confirmed', upi_url: undefined, confirmed_at: Date.now()} : {}),
  }}));
  await page.goto('/plain-qr');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  verified = true;
  // Receipt arrival is learned by the scheduled status poll, without another tap.
  await expect(page.getByRole('heading', {name: 'Payment received'})).toBeVisible({timeout: 8000});
  await expect(page.getByText('We have received your payment.')).toBeVisible();
  await expect(page.getByText('₹1', {exact: true})).toBeVisible();
  await expect(page.getByText(intentId, {exact: true})).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('reload resumes the same session and app return checks immediately without assuming success', async ({page}) => {
  const orders: string[] = [];
  const statusAuth: string[] = [];
  let verified = false;
  await page.route('**/api/pay/hdfc-sms/public/**', route => {
    const request = route.request();
    if (request.url().endsWith('/order')) orders.push(request.headers()['authorization']);
    else {
      expect(new URL(request.url()).searchParams.get('intent_id')).toBe(intentId);
      statusAuth.push(request.headers()['authorization']);
    }
    return route.fulfill({json: {ok: true, enabled: true, intent: pending(verified ? {status: 'confirmed', upi_url: undefined} : {})}});
  });
  await page.goto('/plain-qr');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  expect(orders).toHaveLength(1);
  expect(statusAuth[0]).toBe(orders[0]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', {name: 'Payment received'})).toHaveCount(0);
  verified = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', {name: 'Payment received'})).toBeVisible({timeout: 4500});
});

test('UTR recovery is offered on receipt ambiguity, hides pay controls, and never confirms from a submitted reference alone', async ({page}) => {
  let revision = 0;
  let claim: unknown;
  await page.route('**/api/pay/hdfc-sms/public/**', route => {
    if (route.request().url().endsWith('/claim')) { claim = route.request().postDataJSON(); revision++; }
    return route.fulfill({json: {ok: true, enabled: true,
      intent: pending({reason_code: revision ? 'receipt_not_found' : 'reference_required', reference_revision: revision})}});
  });
  await page.goto('/plain-qr');
  await expect(page.getByText('Enter the 12-digit UPI transaction reference to confirm this payment.')).toBeVisible();
  await page.getByLabel('UPI transaction reference (UTR)').fill('123456789012');
  await page.getByRole('button', {name: 'Check payment reference'}).click();
  await expect(page.getByText('Checking your payment receipt. Do not pay again.')).toBeVisible();
  expect(claim).toEqual({intent_id: intentId, bank_reference: '123456789012', expected_reference_revision: 0});
  await expect(page.getByRole('navigation', {name: 'Payment apps'})).toHaveCount(0);
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Payment received'})).toHaveCount(0);
});

test('expired intent keeps same-payment recovery and never requests another payment', async ({page}) => {
  await mockPayment(page, {status: 'expired', expires_at: Date.now() - 1000, upi_url: undefined});
  await page.goto('/plain-qr');
  await expect(page.getByText('The QR expired.', {exact: false})).toContainText('Do not pay again');
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('link')).toHaveCount(0);
  await page.getByRole('button', {name: 'Paid but still waiting?'}).click();
  await expect(page.getByLabel('UPI transaction reference (UTR)')).toBeVisible();
});

test('busy and unavailable responses show no QR; retry preserves the request key and bearer', async ({page}) => {
  const keys: string[] = [];
  const auth: string[] = [];
  let busy = true;
  await page.route('**/api/pay/hdfc-sms/public/**', route => {
    keys.push(route.request().postDataJSON().request_key);
    auth.push(route.request().headers()['authorization']);
    return route.fulfill(busy ? {status: 409, json: {error: 'intent_busy'}}
      : {json: {ok: true, enabled: true, intent: pending()}});
  });
  await page.goto('/plain-qr');
  await expect(page.getByRole('alert')).toContainText('Another test payment is in progress');
  await expect(page.getByRole('img')).toHaveCount(0);
  busy = false;
  await page.getByRole('button', {name: 'Try again'}).click();
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  expect(keys[1]).toBe(keys[0]); expect(auth[1]).toBe(auth[0]);
});

test('network failure after creating a payment never becomes confirmation', async ({page}) => {
  await page.route('**/api/pay/hdfc-sms/public/**', route => route.request().url().endsWith('/order')
    ? route.fulfill({json: {ok: true, enabled: true, intent: pending()}}) : route.abort());
  await page.goto('/plain-qr');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Could not check');
  await expect(page.getByRole('heading', {name: 'Payment received'})).toHaveCount(0);
});

test.describe('Android payment app choices', () => {
  test.use({userAgent: androidUserAgent, viewport: {width: 320, height: 720}});
  test('target each package with the server amount and complete query', async ({page}) => {
    const dynamicUpi = upi.replace('am=1.00', 'am=1.37');
    await mockPayment(page, {amount_paise: 137, upi_url: dynamicUpi});
    await page.goto('/plain-qr');
    await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
    const packages = ['net.one97.paytm', 'com.google.android.apps.nbu.paisa.user', 'com.phonepe.app'];
    const fallback = encodeURIComponent('https://avatok.ai/test/upi');
    for (const [index, name] of appNames.entries()) {
      const link = page.getByRole('link', {name: `Pay ₹1.37 with ${name}`});
      await expect(link).toHaveAttribute('href', `intent://pay${new URL(dynamicUpi).search}#Intent;scheme=upi;package=${packages[index]};S.browser_fallback_url=${fallback};end`);
      await expect(link).not.toHaveAttribute('target', '_blank');
      const bounds = await link.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    await expect(page.getByText('If it does not open, scan this QR', {exact: false})).toBeVisible();
    await expect(page.locator('a[href^="upi:"]')).toHaveCount(0);
    await expect(page.locator('a[href*="whatsapp"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});

test.describe('iPhone payment app choices', () => {
  test.use({userAgent: iphoneUserAgent});
  test('each app uses its documented iOS UPI route', async ({page}) => {
    await mockPayment(page);
    await page.goto('/plain-qr');
    const prefixes = ['paytm://upi/pay', 'gpay://upi/pay', 'phonepe://upi/pay'];
    for (const [index, name] of appNames.entries()) {
      await expect(page.getByRole('link', {name: `Pay ₹1 with ${name}`})).toHaveAttribute('href', `${prefixes[index]}${new URL(upi).search}`);
    }
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
