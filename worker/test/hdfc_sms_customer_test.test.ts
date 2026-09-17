import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({enabled: true, authCalls: 0}));
vi.mock('../src/routes/config', () => ({readConfig: async () => ({hdfcSmsEnabled: H.enabled})}));
vi.mock('../src/authz', () => ({
 requireUser: async (req: Request) => {
  H.authCalls++;
  const uid = req.headers.get('x-test-uid') ?? 'customer';
  return uid === 'guest' ? {error: 'unauthorized', status: 401}
   : uid === 'banned' ? {error: 'account banned', status: 403}
   : {uid: uid === 'relinked' ? 'customer' : uid};
 },
 isFail: (value: {error?: string}) => Boolean(value.error),
}));
import { fixture, request } from './hdfc_test_db';
import { hdfcCustomerRedeem as redeem, hdfcCustomerCurrent as current, hdfcCustomerOrder as order, hdfcCustomerStatus as status, hdfcCustomerClaim as claim, hdfcCustomerRecheck as recheck } from '../src/routes/hdfc_sms_customer_test';
import { hdfcSmsCreateOrder, hdfcSmsIncoming } from '../src/routes/hdfc_sms_payments';
import { createCustomerTestBooking, redeemInvite } from '../src/lib/hdfc_sms_customer_test';
import { policy, createIntent } from '../src/lib/hdfc_sms_smoke';
import { sha256Hex, hmacSha256Hex } from '../src/lib/payments/types';
let f: ReturnType<typeof fixture>, now: number;
beforeEach(() => { now = 1800000000500; vi.spyOn(Date, 'now').mockImplementation(() => now); f = fixture(); H.enabled = true; H.authCalls = 0; });
afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });
function req(path: string, body?: unknown, uid = 'customer') {
 const r = request(path, body, uid); r.headers.set('authorization', 'Bearer synthetic-customer-token'); return r;
}
async function body(response: Response) { return await response.json() as Record<string, any>; }
async function invite(uid: string | null = 'customer', expires = now + 86400000) {
 const id = crypto.randomUUID(), token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
 f.sql.prepare('INSERT INTO hdfc_sms_test_invites(invite_id,token_hash,created_at,expires_at,bound_uid,redeemed_at) VALUES(?,?,?,?,?,?)')
  .run(id, await sha256Hex(token), now - 1000, expires, uid, uid ? now : null);
 return {id, token};
}
async function create(id: string, uid = 'customer', key = crypto.randomUUID(), extra: Record<string, unknown> = {}) {
 const response = await order(req('/order', {invite_id: id, service_id: 'upi-demo-consultation', request_key: key, ...extra}, uid), f.env);
 return {response, value: await body(response)};
}
async function read(id: string, intentId?: string, uid = 'customer') {
 return body(await (intentId ? status(req(`/status?invite_id=${id}&intent_id=${intentId}`, undefined, uid), f.env)
  : current(req(`/current?invite_id=${id}`, undefined, uid), f.env)));
}
async function claimRef(id: string, intentId: string, reference = '000123456789', revision = 0, uid = 'customer') {
 return claim(req('/claim', {invite_id: id, intent_id: intentId, bank_reference: reference, expected_reference_revision: revision}, uid), f.env);
}
async function incoming(reference = '000123456789', amount = '1.00', received = now) {
 const sender = 'VM-HDFCBK', message = `Rs.${amount} credited to A/c XX1234 (UPI ${reference}).`;
 const b = {device_id: 'test-device', sender, message, received_at: new Date(received).toISOString(), sim_slot: -1,
  message_hash: '', nonce: crypto.randomUUID(), sent_at: new Date(now).toISOString(), signature: ''};
 b.message_hash = await sha256Hex(`${sender}|${message}|${b.received_at}`);
 b.signature = await hmacSha256Hex(f.env.HDFC_SMS_DEVICE_SECRET!, [b.device_id, sender, message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
 return hdfcSmsIncoming(request('/incoming', b), f.env);
}
function count(table: string) { return f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n; }
describe('invited customer test / real SQLite transactions', () => {
 it('AC1 header required before ordinary canonical auth, guest and ban gate; admin routes remain restricted', async () => {
  const v = await invite(), routes = [redeem, current, order, status, claim, recheck];
  for (const route of routes) {
   const r = request('/anything?token=query-only', {invite_token: v.token}, 'customer');
   expect((await route(r, f.env)).status).toBe(401);
  }
  expect(H.authCalls).toBe(0);
  const malformed = req('/current'); malformed.headers.set('authorization', 'Basic abc');
  expect((await current(malformed, f.env)).status).toBe(401);
  expect((await current(req('/current', undefined, 'guest'), f.env)).status).toBe(401);
  expect((await current(req('/current', undefined, 'banned'), f.env)).status).toBe(403);
  expect((await body(await current(req('/current', undefined, 'relinked'), f.env))).account_id).toBe('customer');
  expect((await hdfcSmsCreateOrder(request('/order', {listingId: 'avatok-upi-smoke-2026', request_key: crypto.randomUUID()}, 'customer'), f.env)).status).toBe(403);
  expect((await current(req('/current', undefined, 'other'), f.env)).status).toBe(404);
  expect((await create(crypto.randomUUID())).response.status).toBe(404);
 });
 it('AC2 atomic competing redemption has one owner and same-user retry works after expiry', async () => {
  const v = await invite(null);
  const results = await Promise.all(['alice', 'bob'].map(uid => redeemInvite(f.db, v.token, uid, now)));
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results.find(Boolean)!.bound_uid!, loser = winner === 'alice' ? 'bob' : 'alice';
  now += 90000000;
  const repeat = await redeem(req('/redeem', {invite_token: v.token}, winner), f.env);
  expect(await body(repeat)).toMatchObject({ok: true, account_id: winner, invite_id: v.id});
  expect((await redeem(req('/redeem', {invite_token: v.token}, loser), f.env)).status).toBe(404);
  const failed = await current(req(`/current?invite_id=${v.id}`, undefined, loser), f.env);
  expect(await body(failed)).toEqual({error: 'invite_unavailable', retryable: false});
  const stored = f.sql.prepare('SELECT * FROM hdfc_sms_test_invites').get();
  expect(JSON.stringify(stored)).not.toContain(v.token);
  expect(stored?.token_hash).toBe(await sha256Hex(v.token));
 });
 it('AC2 invalid/expired invitations and redemption throttling do not bind', async () => {
  const v = await invite(null, now - 1);
  expect((await redeem(req('/redeem', {invite_token: v.token}), f.env)).status).toBe(404);
  expect((await redeem(req('/redeem', {invite_token: 'wrong'}), f.env)).status).toBe(400);
  for (let n = 0; n < 19; n++) expect((await redeem(req('/redeem', {invite_token: 'f'.repeat(64)}), f.env)).status).toBe(404);
  expect((await redeem(req('/redeem', {invite_token: 'f'.repeat(64)}), f.env)).status).toBe(429);
  expect(f.sql.prepare('SELECT bound_uid FROM hdfc_sms_test_invites WHERE invite_id=?').get(v.id)?.bound_uid).toBeNull();
 });
 it('AC3 same-invite parallel creates/retries yield one stable pair; GETs and replies stay private', async () => {
  const v = await invite(), key = crypto.randomUUID();
  const results = await Promise.all([create(v.id, 'customer', key), create(v.id, 'customer', crypto.randomUUID())]);
  expect(results.map(r => r.response.status)).toEqual([200, 200]);
  expect(results[0].value).toEqual(results[1].value);
  expect(count('hdfc_sms_test_bookings')).toBe(1); expect(count('hdfc_sms_smoke_intents')).toBe(1);
  const value = results[0].value;
  expect(value.booking).toMatchObject({status: 'awaiting_payment', test_mode: true, amount_paise: 100, confirmed_at: null});
  expect(value.intent.order_id).toBeNull();
  expect(new URL(value.intent.upi_url).searchParams.get('tn')).toBe('AvaTOK test booking');
  expect(JSON.stringify(value)).not.toMatch(/payer_reference|token_hash|bank_reference|bound_uid/);
  expect(results[0].response.headers.get('cache-control')).toBe('private, no-store');
  const before = f.sql.prepare('SELECT total_changes() n').get()?.n;
  expect(await read(v.id, value.intent.intent_id)).toEqual(value);
  expect(await body(await current(req('/current'), f.env))).toEqual(value);
  expect(f.sql.prepare('SELECT total_changes() n').get()?.n).toBe(before);
  now += 90000000; H.enabled = false;
  const retry = await create(v.id, 'customer', key);
  expect(retry.response.status).toBe(200);
  expect(retry.value.booking.booking_id).toBe(value.booking.booking_id);
  expect(retry.value.intent.intent_id).toBe(value.intent.intent_id);
 });
 it('AC3 competing invites (same/different customer) cannot adopt QR or supersede it', async () => {
  for (const secondUid of ['customer', 'other']) {
   const first = await invite(), second = await invite(secondUid), p = await policy(f.env);
   const result = await Promise.all([
    createCustomerTestBooking(f.db, first.id, 'customer', crypto.randomUUID(), p),
    createCustomerTestBooking(f.db, second.id, secondUid, crypto.randomUUID(), p),
   ]);
   expect(result.filter(Boolean)).toHaveLength(1);
   expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_intents WHERE active=1').get()?.n).toBe(1);
   expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_intents WHERE superseded_by IS NOT NULL').get()?.n).toBe(0);
   const loser = await create(second.id, secondUid);
   expect(loser.response.status).toBe(409); expect(loser.value.error).toBe('intent_busy');
   expect(JSON.stringify(loser.value)).not.toContain(result[0]!.intent_id);
   now += 1800001;
  }
 });
 it('AC3 admin versus customer creates serialize; same-user admin QR is never adopted', async () => {
  const v = await invite('admin'), p = await policy(f.env);
  const [admin, customer] = await Promise.all([
   createIntent(f.db, 'admin', crypto.randomUUID(), null, p),
   createCustomerTestBooking(f.db, v.id, 'admin', crypto.randomUUID(), p),
  ]);
  expect(count('hdfc_sms_smoke_intents')).toBe(1);
  expect(new Set([admin?.intent_id, customer?.intent_id].filter(Boolean)).size).toBe(1);
  expect(count('hdfc_sms_test_bookings')).toBe(customer ? 1 : 0);
  now += 1800001;
  const next = await invite('admin');
  const existing = await createIntent(f.db, 'admin', crypto.randomUUID(), null, p);
  expect(existing).not.toBeNull();
  expect((await create(next.id, 'admin')).value.error).toBe('intent_busy');
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_test_bookings WHERE invite_id=?').get(next.id)?.n).toBe(0);
 });
 it('AC3 a reused request key on another invite cannot attach an old intent', async () => {
  const first = await invite(), second = await invite(), key = crypto.randomUUID();
  await create(first.id, 'customer', key); now += 1800001;
  expect((await create(second.id, 'customer', key)).value.error).toBe('intent_busy');
  expect(count('hdfc_sms_test_bookings')).toBe(1); expect(count('hdfc_sms_smoke_intents')).toBe(1);
 });
 it('AC3 failing booking INSERT rolls back new intent and expired active deactivation', async () => {
  const old = await invite(); await create(old.id); now += 1800001;
  const next = await invite();
  f.sql.exec("CREATE TRIGGER reject_test_booking BEFORE INSERT ON hdfc_sms_test_bookings BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  expect((await create(next.id)).response.status).toBe(503);
  expect(count('hdfc_sms_smoke_intents')).toBe(1); expect(count('hdfc_sms_test_bookings')).toBe(1);
  expect(f.sql.prepare('SELECT active FROM hdfc_sms_smoke_intents').get()?.active).toBe(1);
 });
 it.each([true, false])('AC4 receipt-before-reference=%s confirms exactly one persisted test booking and conflict demotes it', async (receiptFirst) => {
  const v = await invite(), c = (await create(v.id)).value, id = c.intent.intent_id;
  if (receiptFirst) await incoming();
  expect((await claimRef(v.id, id)).status).toBe(200);
  if (!receiptFirst) await incoming();
  await incoming();
  await claimRef(v.id, id);
  const confirmed = await body(await recheck(req('/recheck', {invite_id: v.id, intent_id: id}), f.env));
  expect(confirmed.booking).toMatchObject({booking_id: c.booking.booking_id, status: 'confirmed', confirmed_at: now});
  expect((await read(v.id, id)).booking).toEqual(confirmed.booking);
  expect(count('hdfc_sms_test_bookings')).toBe(1);
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id IS NOT NULL').get()?.n).toBe(1);
  await incoming('000123456789', '2.00');
  const disputed = await read(v.id, id);
  expect(disputed.booking).toMatchObject({booking_id: c.booking.booking_id, status: 'review_pending', confirmed_at: null});
  for (const table of ['wallet_ledger', 'commercial_checkout_operations', 'commercial_policy_snapshots']) expect(count(table)).toBe(0);
 });
 it('AC4 expiry retains same-payment recovery, then recovery deadline rejects a reference change', async () => {
  const v = await invite(), c = (await create(v.id)).value, received = now;
  now += 1800001;
  const expired = await read(v.id);
  expect(expired.intent.upi_url).toBeUndefined(); expect(expired.booking.status).toBe('expired');
  await incoming('000123456789', '1.00', received);
  expect((await body(await claimRef(v.id, c.intent.intent_id))).booking.status).toBe('confirmed');
  now += 86400001;
  expect((await claimRef(v.id, c.intent.intent_id, '111123456789', 1)).status).toBe(409);
 });
 it('AC4 amount alone, wrong reference and outside-window evidence never confirms; paused rail cannot claim', async () => {
  const v = await invite(), c = (await create(v.id)).value, id = c.intent.intent_id;
  await incoming();
  expect((await read(v.id)).booking.status).toBe('awaiting_payment');
  await claimRef(v.id, id, '999123456789');
  expect((await read(v.id)).booking.status).toBe('awaiting_payment');
  await incoming('999123456789', '1.00', now - 1000);
  expect((await body(await recheck(req('/recheck', {invite_id: v.id, intent_id: id}), f.env))).booking.status).toBe('awaiting_payment');
  H.enabled = false;
  expect((await claimRef(v.id, id, '000123456789', 1)).status).toBe(503);
  expect((await read(v.id)).intent.upi_url).toBeUndefined();
 });
 it('AC4 invitation expiry blocks only the first order, never existing recovery', async () => {
  const expired = await invite('customer', now - 1);
  expect((await create(expired.id)).value.error).toBe('invite_unavailable');
  expect(count('hdfc_sms_smoke_intents')).toBe(0);
  const v = await invite('customer', now + 100), c = (await create(v.id)).value;
  now += 101;
  expect((await create(v.id)).value.intent.intent_id).toBe(c.intent.intent_id);
  await incoming();
  expect((await body(await claimRef(v.id, c.intent.intent_id))).booking.status).toBe('confirmed');
 });
 it.each(['unsupported_reference', 'legacy'])('AC4 %s evidence never confirms a customer booking', async (kind) => {
  const v = await invite(), c = (await create(v.id)).value, p = await policy(f.env);
  if (kind === 'legacy') {
   f.sql.prepare("INSERT INTO hdfc_sms_smoke_receipts(message_hash,receiving_account_key,bank_reference,ingested_at,disposition) VALUES(?,?,?,?,'legacy')")
    .run('legacy-only', p.account, '000123456789', now);
  } else {
   await incoming('not-a-reference');
  }
  await claimRef(v.id, c.intent.intent_id);
  const state = await body(await recheck(req('/recheck', {invite_id: v.id, intent_id: c.intent.intent_id}), f.env));
  expect(state.booking.status).not.toBe('confirmed'); expect(state.booking.confirmed_at).toBeNull();
 });
 it('AC4 customer claim throttle is bounded and responses remain private', async () => {
  const v = await invite(), c = (await create(v.id)).value;
  for (let n = 0; n < 20; n++) expect((await recheck(req('/recheck', {invite_id: v.id, intent_id: c.intent.intent_id}), f.env)).status).toBe(200);
  const throttled = await recheck(req('/recheck', {invite_id: v.id, intent_id: c.intent.intent_id}), f.env);
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get('cache-control')).toBe('private, no-store');
  expect((await body(throttled)).error).toBe('rate_limited');
 });
 it('AC1/4 ownership, revision validation and exact fixed service reject cross-account or commercial inputs', async () => {
  const v = await invite(), c = (await create(v.id)).value, id = c.intent.intent_id, other = await invite('other');
  for (const extra of [{amount_paise: 1}, {currency: 'USD'}, {listingId: 'real'}, {replace_intent_id: id}, {service_id: 'real'}])
   expect((await create(v.id, 'customer', crypto.randomUUID(), extra)).response.status).toBe(400);
  expect((await claimRef(v.id, id, '123', 0)).status).toBe(400);
  expect((await claimRef(v.id, id, '000123456789', -1)).status).toBe(400);
  expect((await claimRef(v.id, id, '000123456789', 0, 'other')).status).toBe(404);
  expect((await status(req(`/status?invite_id=${other.id}&intent_id=${id}`, undefined, 'other'), f.env)).status).toBe(404);
  expect((await recheck(req('/recheck', {invite_id: other.id, intent_id: id}, 'other'), f.env)).status).toBe(404);
  await claimRef(v.id, id);
  expect((await claimRef(v.id, id, '111123456789', 0)).status).toBe(409);
 });
 it('AC1/8 customer readiness requires both additive tables and does not affect original admin creation', async () => {
  f.sql.exec('DROP TABLE hdfc_sms_test_bookings;');
  const result = await redeem(req('/redeem', {invite_token: 'a'.repeat(64)}), f.env);
  expect(result.status).toBe(503); expect((await body(result)).error).toBe('schema_not_ready');
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  f.sql.exec('DROP TABLE hdfc_sms_test_invites;');
  expect((await current(req('/current'), f.env)).status).toBe(503);
  expect((await hdfcSmsCreateOrder(request('/order', {listingId: 'avatok-upi-smoke-2026', request_key: crypto.randomUUID()}), f.env)).status).toBe(200);
 });
});
