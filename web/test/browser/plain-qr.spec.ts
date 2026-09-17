import { test, expect } from '@playwright/test';

const upi = 'upi://pay?pa=synthetic%40example&pn=AvaTOK&am=1.00&cu=INR&tn=AvaTOK+test+payment';
test('anonymous visitor immediately gets QR and same-device ₹1 link without invitation or writes', async ({page}) => {
  const calls: {method: string; auth?: string; url: string}[] = [];
  await page.route('**/api/pay/hdfc-sms/**', async route => {
    const req = route.request();
    calls.push({method: req.method(), auth: req.headers()['authorization'], url: req.url()});
    await route.fulfill({json: {amount_paise: 100, currency: 'INR', upi_url: upi}});
  });
  await page.goto('/plain-qr?invite=ignored#invite=private-old-invitation');
  await expect(page.getByRole('img', {name: 'UPI payment QR code'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Pay ₹1 with UPI'})).toHaveAttribute('href', upi);
  await expect(page).toHaveURL('/plain-qr');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('GET'); expect(calls[0].auth).toBeUndefined();
  expect(new URL(calls[0].url).pathname).toBe('/api/pay/hdfc-sms/qr');
  expect(calls[0].url).not.toContain('invite');
  expect(await page.evaluate(() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage)}))).toEqual({local: [], session: []});
});

test('unavailable rail hides QR and payment link, retry can recover', async ({page}) => {
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
  await expect(page.getByRole('img')).toBeVisible();
});
