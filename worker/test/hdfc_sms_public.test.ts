import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const H = vi.hoisted(() => ({enabled: true}));
vi.mock('../src/routes/config', () => ({readConfig: async () => ({hdfcSmsEnabled: H.enabled})}));
import {fixture, request} from './hdfc_test_db';
import {hdfcPublicOrder as order, hdfcPublicStatus as status, hdfcPublicClaim as claim, hdfcPublicRecheck as recheck} from '../src/routes/hdfc_sms_public';
import {hdfcSmsIncoming} from '../src/routes/hdfc_sms_payments';
import {sha256Hex, hmacSha256Hex} from '../src/lib/payments/types';

let f: ReturnType<typeof fixture>, now: number;
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
beforeEach(() => { now = 1800000000500; vi.spyOn(Date, 'now').mockImplementation(() => now); f = fixture(); H.enabled = true; });
afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });
function req(path: string, body?: unknown, bearer = token) {
 const r = request(path, body);
 r.headers.set('authorization', `Bearer ${bearer}`);
 r.headers.set('cf-connecting-ip', '192.0.2.1');
 return r;
}
interface Envelope {
 enabled: boolean;
 intent: {intent_id: string; status: string; reason_code: string | null; upi_url?: string; reference_revision: number; confirmed_at: number | null; amount_paise: number; currency: string};
}
const value = (r: Response) => r.json() as Promise<Envelope>;
async function create(key = crypto.randomUUID(), bearer = token) {
 return order(req('/order', {request_key: key}, bearer), f.env);
}
async function read(id: string, bearer = token) { return status(req(`/status?intent_id=${id}`, undefined, bearer), f.env); }
async function claimRef(id: string, reference = '000123456789', revision = 0, bearer = token) {
 return claim(req('/claim', {intent_id: id, bank_reference: reference, expected_reference_revision: revision}, bearer), f.env);
}
async function incoming(reference = '000123456789', amount = '1.00', received = now) {
 const sender = 'VM-HDFCBK', message = `Rs.${amount} credited to A/c XX1234 (UPI ${reference}).`;
 const b = {device_id: 'test-device', sender, message, received_at: new Date(received).toISOString(), sim_slot: -1,
  message_hash: '', nonce: crypto.randomUUID(), sent_at: new Date(now).toISOString(), signature: ''};
 b.message_hash = await sha256Hex(`${sender}|${message}|${b.received_at}`);
 b.signature = await hmacSha256Hex(f.env.HDFC_SMS_DEVICE_SECRET!, [b.device_id, sender, message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
 return hdfcSmsIncoming(request('/incoming', b), f.env);
}
const claims = () => f.sql.prepare('SELECT count(*) n FROM hdfc_sms_smoke_receipts WHERE claimed_intent_id IS NOT NULL').get()?.n;

describe('anonymous HDFC confirmation / real SQLite authority', () => {
 it('P1 requires header capability, stores hash ownership and keeps responses private', async () => {
  for (const route of [order, status, claim, recheck]) {
   const response = await route(request(`/route?token=${token}`, {request_key: crypto.randomUUID()}), f.env);
   expect(response.status).toBe(401);
   expect(response.headers.get('cache-control')).toBe('private, no-store');
   expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  }
  expect((await create(crypto.randomUUID(), 'ordinary-clerk-jwt')).status).toBe(401);
  const response = await create(), result = await value(response);
  expect(response.status).toBe(200);
  expect(result.intent).toMatchObject({status: 'pending', amount_paise: 100, currency: 'INR', confirmed_at: null});
  expect(result.intent.upi_url).toContain('tr=AV');
  expect(f.sql.prepare('SELECT uid FROM hdfc_sms_smoke_intents').get()?.uid).toBe(`hdfc-public:${await sha256Hex(token)}`);
  expect(JSON.stringify(result)).not.toContain(token);
 });

 it('P2 isolates read, claim, retry and busy QR from another browser capability', async () => {
  const key = crypto.randomUUID(), first = await value(await create(key)), id = first.intent.intent_id;
  expect((await value(await create(key))).intent.intent_id).toBe(id);
  expect((await read(id, otherToken)).status).toBe(404);
  expect((await claimRef(id, '000123456789', 0, otherToken)).status).toBe(404);
  expect((await recheck(req('/recheck', {intent_id: id}, otherToken), f.env)).status).toBe(404);
  const busy = await create(crypto.randomUUID(), otherToken);
  expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({error: 'intent_busy'});
  expect((await order(req('/order', {request_key: key, uid: 'admin'}), f.env)).status).toBe(400);
  H.enabled = false;
  expect(await value(await create(key))).toMatchObject({enabled: false, intent: {intent_id: id, status: 'pending'}});
  expect((await value(await create(key))).intent.upi_url).toBeUndefined();
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(503);
 });

 it('P3 unrelated accepted credit cannot confirm; exact bank reference makes one authoritative claim', async () => {
  const id = (await value(await create())).intent.intent_id;
  await incoming();
  expect((await value(await read(id))).intent).toMatchObject({status: 'pending', reason_code: 'reference_required', confirmed_at: null});
  await recheck(req('/recheck', {intent_id: id}), f.env); expect(claims()).toBe(0);
  await claimRef(id, '999123456789');
  expect((await value(await read(id))).intent).toMatchObject({status: 'pending', reason_code: 'no_match'});
  expect((await claimRef(id, '000123456789', 0)).status).toBe(409);
  expect((await value(await claimRef(id, '000123456789', 1))).intent).toMatchObject({status: 'confirmed', confirmed_at: now});
  await incoming(); expect(claims()).toBe(1);
  expect((await value(await read(id))).intent.upi_url).toBeUndefined();
  expect(f.sql.prepare('SELECT count(*) n FROM hdfc_sms_test_bookings').get()?.n).toBe(0);
  expect(f.sql.prepare('SELECT count(*) n FROM commercial_policy_snapshots').get()?.n).toBe(0);
 });

 it('P4 submitted reference waits for signed receipt, GET does not reconcile and recheck can recover', async () => {
  const id = (await value(await create())).intent.intent_id;
  await claimRef(id); expect(claims()).toBe(0);
  H.enabled = false; await incoming();
  H.enabled = true;
  const before = f.sql.prepare('SELECT total_changes() n').get()?.n;
  expect((await value(await read(id))).intent.status).toBe('pending');
  expect(f.sql.prepare('SELECT total_changes() n').get()?.n).toBe(before);
  expect((await value(await recheck(req('/recheck', {intent_id: id}), f.env))).intent.status).toBe('confirmed');
  await incoming('000123456789', '2.00');
  expect((await value(await read(id))).intent).toMatchObject({status: 'review_pending', confirmed_at: null});
 });

 it('P5 rate limits an owner and the shared IP even when capability tokens rotate', async () => {
  const key = crypto.randomUUID();
  for (let n = 0; n < 10; n++) expect((await create(key)).status).toBe(200);
  const throttled = await create(key);
  expect(throttled.status).toBe(429); expect(throttled.headers.get('retry-after')).toBeTruthy();
  for (let n = 1; n <= 30; n++) expect((await create(crypto.randomUUID(), n.toString(16).padStart(64, '0'))).status).toBe(409);
  expect((await create(crypto.randomUUID(), otherToken)).status).toBe(429);
 });
});
