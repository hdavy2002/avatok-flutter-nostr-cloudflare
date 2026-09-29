// [SAATHUM-WEATHER-NOTICE-1 2026-09-29] Real-SQLite tests for POST /api/admin/v2/events/:id/weather-delay:
// admin auth, confirmed buyers only, unverified numbers skipped, one message per buyer per day.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const H = vi.hoisted(() => ({ emails: [] as any[] }));
vi.mock('../src/authz', () => ({
  requireUser: async (req: Request) => req.headers.get('x-test-uid') === 'anonymous' ? { error: 'unauthorized', status: 401 } : { uid: req.headers.get('x-test-uid') ?? 'outsider' },
  isFail: (v: any) => Boolean(v.error),
  requireVerifiedWhatsApp: async () => null,
}));
vi.mock('../src/lib/identity', () => ({ emailFor: async () => 'buyer@example.in' }));
vi.mock('../src/lib/email_outbox', () => ({
  enqueueEmail: async (env: any, m: any) => {
    await env.DB_META.prepare('INSERT OR IGNORE INTO email_outbox(outbox_key) VALUES (?1)').bind(m.outboxKey).run();
    H.emails.push(m); return { status: 'queued' };
  },
}));
vi.mock('../src/hooks', async (orig) => ({ ...(await orig<any>()), track: async () => undefined, trackException: async () => undefined }));

import { fixture } from './hdfc_test_db';
import { matchAdmin2 } from '../src/routes/admin2';

const sql = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
let f: ReturnType<typeof fixture>;

function call(method: 'GET' | 'POST', id: string, uid = 'admin') {
  const path = `/api/admin/v2/events/${id}/weather-delay`;
  const m = matchAdmin2(method, path);
  if (!m || 'methodNotAllowed' in m) throw new Error('route not registered');
  return m.route.handler(new Request(`https://test.invalid${path}`, { method, headers: { 'x-test-uid': uid } }), f.env, m.params);
}
function checkout(id: string, uid: string, status: string, name = 'Asha') {
  f.sql.prepare(`INSERT INTO saathum_checkouts(checkout_id,uid,listing_id,request_key,quote_json,subtotal_rupees,gst_rupees,total_rupees,ticket_rupees,sankalp_json,prasad,status,receiving_account_key,amount_paise,created_at,expires_at,updated_at)
    VALUES(?,?,?,?,'{}',200,0,200,200,?,0,?,?,20000,1,2,1)`).run(id, uid, 'L1', crypto.randomUUID(), JSON.stringify({ name }), status, 'acct');
}
const waRows = () => f.sql.prepare(`SELECT checkout_id,message,status FROM whatsapp_outbox WHERE kind='weather_delay' ORDER BY checkout_id`).all() as any[];

beforeEach(() => {
  H.emails.length = 0;
  f = fixture();
  f.sql.exec(sql('2026-09-26-saathum-checkout.sql'));
  f.sql.exec(sql('2026-09-28-saathum-refund-policy-accept.sql'));
  f.sql.exec(sql('2026-09-29-saathum-upi-3layer.sql'));
  f.sql.exec(sql('2026-09-29-saathum-upi-3layer-tables.sql'));
  f.sql.exec(sql('2026-09-28-whatsapp-outbox.sql'));
  f.sql.exec(`CREATE TABLE email_outbox(outbox_key TEXT PRIMARY KEY);
   CREATE TABLE listings(id TEXT PRIMARY KEY,title TEXT);
   CREATE TABLE contact_verification(uid TEXT PRIMARY KEY,phone_verified INTEGER,phone_hash TEXT);
   CREATE TABLE phone_otp(uid TEXT,phone_hash TEXT,e164 TEXT,status TEXT,verified_at INTEGER);`);
  f.sql.exec(`INSERT INTO listings VALUES('L1','Kedar Havan')`);
  f.sql.exec(`INSERT INTO contact_verification VALUES('b1',1,'h1'),('b2',0,NULL),('b3',1,'h3')`);
  f.sql.exec(`INSERT INTO phone_otp VALUES('b1','h1','+919999900001','verified',1),('b3','h3','+919999900003','verified',1)`);
  checkout('11111111-aaaa', 'b1', 'confirmed');
  checkout('22222222-aaaa', 'b2', 'confirmed');          // no verified number
  checkout('33333333-aaaa', 'b3', 'awaiting_payment');   // not confirmed: must not be told
});
afterEach(() => { f.sql.close(); });

describe('weather-delay notice', () => {
  it('requires an admin', async () => {
    expect((await call('POST', 'L1', 'anonymous')).status).toBe(401);
    expect((await call('POST', 'L1', 'outsider')).status).toBe(403);
    expect(waRows()).toHaveLength(0);
  });

  it('404s for an unknown event', async () => {
    expect((await call('POST', 'nope')).status).toBe(404);
  });

  it('GET returns the confirmed-buyer count', async () => {
    expect(await (await call('GET', 'L1')).json()).toEqual({ recipients: 2 });
  });

  it('queues WhatsApp for confirmed verified buyers only, emails every confirmed buyer', async () => {
    const res = await call('POST', 'L1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recipients: 2, whatsapp_queued: 1, skipped_no_phone: 1, emails_queued: 2 });
    const rows = waRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].checkout_id).toBe('11111111-aaaa');
    expect(rows[0].status).toBe('queued');
    expect(rows[0].message).toContain('Namaste Asha.');
    expect(rows[0].message).toContain('Kedar Havan');
    expect(rows[0].message).toContain('(SAA-11111111)');
    expect(rows[0].message.toLowerCase()).not.toContain('youtube');
    expect(H.emails[0].subject).toBe('An update on your Kedar Havan video');
    expect(H.emails[0].from).toContain('Saa Thum Support');
  });

  it('a second click the same day sends nothing more', async () => {
    await call('POST', 'L1');
    const again = await (await call('POST', 'L1')).json();
    expect(again).toEqual({ recipients: 2, whatsapp_queued: 0, skipped_no_phone: 1, emails_queued: 0 });
    expect(waRows()).toHaveLength(1);
    expect(H.emails).toHaveLength(2);
  });
});
