// node:test based — this repo's web/test/ uses node:test + node:assert (see
// device_checks.test.ts), not vitest; there is no vitest devDependency in
// web/package.json, so this follows the established convention instead.
// Run with: node --experimental-strip-types --test web/test/sendMail.test.ts
// (or after `astro build`/`tsc` transpiles it, `node --test`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendMail, htmlToText, type MailEnv } from '../src/lib/sendMail.ts';

const CF_ENV: MailEnv = { CF_ACCOUNT_ID: 'acct1', CF_EMAIL_API_TOKEN: 'tok1', BREVO_API_KEY: 'brevo1' };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('htmlToText strips tags', () => {
  assert.equal(htmlToText('<p>Hi <b>there</b></p>'), 'Hi there');
});

test('Cloudflare success returns ok with no fallback', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { success: true, errors: [], result: { delivered: ['a@b.com'], permanent_bounces: [], queued: [], message_id: 'cf-1' } } },
  ]);
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, CF_ENV, impl);
  assert.deepEqual(out, { ok: true, provider: 'cloudflare', messageId: 'cf-1', fallbackUsed: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /email\/sending\/send$/);
});

test('Cloudflare 429 falls back to Brevo', async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: { success: false, errors: [{ code: 10018, message: 'email.sending.error.rate_limit_exceeded' }] } },
    { status: 201, body: { messageId: 'brevo-1' } },
  ]);
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, CF_ENV, impl);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.provider, 'brevo');
    assert.equal(out.fallbackUsed, true);
    assert.equal(out.messageId, 'brevo-1');
  }
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api\.brevo\.com/);
});

test('Cloudflare permanent bounce does not fall back', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { success: true, errors: [], result: { delivered: [], permanent_bounces: ['a@b.com'], queued: [] } } },
  ]);
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, CF_ENV, impl);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.provider, 'cloudflare');
    assert.equal(out.retryable, false);
    assert.equal(out.error, 'permanent bounce');
  }
  assert.equal(calls.length, 1); // Brevo never called
});

test('No CF token goes straight to Brevo', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { messageId: 'brevo-2' } }]);
  const env: MailEnv = { BREVO_API_KEY: 'brevo1' };
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, env, impl);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.provider, 'brevo');
    assert.equal(out.fallbackUsed, false);
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.brevo\.com/);
});

test('Both providers unconfigured returns ok:false', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
  const env: MailEnv = {};
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, env, impl);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.provider, 'brevo');
    assert.equal(out.error, 'Brevo not configured');
  }
  assert.equal(calls.length, 0);
});

test('Cloudflare sender-not-verified (non-retryable config error) still falls back', async () => {
  const { impl, calls } = fakeFetch([
    { status: 400, body: { success: false, errors: [{ code: 10020, message: 'email.sending.error.sender_not_verified' }] } },
    { status: 201, body: { messageId: 'brevo-3' } },
  ]);
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, CF_ENV, impl);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.provider, 'brevo');
  assert.equal(calls.length, 2);
});

test('policy "cloudflare" does not fall back on failure', async () => {
  const { impl, calls } = fakeFetch([
    { status: 500, body: { success: false, errors: [{ code: 10099, message: 'email.sending.error.internal' }] } },
  ]);
  const env: MailEnv = { ...CF_ENV, EMAIL_PROVIDER: 'cloudflare' };
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, env, impl);
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
});

test('policy "brevo" ignores a configured Cloudflare token', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { messageId: 'brevo-4' } }]);
  const env: MailEnv = { ...CF_ENV, EMAIL_PROVIDER: 'brevo' };
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, env, impl);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.provider, 'brevo');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.brevo\.com/);
});

test('Cloudflare REST body uses documented field names (from.address, reply_to, attachments)', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { success: true, errors: [], result: { delivered: ['a@b.com'], permanent_bounces: [], queued: [] } } },
  ]);
  await sendMail(
    {
      to: 'a@b.com', subject: 's', html: '<p>hi</p>',
      from: { name: 'avaTOK', email: 'hello@avatok.ai' },
      replyTo: { email: 'r@b.com', name: 'R' },
      attachments: [{ filename: 'cv.pdf', content: 'QUJD', type: 'application/pdf' }],
      tags: ['t'],
    },
    CF_ENV,
    impl,
  );
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.from, { address: 'hello@avatok.ai', name: 'avaTOK' });
  assert.deepEqual(body.reply_to, { address: 'r@b.com', name: 'R' });
  assert.equal(body.replyTo, undefined);
  assert.equal(body.tags, undefined);
  assert.deepEqual(body.attachments, [{ content: 'QUJD', filename: 'cv.pdf', type: 'application/pdf', disposition: 'attachment' }]);
  assert.equal(body.text, 'hi');
});

test('Cloudflare permanent bounce match is case-insensitive', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { success: true, errors: [], result: { delivered: [], permanent_bounces: ['A@B.com'], queued: [] } } },
  ]);
  const out = await sendMail({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' }, CF_ENV, impl);
  assert.equal(out.ok, false);
  assert.equal(calls.length, 1);
});

test('Message over the Cloudflare 5 MiB limit skips Cloudflare and uses Brevo', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { messageId: 'brevo-big' } }]);
  const big = 'A'.repeat(6 * 1024 * 1024);
  const out = await sendMail(
    { to: 'a@b.com', subject: 's', html: '<p>hi</p>', attachments: [{ filename: 'cv.pdf', content: big, type: 'application/pdf' }] },
    CF_ENV,
    impl,
  );
  assert.equal(out.ok, true);
  if (out.ok) { assert.equal(out.provider, 'brevo'); assert.equal(out.fallbackUsed, true); }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.brevo\.com/);
});
