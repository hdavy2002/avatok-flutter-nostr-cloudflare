import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const H = vi.hoisted(() => ({enabled: true}));
vi.mock('../src/routes/config', () => ({readConfig: async () => ({hdfcSmsEnabled: H.enabled})}));
import {fixture, request} from './hdfc_test_db';
import {hdfcPublicOrder as order, hdfcPublicStatus as status, hdfcPublicClaim as claim, hdfcPublicRecheck as recheck} from '../src/routes/hdfc_sms_public';
import {hdfcSmsIncoming} from '../src/routes/hdfc_sms_payments';
import {sha256Hex, hmacSha256Hex} from '../src/lib/payments/types';
import {createIntent, policy, saveReference, normalizePayerVpa, normalizePayerPhone, parsePayerVpa} from '../src/lib/hdfc_sms_smoke';

let f: ReturnType<typeof fixture>, now: number;
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const payer = 'payer.one@icici', otherPayer = 'payer.two@bank', phone = '9000000001';
beforeEach(() => { now = 1800000000500; vi.spyOn(Date, 'now').mockImplementation(() => now); f = fixture(); H.enabled = true; });
afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });
function req(path: string, body?: unknown, bearer = token) {
 const r = request(path, body); r.headers.set('authorization', `Bearer ${bearer}`);
 r.headers.set('cf-connecting-ip', '192.0.2.1'); return r;
}
interface Envelope {
 enabled: boolean;
 intent: {intent_id: string; status: string; reason_code: string | null; upi_url?: string; reference_revision: number; confirmed_at: number | null; amount_paise: number; currency: string; matching_mode: string; created_at: number; recover_until: number};
}
const value = (r: Response) => r.json() as Promise<Envelope>;
async function create(key = crypto.randomUUID(), bearer = token, vpa = payer, payerPhone = phone) {
 return order(req('/order', {request_key: key, payer_vpa: vpa, payer_phone: payerPhone}, bearer), f.env);
}
async function read(id: string, bearer = token) { return status(req(`/status?intent_id=${id}`, undefined, bearer), f.env); }
async function claimRef(id: string, reference = '000123456789', bearer = token) {
 return claim(req('/claim', {intent_id: id, bank_reference: reference, expected_reference_revision: 0}, bearer), f.env);
}
async function incoming(reference = '000123456789', vpa: string | null = payer, amount = '1.00', received: number | string = now, customMessage?: string) {
 const sender = 'VM-HDFCBK', message = customMessage ?? `Rs.${amount} credited to A/c XX1234${vpa === null ? '' : ` from VPA ${vpa}`} (UPI ${reference}).`;
 const b = {device_id: 'test-device', sender, message, received_at: typeof received === 'string' ? received : new Date(received).toISOString(), sim_slot: -1,
  message_hash: '', nonce: crypto.randomUUID(), sent_at: new Date(now).toISOString(), signature: ''};
 b.message_hash = await sha256Hex(`${sender}|${message}|${b.received_at}`);
 b.signature = await hmacSha256Hex(f.env.HDFC_SMS_DEVICE_SECRET!, [b.device_id, sender, message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
 return hdfcSmsIncoming(request('/incoming', b), f.env);
}
const claims = () => f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id IS NOT NULL').get()?.n;
const total = () => f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_intents').get()?.n;

describe('anonymous HDFC payer matching / real SQLite authority', () => {
 it('V1 requires a header capability, stores hash ownership and keeps payer data private', async () => {
  for (const route of [order, status, claim, recheck]) {
   const response = await route(request(`/route?token=${token}`, {request_key: crypto.randomUUID()}), f.env);
   expect(response.status).toBe(401);
   expect(response.headers.get('cache-control')).toBe('private, no-store');
   expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }
  expect((await create(crypto.randomUUID(), 'ordinary-clerk-jwt')).status).toBe(401);
  const response = await create(), result = await value(response);
  expect(response.status).toBe(200);
  expect(result.intent).toMatchObject({status: 'pending', amount_paise: 100, currency: 'INR', confirmed_at: null, matching_mode: 'payer_vpa', created_at: now});
  expect(result.intent.upi_url).toContain('tr=AV');
  expect(f.sql.prepare('SELECT uid,payer_vpa,payer_phone FROM hdfc_sms_smoke_intents').get()).toMatchObject({uid: `hdfc-public:${await sha256Hex(token)}`, payer_vpa: payer, payer_phone: '+919000000001'});
  for (const secret of [token, payer, phone]) expect(JSON.stringify(result)).not.toContain(secret);
 });

 it('V2 resumes only the same payer tuple and isolates every browser capability', async () => {
  const key = crypto.randomUUID(), id = (await value(await create(key))).intent.intent_id;
  expect((await value(await create(key, token, ` ${payer.toUpperCase()} `, '+919000000001'))).intent.intent_id).toBe(id);
  expect((await value(await create())).intent.intent_id).toBe(id);
  expect((await create(key, token, otherPayer)).status).toBe(409);
  expect((await create(crypto.randomUUID(), token, otherPayer)).status).toBe(409);
  expect((await create(key, token, payer, '+14155552671')).status).toBe(409);
  expect(total()).toBe(1);
  expect((await read(id, otherToken)).status).toBe(404);
  expect((await claimRef(id, '000123456789', otherToken)).status).toBe(404);
  expect((await recheck(req('/recheck', {intent_id: id}, otherToken), f.env)).status).toBe(404);
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(409);
  H.enabled = false;
  expect(await value(await create(key))).toMatchObject({enabled: false, intent: {intent_id: id, status: 'pending'}});
  expect((await value(await create(key))).intent.upi_url).toBeUndefined();
  expect((await create(crypto.randomUUID(), otherToken, otherPayer)).status).toBe(503);
 });

 it('V3 concurrently routes equal amounts by normalized payer VPA, with no booking or wallet effects', async () => {
  const responses = await Promise.all([create(), create(crypto.randomUUID(), otherToken, otherPayer)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const [a, b] = await Promise.all(responses.map(value));
  expect(a.intent.intent_id).not.toBe(b.intent.intent_id);
  await incoming('000123456780', otherPayer.toUpperCase());
  expect((await value(await read(a.intent.intent_id))).intent.status).toBe('pending');
  expect((await value(await read(b.intent.intent_id, otherToken))).intent.status).toBe('confirmed');
  await Promise.all([incoming('000123456781'), incoming('000123456781')]);
  expect((await value(await read(a.intent.intent_id))).intent.status).toBe('confirmed');
  expect(claims()).toBe(2);
  for (const table of ['hdfc_sms_test_bookings', 'commercial_policy_snapshots', 'wallet_ledger']) expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
 });

 it('V4 makes a fresh explicit attempt after confirmation and never reuses the previous bank reference', async () => {
  const key = crypto.randomUUID(), first = (await value(await create(key))).intent, firstTime = now;
  await incoming(); now += 10000;
  expect((await value(await create(key))).intent.intent_id).toBe(first.intent_id);
  const second = (await value(await create())).intent;
  expect(second.intent_id).not.toBe(first.intent_id); expect(second.created_at).toBe(now);
  await incoming('000123456789', payer, '1.00', firstTime);
  expect((await value(await read(second.intent_id))).intent.status).toBe('pending'); expect(claims()).toBe(1);
  await incoming('000123456790');
  expect((await value(await read(second.intent_id))).intent.status).toBe('confirmed'); expect(claims()).toBe(2);
  expect((await value(await read(first.intent_id))).intent.status).toBe('confirmed');
  expect((await value(await read(second.intent_id))).intent.upi_url).toBeUndefined();
 });

 it('V5 reserves an unresolved payer through expiry/recovery and delayed evidence settles only the original attempt', async () => {
  const first = (await value(await create())).intent, originalTime = now;
  now += 1800001;
  expect((await value(await read(first.intent_id))).intent.status).toBe('expired');
  expect((await value(await create())).intent.intent_id).toBe(first.intent_id);
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(409);
  // Legacy admin expiry housekeeping must never release a public payer lock.
  await createIntent(f.db, 'admin', crypto.randomUUID(), null, await policy(f.env), now);
  expect(f.sql.prepare('SELECT active FROM hdfc_sms_smoke_intents WHERE intent_id=?').get(first.intent_id)?.active).toBe(1);
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(409);
  await incoming('000123456789', payer, '1.00', originalTime + 1000);
  expect((await value(await read(first.intent_id))).intent.status).toBe('confirmed');
  expect((await value(await create())).intent.intent_id).not.toBe(first.intent_id);
 });

 it('V6 a same-payer race creates exactly one unresolved checkout, including the recovery boundary', async () => {
  const results = await Promise.all([create(), create(crypto.randomUUID(), otherToken)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]); expect(total()).toBe(1);
  const loser = results[0].status === 200 ? otherToken : token;
  const recover = Number(f.sql.prepare('SELECT recover_until FROM hdfc_sms_smoke_intents').get()?.recover_until);
  now = recover;
  expect((await create(crypto.randomUUID(), loser)).status).toBe(409);
  now++;
  expect((await create(crypto.randomUUID(), loser)).status).toBe(200);
  expect(total()).toBe(2);
 });

 it('V7 never accepts unrelated, absent or malformed payer fields, and a manual UTR cannot bypass VPA', async () => {
  const id = (await value(await create())).intent.intent_id;
  await incoming('000123456781', otherPayer);
  await incoming('000123456782', null);
  await incoming('000123456783', `${payer}@extra`);
  await incoming('000123456784', payer, '1.00', now, `Rs.1.00 credited to A/c XX1234 from VPA ${payer} (UPI 000123456784) from VPA ${payer} (UPI 000123456784)`);
  expect((await claimRef(id, '000123456781')).status).toBe(400);
  await recheck(req('/recheck', {intent_id: id}), f.env);
  expect(claims()).toBe(0); expect((await value(await read(id))).intent.status).toBe('pending');
  await incoming('000123456785'); expect((await value(await read(id))).intent.status).toBe('confirmed');
 });

 it('V8 stores signed receipts during pause, GET never reconciles and recheck recovers automatically', async () => {
  const id = (await value(await create())).intent.intent_id;
  H.enabled = false; await incoming(); H.enabled = true;
  const before = f.sql.prepare('SELECT total_changes() n').get()?.n;
  expect((await value(await read(id))).intent.status).toBe('pending');
  expect(f.sql.prepare('SELECT total_changes() n').get()?.n).toBe(before);
  expect((await value(await recheck(req('/recheck', {intent_id: id}), f.env))).intent.status).toBe('confirmed');
  await incoming('000123456789', payer, '2.00');
  expect((await value(await read(id))).intent).toMatchObject({status: 'review_pending', confirmed_at: null});
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(409);
 });

 it('V9 divergent VPA for a canonical bank reference revokes only its own confirmed attempt', async () => {
  const first = (await value(await create())).intent.intent_id;
  await incoming(); now += 10000;
  const second = (await value(await create())).intent.intent_id;
  await incoming('000123456790'); await incoming('000123456790', otherPayer);
  expect((await value(await read(second))).intent).toMatchObject({status: 'review_pending', confirmed_at: null});
  expect((await value(await read(first))).intent.status).toBe('confirmed');
  expect(claims()).toBe(2);
 });

 it('V10 rejects old or boundary-overlapping SMS timestamps rather than inferring a recent payment', async () => {
  const id = (await value(await create())).intent.intent_id;
  await incoming('000123456780', payer, '1.00', now - 1);
  await incoming('000123456781', payer, '1.00', new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  expect(claims()).toBe(0);
  expect((await value(await recheck(req('/recheck', {intent_id: id}), f.env))).intent.status).toBe('pending');
  await incoming('000123456782', payer, '1.00', now + 1000);
  expect((await value(await read(id))).intent.status).toBe('confirmed');
 });

 it('V11 two eligible unclaimed transfers remain review-pending with no arbitrary winner', async () => {
  const id = (await value(await create())).intent.intent_id;
  H.enabled = false;
  await incoming('000123456780'); await incoming('000123456781'); H.enabled = true;
  expect((await value(await recheck(req('/recheck', {intent_id: id}), f.env))).intent).toMatchObject({status: 'review_pending', confirmed_at: null});
  expect(claims()).toBe(0); expect((await create(crypto.randomUUID(), otherToken)).status).toBe(409);
 });

 it('V12 legacy exact-reference and public VPA ambiguity fails closed at the shared authority', async () => {
  const id = (await value(await create())).intent.intent_id, p = await policy(f.env);
  const legacy = await createIntent(f.db, 'admin', crypto.randomUUID(), null, p, now);
  expect(legacy).toBeTruthy(); await saveReference(f.db, legacy!, '000123456789', 0, now);
  await incoming();
  expect(claims()).toBe(0); expect((await value(await read(id))).intent.status).toBe('review_pending');
 });

 it('V13 preserves historical NULL payer evidence and never backfills an automatic claim', async () => {
  const id = (await value(await create())).intent.intent_id;
  H.enabled = false; await incoming();
  f.sql.exec('UPDATE hdfc_sms_smoke_receipts SET payer_vpa=NULL'); H.enabled = true;
  await recheck(req('/recheck', {intent_id: id}), f.env); expect(claims()).toBe(0);
  await incoming(); expect(claims()).toBe(0);
  expect(f.sql.prepare('SELECT payer_vpa,disposition FROM hdfc_sms_smoke_receipts').get()).toMatchObject({payer_vpa: null, disposition: 'review_required'});
 });

 it('V14 validates full payer inputs and keeps the amount server-owned', async () => {
  expect(normalizePayerVpa(` ${payer.toUpperCase()} `)).toBe(payer);
  expect(normalizePayerPhone(phone)).toBe('+919000000001'); expect(normalizePayerPhone('+14155552671')).toBe('+14155552671');
  for (const invalid of ['', 'abc', 'payer@@bank', 'payer..one@bank', 'payer@bank extra', 'payer@bank/extra', 'payer@bank?x']) expect(normalizePayerVpa(invalid)).toBeNull();
  for (const invalid of ['', '123', '+0123456789', '90000 00001', '1234567890']) expect(normalizePayerPhone(invalid)).toBeNull();
  expect(parsePayerVpa(`Rs.1.00 credited to A/c XX1234 from VPA ${payer} (UPI 000123456789)`)).toBe(payer);
  const base = {request_key: crypto.randomUUID(), payer_vpa: payer, payer_phone: phone};
  for (const payload of [{request_key: base.request_key}, {...base, payer_vpa: 'bad'}, {...base, payer_phone: 'bad'}, {...base, amount_paise: 1}, {...base, uid: 'admin'}]) expect((await order(req('/order', payload), f.env)).status).toBe(400);
  expect(total()).toBe(0);
 });

 it('V15 rate limits owners and shared IPs even when capability tokens rotate', async () => {
  const key = crypto.randomUUID();
  for (let n = 0; n < 10; n++) expect((await create(key)).status).toBe(200);
  const throttled = await create(key); expect(throttled.status).toBe(429); expect(throttled.headers.get('retry-after')).toBeTruthy();
  for (let n = 1; n <= 30; n++) expect((await create(crypto.randomUUID(), n.toString(16).padStart(64, '0'))).status).toBe(409);
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(429);
 });
});
