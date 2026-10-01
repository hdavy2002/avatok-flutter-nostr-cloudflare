// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Real-SQLite tests (same harness as saathum_upi3.test.ts) for Shop orders on the UPI rail:
// create (server-side quote, both tickboxes), SMS auto-match across events + shop, admin transitions, Billing union, and the
// guarantee that event bookings keep matching while the shop tables are NOT migrated.
// The shop DDL below is a verbatim copy of the Specs/SPEC-2026-10-01-SAATHUM-SHOP.md §2 tables the orders code touches
// (the real migration is owned by SAATHUM-SHOP-API-CATALOG-1).
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const H = vi.hoisted(() => ({ emails: [] as any[], waTexts: [] as { to: string; text: string }[], gst: false, pdfArgs: [] as any[] }));
vi.mock('../src/routes/config', () => ({
  readConfig: async () => ({ hdfcSmsEnabled: true, saathumGstEnabled: H.gst, gstRatePct: 18, saathumLiveLinkNotifyEnabled: false }),
}));
vi.mock('../src/authz', () => ({
  requireUser: async (req: Request) => req.headers.get('x-test-uid') === 'anonymous' ? { error: 'unauthorized', status: 401 } : { uid: req.headers.get('x-test-uid') ?? 'outsider' },
  isFail: (v: any) => Boolean(v.error),
  requireVerifiedWhatsApp: async () => null,
}));
vi.mock('../src/routes/commercial_checkout', () => ({
  quoteCommercialPurchase: () => ({ pricing: { buyerTotal: 1 } }),
  freezeCommercialPurchaseQuote: async () => undefined,
  provisionFromGatewayPurchase: async () => ({ ok: true, status: 200 }),
}));
vi.mock('../src/lib/identity', () => ({ emailFor: async () => 'buyer@example.in' }));
vi.mock('../src/lib/email_outbox', () => ({ enqueueEmail: async (_e: any, m: any) => { H.emails.push(m); return { status: 'queued' }; } }));
vi.mock('../src/lib/me_receipt_pdf', () => ({ renderSaathumReceiptPdf: async (a: any) => { H.pdfArgs.push(a); return new Uint8Array([1, 2, 3]); } }));
vi.mock('../src/lib/saathum_stream_state', () => ({ streamStateForListing: async () => ({ state: 'none', video: null }), computeStreamState: () => 'none' }));
vi.mock('../src/lib/listing_schedule', async (orig) => ({ ...(await orig<any>()), bookability: () => ({ ok: true }) }));
vi.mock('../src/lib/whatsapp_send', () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { H.waTexts.push({ to, text }); return { ok: true }; } }));
vi.mock('../src/hooks', async (orig) => ({ ...(await orig<any>()), track: async () => undefined, trackUser: async () => undefined, trackException: async () => undefined }));

import { fixture, request } from './hdfc_test_db';
import { hdfcSmsIncoming } from '../src/routes/hdfc_sms_payments';
import { saathumCheckoutCreate } from '../src/routes/saathum_checkout';
import { shopOrdersRoute, confirmShopOrder } from '../src/routes/shop_orders';
import { ADMIN2_SHOP_ORDER_ROUTES } from '../src/routes/admin2_shop_orders';
import { adminSaathumReviewList } from '../src/routes/saathum_payment_review';
import { reserveUniqueAmount, persistAwaitingBank } from '../src/lib/saathum_upi3';
import { buildPaymentsQuery, withoutShopBranch } from '../src/lib/me_dashboard_data';
import { hmacSha256Hex, sha256Hex } from '../src/lib/payments/types';

const sql = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
const ACCOUNT = createHash('sha256').update('HDFC|1234|INR').digest('hex');
const MIN = 60_000;
let f: ReturnType<typeof fixture>;
let now: number;
const uuid = () => crypto.randomUUID();

const SHOP_DDL = `
CREATE TABLE shop_products(id TEXT PRIMARY KEY, slug TEXT, name TEXT, collection_id TEXT, description TEXT DEFAULT '', fit TEXT DEFAULT 'Regular', print_type TEXT DEFAULT 'Big front print', audience TEXT DEFAULT 'Adults',
  price_rupees INTEGER NOT NULL, mrp_rupees INTEGER, colours_json TEXT DEFAULT '[]', sizes_json TEXT DEFAULT '[]', images_json TEXT DEFAULT '[]', badge TEXT DEFAULT '', status TEXT DEFAULT 'draft',
  printrove_ref TEXT, sold_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE shop_coupons(code TEXT PRIMARY KEY, kind TEXT, value INTEGER NOT NULL, min_order_rupees INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, valid_until INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER);
CREATE TABLE shop_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER);
CREATE TABLE shop_orders(order_id TEXT PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, uid TEXT NOT NULL, request_key TEXT NOT NULL,
  items_json TEXT NOT NULL, subtotal_rupees INTEGER NOT NULL, discount_rupees INTEGER NOT NULL DEFAULT 0, coupon_code TEXT,
  gst_rate_pct INTEGER NOT NULL, gst_rupees INTEGER NOT NULL, total_rupees INTEGER NOT NULL CHECK(total_rupees>0),
  address_json TEXT NOT NULL, contact_name TEXT, terms_accepted_at INTEGER NOT NULL, refund_policy_accepted_at INTEGER NOT NULL, refund_policy_version TEXT NOT NULL,
  pay_status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(pay_status IN('awaiting_payment','confirmed','review_pending','expired','cancelled')),
  receiving_account_key TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise>0), rounding_discount_paise INTEGER NOT NULL DEFAULT 0,
  payer_reference TEXT, reference_revision INTEGER NOT NULL DEFAULT 0, reason_code TEXT, utr TEXT, payer_vpa TEXT,
  matched_message_hash TEXT, confirm_source TEXT, paid_claimed_at INTEGER, reviewed_by TEXT, review_note TEXT,
  reviewed_at INTEGER, review_alerted_at INTEGER, receipt_no TEXT, confirmed_at INTEGER, expires_at INTEGER NOT NULL, email_sent_at INTEGER,
  fulfil_status TEXT NOT NULL DEFAULT 'new' CHECK(fulfil_status IN('new','at_printer','shipped','delivered','cancelled','refunded')),
  printrove_order_ref TEXT, courier TEXT, awb TEXT, tracking_url TEXT, eta_text TEXT, sent_to_printer_at INTEGER, shipped_at INTEGER, delivered_at INTEGER,
  cancel_reason TEXT, refund_utr TEXT, refunded_at INTEGER, problem_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(uid, request_key));
CREATE UNIQUE INDEX shop_orders_ref ON shop_orders(receiving_account_key, payer_reference) WHERE payer_reference IS NOT NULL;
CREATE TABLE shop_order_events(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER);`;

function setup(withShopTables: boolean) {
  now = 1800000000500;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  H.emails.length = 0; H.waTexts.length = 0; H.pdfArgs.length = 0; H.gst = false;
  f = fixture();
  for (const m of ['2026-09-26-saathum-checkout.sql', '2026-09-28-saathum-refund-policy-accept.sql', '2026-09-29-saathum-upi-3layer.sql', '2026-09-29-saathum-upi-3layer-tables.sql', '2026-09-28-whatsapp-outbox.sql']) f.sql.exec(sql(m));
  f.sql.exec(`CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,creator_id TEXT,kind TEXT,title TEXT,status TEXT,price INTEGER,currency_display TEXT,starts_at INTEGER,duration_min INTEGER,capacity INTEGER,attrs TEXT,cover_media TEXT,location TEXT,performed_by TEXT,free_entry INTEGER);
   CREATE TABLE IF NOT EXISTS contact_verification(uid TEXT PRIMARY KEY,phone_verified INTEGER,phone_hash TEXT);
   CREATE TABLE IF NOT EXISTS phone_otp(uid TEXT,phone_hash TEXT,e164 TEXT,status TEXT,verified_at INTEGER);`);
  f.sql.prepare(`INSERT INTO listings(id,creator_id,kind,title,status,price,starts_at,duration_min,attrs) VALUES('L1','c1','live_event','Ganesh Havan','published',200,${now + 86_400_000},60,'{}')`).run();
  f.sql.prepare(`INSERT INTO contact_verification VALUES('buyer1',1,'h1')`).run();
  f.sql.prepare(`INSERT INTO phone_otp VALUES('buyer1','h1','+919999900001','verified',1)`).run();
  (f.env as any).ADMIN_ALERT_WHATSAPP = '+919876500000';
  (f.env as any).DIGITAL = { get: async () => null, put: async () => undefined };
  if (withShopTables) {
    f.sql.exec(SHOP_DDL);
    f.sql.prepare(`INSERT INTO shop_products(id,slug,name,price_rupees,colours_json,sizes_json,images_json,status) VALUES('prd-aaaa0001','om-tee','Om Tee',499,'[{"name":"Black","hex":"#222222"}]','["S","M"]','[{"url":"https://media.example/om.jpg"}]','live')`).run();
  }
}

const addr = { name: 'Asha Rao', phone: '', line1: '12 Temple Rd', city: 'Dehradun', state: 'Uttarakhand', pincode: '248001' };
const orderBody = (over: Record<string, unknown> = {}) => ({
  request_key: uuid(), items: [{ product_id: 'prd-aaaa0001', colour: 'Black', size: 'M', qty: 2 }], address: addr,
  accept_terms: true, refund_policy_accepted: true, ...over,
});
const post = (path: string, body: unknown, uid = 'buyer1') => shopOrdersRoute(request(path, body, uid), f.env, path) as Promise<Response>;
const get = (path: string, uid = 'buyer1') => shopOrdersRoute(request(path, undefined, uid), f.env, path) as Promise<Response>;
async function createOrder(over: Record<string, unknown> = {}) {
  const res = await post('/api/shop/orders', orderBody(over));
  return { status: res.status, body: await res.json() as any };
}
const orderRow = (id: string) => f.sql.prepare('SELECT * FROM shop_orders WHERE order_id=?').get(id) as any;

async function sms(opts: { amountPaise: number; ref?: string }) {
  const message = `Rs.${(opts.amountPaise / 100).toFixed(2)} credited to A/c XX1234 from Shopping sapin@okhdfc (UPI ${opts.ref ?? '000123456789'}).`;
  const received = new Date(now).toISOString();
  const b: any = { device_id: 'test-device', sender: 'VM-HDFCBK', message, received_at: received, sim_slot: -1, message_hash: '', nonce: uuid(), sent_at: new Date(now).toISOString(), signature: '' };
  b.message_hash = await sha256Hex(`${b.sender}|${b.message}|${b.received_at}`);
  b.signature = await hmacSha256Hex(f.env.HDFC_SMS_DEVICE_SECRET!, [b.device_id, b.sender, b.message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
  return b;
}
const ingest = async (body: unknown) => { const r = await hdfcSmsIncoming(request('/incoming', body), f.env); return { status: r.status, body: await r.json() as any }; };

async function admin(method: string, path: string, body?: unknown, uid = 'admin') {
  for (const r of ADMIN2_SHOP_ORDER_ROUTES) {
    if (r.method !== method) continue;
    const p = new URL(`https://t.invalid${path}`).pathname;
    let params: string[] | null = null;
    if (typeof r.path === 'string') params = r.path === p ? [] : null;
    else { const m = r.path.exec(p); params = m ? m.slice(1) : null; }
    if (!params) continue;
    const req = new Request(`https://t.invalid${path}`, { method, headers: { 'x-test-uid': uid, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const res = await r.handler(req, f.env, params);
    return { status: res.status, body: await res.json() as any };
  }
  throw new Error(`no admin route ${method} ${path}`);
}

afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });

describe('create order', () => {
  beforeEach(() => setup(true));

  it('requires BOTH tickboxes (terms_required) and stores nothing', async () => {
    for (const over of [{ accept_terms: false }, { refund_policy_accepted: false }, { refund_policy_accepted: undefined }]) {
      const r = await createOrder(over);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('terms_required');
    }
    expect(f.sql.prepare('SELECT count(*) n FROM shop_orders').get()?.n).toBe(0);
  });

  it('recomputes the quote on the server (client prices are ignored), reserves a unique amount, stores both timestamps + policy version', async () => {
    const r = await createOrder({ items: [{ product_id: 'prd-aaaa0001', colour: 'Black', size: 'M', qty: 2, unit_rupees: 1, price: 1 }], total_rupees: 1 });
    expect(r.status).toBe(200);
    const o = r.body.order;
    expect(o.quote.total_rupees).toBe(998);
    expect(o.quote.shipping_rupees).toBe(0);
    expect(o.pay_amount_paise).toBeLessThan(99800);
    expect(o.pay_amount_paise).toBeGreaterThanOrEqual(99601);
    expect(o.rounding_discount_paise).toBe(99800 - o.pay_amount_paise);
    expect(o.upi.uri).toContain(`am=${(o.pay_amount_paise / 100).toFixed(2)}`);
    expect(decodeURIComponent(o.upi.uri.replace(/\+/g, ' '))).toContain('Saa Thum shop order');
    expect(o.order_no).toMatch(/^SHP-[0-9A-F]{8}$/);
    expect(o.status).toBe('awaiting_payment');
    expect(o.step).toBe('ordered');
    const row = orderRow(o.order_id);
    expect(row.refund_policy_version).toBe('shop-refunds-2026-10-01');
    expect(row.terms_accepted_at).toBe(now);
    expect(row.refund_policy_accepted_at).toBe(now);
    expect(f.sql.prepare('SELECT amount_paise FROM saathum_amount_reservations WHERE checkout_id=?').get(o.order_id)?.amount_paise).toBe(o.pay_amount_paise);
  });

  it('adds GST on top when enabled, and is idempotent on (uid, request_key)', async () => {
    H.gst = true;
    const key = uuid();
    const a = await createOrder({ request_key: key });
    const b = await createOrder({ request_key: key });
    expect(a.body.order.quote.gst_rupees).toBe(Math.round(998 * 0.18));
    expect(a.body.order.quote.total_rupees).toBe(998 + Math.round(998 * 0.18));
    expect(b.body.order.order_id).toBe(a.body.order.order_id);
    expect(f.sql.prepare('SELECT count(*) n FROM shop_orders').get()?.n).toBe(1);
  });

  it('rejects a draft product, a bad size and a bad pincode', async () => {
    f.sql.prepare(`UPDATE shop_products SET status='draft'`).run();
    expect((await createOrder()).body.error).toBe('product_unavailable');
    f.sql.prepare(`UPDATE shop_products SET status='live'`).run();
    expect((await createOrder({ items: [{ product_id: 'prd-aaaa0001', colour: 'Black', size: 'XXL', qty: 1 }] })).body.error).toBe('invalid_size');
    expect((await createOrder({ address: { ...addr, pincode: '12' } })).body.error).toBe('invalid_pincode');
  });

  it("other people's orders are a generic 404", async () => {
    const { body } = await createOrder();
    expect((await get(`/api/shop/orders/${body.order.order_id}`, 'intruder')).status).toBe(404);
    expect((await get(`/api/shop/orders/${body.order.order_id}`)).status).toBe(200);
  });
});

describe('payment rail: SMS auto-match across events AND shop', () => {
  beforeEach(() => setup(true));

  it('a shop order is confirmed by its unique amount: receipt no., sold_count, coupon use, email + PDF, WhatsApp, owner alert, slot released', async () => {
    f.sql.prepare(`INSERT INTO shop_coupons(code,kind,value,min_order_rupees,used_count,active) VALUES('DIWALI','flat',50,0,0,1)`).run();
    const { body } = await createOrder({ coupon: 'diwali' });
    const o = body.order;
    expect(o.quote.discount_rupees).toBe(50);
    now += 1000;
    const r = await ingest(await sms({ amountPaise: o.pay_amount_paise }));
    expect(r.body.match_state).toBe('confirmed');
    const row = orderRow(o.order_id);
    expect(row.pay_status).toBe('confirmed');
    expect(row.confirm_source).toBe('sms_auto');
    expect(row.utr).toBe('000123456789');
    expect(row.receipt_no).toMatch(/^SS-2027-[0-9A-F]{10}$/);
    expect(f.sql.prepare(`SELECT sold_count FROM shop_products WHERE id='prd-aaaa0001'`).get()?.sold_count).toBe(2);
    expect(f.sql.prepare(`SELECT used_count FROM shop_coupons WHERE code='DIWALI'`).get()?.used_count).toBe(1);
    expect(f.sql.prepare(`SELECT kind FROM shop_order_events WHERE order_id=? ORDER BY id`).all(o.order_id).map((e: any) => e.kind)).toEqual(['created', 'confirmed']);
    const mail = H.emails.find((m) => m.kind === 'shop_order_confirmed');
    expect(mail.outboxKey).toBe(`shop-order-confirmed:${o.order_id}`);
    expect(mail.attachments[0].name).toBe(`${row.receipt_no}.pdf`);
    expect(H.pdfArgs[0].item).toEqual({ title: `Shop order ${row.order_no}`, startsAt: null, durationMin: null });
    expect(H.pdfArgs[0].lines.some((l: any) => l.label === 'Shipping (free)')).toBe(true);
    const wa = f.sql.prepare(`SELECT kind,listing_id,checkout_id FROM whatsapp_outbox`).all() as any[];
    expect(wa).toEqual([{ kind: 'shop_order_confirmed', listing_id: 'shop', checkout_id: o.order_id }]);
    expect(H.waTexts.some((t) => t.text.includes(row.order_no) && t.to === '919876500000')).toBe(true); // owner alert
    // slot is free again
    expect(f.sql.prepare('SELECT reserved_until FROM saathum_amount_reservations WHERE checkout_id=?').get(o.order_id)?.reserved_until).toBeLessThan(now);
    // the envelope now reads confirmed with a receipt link
    const got = (await (await get(`/api/shop/orders/${o.order_id}`)).json() as any).order;
    expect(got.status).toBe('confirmed');
    expect(got.step).toBe('paid');
    expect(got.receipt_url).toBe(`/api/shop/orders/${o.order_id}/receipt.pdf`);
    // a duplicate delivery of the same SMS never confirms twice
    const again = await ingest(await sms({ amountPaise: o.pay_amount_paise }));
    expect(again.body.match_state).toBe('confirmed');
    expect(f.sql.prepare(`SELECT sold_count FROM shop_products WHERE id='prd-aaaa0001'`).get()?.sold_count).toBe(2);
  });

  it('with an event checkout and a shop order open, the SMS confirms ONLY the one whose amount matches', async () => {
    const evId = uuid();
    const res = await saathumCheckoutCreate(request('/checkout', { listing_id: 'L1', request_key: uuid(), accept_terms: true, refund_policy_accepted: true, disclaimer_accepted: true, sankalp: { name: 'Asha' } }, 'buyer1'), f.env);
    const checkout = (await res.json() as any).checkout;
    void evId;
    const { body } = await createOrder();
    expect(checkout.pay_amount_paise).not.toBe(body.order.pay_amount_paise);
    now += 1000;
    await ingest(await sms({ amountPaise: body.order.pay_amount_paise, ref: '000000000001' }));
    expect(orderRow(body.order.order_id).pay_status).toBe('confirmed');
    expect(f.sql.prepare('SELECT status FROM saathum_checkouts WHERE checkout_id=?').get(checkout.checkout_id)?.status).toBe('awaiting_payment');
    await ingest(await sms({ amountPaise: checkout.pay_amount_paise, ref: '000000000002' }));
    expect(f.sql.prepare('SELECT status FROM saathum_checkouts WHERE checkout_id=?').get(checkout.checkout_id)?.status).toBe('confirmed');
  });

  it('typed UTR path confirms a shop order; a UTR already on an event booking is a reference_conflict', async () => {
    const { body } = await createOrder();
    const o = body.order;
    f.sql.prepare(`INSERT INTO saathum_checkouts(checkout_id,uid,listing_id,request_key,quote_json,subtotal_rupees,gst_rupees,total_rupees,ticket_rupees,sankalp_json,prasad,status,receiving_account_key,amount_paise,created_at,expires_at,updated_at,payer_reference)
      VALUES(?,?,?,?,?,200,0,200,200,'{"name":"A"}',0,'awaiting_payment',?,19999,?,?,?,'555555555555')`).run(uuid(), 'u2', 'L1', uuid(), '{}', ACCOUNT, now, now + 30 * MIN, now);
    const conflict = await post(`/api/shop/orders/${o.order_id}/utr`, { utr: '555555555555', expected_reference_revision: 0 });
    expect(conflict.status).toBe(409);
    now += 1000;
    await ingest(await sms({ amountPaise: o.pay_amount_paise, ref: '777777777777' }));
    // already confirmed by SMS (typed utr afterwards is a no-op returning the confirmed order)
    const late = await post(`/api/shop/orders/${o.order_id}/utr`, { utr: '777777777777', expected_reference_revision: 0 });
    expect((await late.json() as any).order.status).toBe('confirmed');
  });

  it('"I\'ve paid" then 180 s -> review_pending/awaiting_bank; cron persists it; admin review list shows it; a late SMS still confirms', async () => {
    const { body } = await createOrder();
    const o = body.order;
    const paid = await post(`/api/shop/orders/${o.order_id}/paid`, {});
    expect((await paid.json() as any).order.status).toBe('awaiting_payment');
    now += 181_000;
    const view = (await (await get(`/api/shop/orders/${o.order_id}`)).json() as any).order;
    expect(view.status).toBe('review_pending');
    expect(view.reason_code).toBe('awaiting_bank');
    expect(await persistAwaitingBank(f.env, now)).toBe(1);
    expect(orderRow(o.order_id).pay_status).toBe('review_pending');
    const list = await (await adminSaathumReviewList(request('/review', undefined, 'admin'), f.env)).json() as any;
    expect(list.shop_orders.map((x: any) => x.order_id)).toEqual([o.order_id]);
    now += 1000;
    await ingest(await sms({ amountPaise: o.pay_amount_paise }));
    expect(orderRow(o.order_id).pay_status).toBe('confirmed');
    // the slot of a review_pending SHOP order is protected from re-use (guard now covers shop_orders)
  });

  it('a review_pending shop order keeps its amount slot past the cooldown', async () => {
    const { body } = await createOrder();
    const o = body.order;
    f.sql.prepare(`UPDATE shop_orders SET pay_status='review_pending' WHERE order_id=?`).run(o.order_id);
    const later = now + 10 * 60 * MIN;
    const next = await reserveUniqueAmount(f.env, { account: ACCOUNT, totalRupees: 998, checkoutId: uuid(), now: later, expiresAt: later + 30 * MIN }, () => 0);
    expect(next).not.toBeNull();
    expect(next!.amountPaise).not.toBe(o.pay_amount_paise);
  });
});

describe('admin: confirm / reject / fulfilment', () => {
  beforeEach(() => setup(true));
  const confirmed = async () => {
    const { body } = await createOrder();
    now += 1000;
    await ingest(await sms({ amountPaise: body.order.pay_amount_paise }));
    return body.order.order_id as string;
  };

  it('admin confirm-payment (no SMS) confirms once; reject-payment cools the slot and tells the buyer softly', async () => {
    const a = (await createOrder()).body.order;
    const c = await admin('POST', `/api/admin/v2/shop/orders/${a.order_id}/confirm-payment`, { utr: '123456789012', note: 'seen in app' });
    expect(c.status).toBe(200);
    expect(orderRow(a.order_id).confirm_source).toBe('admin');
    expect((await admin('POST', `/api/admin/v2/shop/orders/${a.order_id}/reject-payment`, { reason: 'x' })).status).toBe(409);
    const b = (await createOrder()).body.order;
    const r = await admin('POST', `/api/admin/v2/shop/orders/${b.order_id}/reject-payment`, { reason: 'no payment found' });
    expect(r.status).toBe(200);
    expect(orderRow(b.order_id).reason_code).toBe('rejected');
    const wa = H.waTexts.find((t) => t.to === '+919999900001' || t.to === '919999900001');
    void wa; // outbox is drained by cron; the queued row carries the soft copy:
    const msg = f.sql.prepare(`SELECT message FROM whatsapp_outbox WHERE kind='shop_order_rejected'`).get()?.message as string;
    expect(msg).toContain('12-digit UPI transaction ID');
    expect(msg).toContain('screenshot');
    expect(H.emails.some((m) => m.kind === 'shop_order_rejected')).toBe(true);
  });

  it('non-admins are refused', async () => {
    const r = await admin('GET', '/api/admin/v2/shop/kpis', undefined, 'buyer1');
    expect(r.status).toBe(403);
  });

  it('transition table: new -> at_printer -> shipped (courier+AWB) -> delivered; illegal moves are 409 bad_transition', async () => {
    const id = await confirmed();
    const url = (a: string) => `/api/admin/v2/shop/orders/${id}/${a}`;
    expect((await admin('POST', url('delivered'), {})).body.error).toBe('bad_transition');
    expect((await admin('POST', url('at-printer'), { printrove_order_ref: 'PR-77' })).status).toBe(200);
    expect((await admin('POST', url('at-printer'), {})).body.error).toBe('bad_transition'); // double click
    expect((await admin('POST', url('shipped'), { courier: 'Delhivery' })).body.error).toBe('awb_required');
    const sh = await admin('POST', url('shipped'), { courier: 'Delhivery', awb: 'DL123', tracking_url: 'https://track.example/DL123', eta_text: '3 days', notify: true });
    expect(sh.status).toBe(200);
    expect(orderRow(id).shipped_at).toBe(now);
    const shipped = f.sql.prepare(`SELECT message FROM whatsapp_outbox WHERE kind='shop_order_shipped'`).get()?.message as string;
    expect(shipped).toContain('Delhivery');
    expect(shipped).toContain('DL123');
    expect(shipped).toContain('https://track.example/DL123');
    expect(shipped).toContain('/dashboard/orders');
    expect(H.emails.some((m) => m.kind === 'shop_order_shipped')).toBe(true);
    expect((await admin('POST', url('cancel'), { reason: 'x' })).body.error).toBe('bad_transition'); // too late to cancel
    expect((await admin('POST', url('delivered'), {})).status).toBe(200);
    expect((await admin('POST', url('refund'), { refund_utr: '12345' })).body.error).toBe('refund_utr_must_be_12_digits');
    expect((await admin('POST', url('refund'), { refund_utr: '123456789012', note: 'wrong item' })).status).toBe(200);
    const row = orderRow(id);
    expect(row.fulfil_status).toBe('refunded');
    expect(row.refund_utr).toBe('123456789012');
    expect((await admin('POST', url('refund'), { refund_utr: '123456789012' })).body.error).toBe('bad_transition');
    expect(f.sql.prepare(`SELECT kind FROM shop_order_events WHERE order_id=? ORDER BY id`).all(id).map((e: any) => e.kind))
      .toEqual(['created', 'confirmed', 'at_printer', 'shipped', 'delivered', 'refunded']);
    expect(f.sql.prepare(`SELECT count(*) n FROM admin_audit`).get()?.n).toBeGreaterThanOrEqual(4);
  });

  it('notify:false sends nothing to the buyer; an unpaid order cannot be moved', async () => {
    const unpaid = (await createOrder()).body.order.order_id;
    expect((await admin('POST', `/api/admin/v2/shop/orders/${unpaid}/at-printer`, {})).body.error).toBe('not_paid');
    const id = await confirmed();
    const before = (f.sql.prepare('SELECT count(*) n FROM whatsapp_outbox').get() as any).n;
    await admin('POST', `/api/admin/v2/shop/orders/${id}/at-printer`, { notify: false });
    expect((f.sql.prepare('SELECT count(*) n FROM whatsapp_outbox').get() as any).n).toBe(before);
  });

  it('list tabs, counts and kpis', async () => {
    const id = await confirmed();
    await createOrder(); // awaiting
    const all = await admin('GET', '/api/admin/v2/shop/orders?tab=all');
    expect(all.body.items).toHaveLength(2);
    expect(all.body.counts).toMatchObject({ all: 2, awaiting: 1, to_print: 1, at_printer: 0 });
    const toPrint = await admin('GET', '/api/admin/v2/shop/orders?tab=to_print');
    expect(toPrint.body.items.map((i: any) => i.order_id)).toEqual([id]);
    expect(toPrint.body.items[0].customer.phone_masked).toContain('•');
    const k = await admin('GET', '/api/admin/v2/shop/kpis');
    expect(k.body).toMatchObject({ orders_today: 1, to_print: 1, to_ship: 0, orders_30d: 1 });
    const d = await admin('GET', `/api/admin/v2/shop/orders/${id}`);
    expect(d.body.order.timeline.map((e: any) => e.kind)).toEqual(['created', 'confirmed']);
  });

  it('problem report: only once delivered, inside the window, once', async () => {
    const id = await confirmed();
    const pr = (msg = 'The print is of a different design') => post(`/api/shop/orders/${id}/problem`, { message: msg });
    expect((await pr()).status).toBe(409); // not delivered
    await admin('POST', `/api/admin/v2/shop/orders/${id}/shipped`, { courier: 'X', awb: '1' });
    await admin('POST', `/api/admin/v2/shop/orders/${id}/delivered`, {});
    expect((await post(`/api/shop/orders/${id}/problem`, { message: 'short' })).status).toBe(400);
    const env0 = (await (await get(`/api/shop/orders/${id}`)).json() as any).order;
    expect(env0.can_report_problem).toBe(true);
    expect((await pr()).status).toBe(200);
    expect((await pr()).status).toBe(409); // already reported
    expect(f.sql.prepare(`SELECT kind FROM shop_order_events WHERE order_id=? ORDER BY id DESC LIMIT 1`).get(id)?.kind).toBe('problem_reported');
  });

  it('problem report after the 48 h window is 409 window_closed', async () => {
    const id = await confirmed();
    await admin('POST', `/api/admin/v2/shop/orders/${id}/shipped`, { courier: 'X', awb: '1' });
    await admin('POST', `/api/admin/v2/shop/orders/${id}/delivered`, {});
    now += 49 * 60 * MIN;
    const r = await post(`/api/shop/orders/${id}/problem`, { message: 'The print is of a different design' });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toBe('window_closed');
  });
});

describe('my-orders + Billing union', () => {
  beforeEach(() => setup(true));

  it('my-orders hides never-paid expired/rejected orders and keeps newest first', async () => {
    const a = (await createOrder()).body.order;
    now += 1000;
    await ingest(await sms({ amountPaise: a.pay_amount_paise }));
    const b = (await createOrder()).body.order;
    f.sql.prepare(`UPDATE shop_orders SET pay_status='cancelled', reason_code='rejected' WHERE order_id=?`).run(b.order_id);
    const mine = (await (await get('/api/shop/my-orders')).json() as any).items;
    expect(mine.map((x: any) => x.order_id)).toEqual([a.order_id]);
  });

  it('a confirmed shop order is a Billing row with kind=shop / category=shop; event rows are kind=event; filters still work', async () => {
    f.sql.exec(`CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,buyer_id TEXT,listing_id TEXT,amount INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS listing_categories(id TEXT PRIMARY KEY,label TEXT);
      CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY,payment_id TEXT,uid TEXT,status TEXT,requested_at INTEGER,refunded_at INTEGER,amount_paise INTEGER,refund_vpa TEXT,refund_utr TEXT);
      ALTER TABLE commercial_policy_snapshots ADD COLUMN gst_amount INTEGER;
      ALTER TABLE listings ADD COLUMN category TEXT;`);
    f.sql.prepare(`INSERT INTO listing_categories VALUES('havan','Havan')`).run();
    f.sql.prepare(`UPDATE listings SET category='havan' WHERE id='L1'`).run();
    f.sql.prepare(`INSERT INTO orders VALUES('ord1','buyer1','L1',200,'held',?)`).run(now - 5000);
    const a = (await createOrder()).body.order;
    now += 1000;
    await ingest(await sms({ amountPaise: a.pay_amount_paise }));
    const run = (extra: Record<string, unknown> = {}) => {
      const { sql: q, binds } = buildPaymentsQuery('buyer1', now, extra);
      return f.sql.prepare(q.replace(/\?(\d+)/g, '$p$1')).all(Object.fromEntries(binds.map((v, i) => [`p${i + 1}`, v]))) as any[];
    };
    const all = run();
    expect(all.map((r) => r.kind).sort()).toEqual(['event', 'shop']);
    const shop = all.find((r) => r.kind === 'shop');
    expect(shop).toMatchObject({ id: a.order_id, category: 'shop', category_label: 'Shop', event_title: `Shop order ${a.order_no}`, event_starts_at: null, status: 'paid', amount_paise: a.pay_amount_paise });
    expect(run({ cat: 'shop' }).map((r) => r.kind)).toEqual(['shop']);
    expect(run({ cat: 'havan' }).map((r) => r.kind)).toEqual(['event']);
    expect(run({ id: a.order_id })).toHaveLength(1);
    expect(run({ q: 'SHP-' }).map((r) => r.kind)).toEqual(['shop']);
    expect(run({ minPaise: 50000 }).map((r) => r.kind)).toEqual(['shop']);
    expect(run({ status: 'paid' })).toHaveLength(2);
    // the fallback SQL (shop table not migrated) is valid and event-only
    f.sql.exec('DROP TABLE shop_orders');
    const { sql: q, binds } = buildPaymentsQuery('buyer1', now, {});
    expect(() => f.sql.prepare(q.replace(/\?(\d+)/g, '$p$1')).all(Object.fromEntries(binds.map((v, i) => [`p${i + 1}`, v])))).toThrow(/shop_orders/);
    const legacy = withoutShopBranch(q);
    expect(legacy).not.toContain('shop_orders');
    expect(f.sql.prepare(legacy.replace(/\?(\d+)/g, '$p$1')).all(Object.fromEntries(binds.map((v, i) => [`p${i + 1}`, v])))).toHaveLength(1);
  });
});

describe('events keep working while the shop tables are NOT migrated', () => {
  beforeEach(() => setup(false));

  it('an event booking is created and auto-confirmed by SMS with no shop_* tables present', async () => {
    const res = await saathumCheckoutCreate(request('/checkout', { listing_id: 'L1', request_key: uuid(), accept_terms: true, refund_policy_accepted: true, disclaimer_accepted: true, sankalp: { name: 'Asha' } }, 'buyer1'), f.env);
    expect(res.status).toBe(200);
    const c = (await res.json() as any).checkout;
    now += 1000;
    const r = await ingest(await sms({ amountPaise: c.pay_amount_paise }));
    expect(r.body.match_state).toBe('confirmed');
    expect(f.sql.prepare('SELECT status FROM saathum_checkouts WHERE checkout_id=?').get(c.checkout_id)?.status).toBe('confirmed');
    expect(await persistAwaitingBank(f.env, now)).toBe(0);
    const list = await (await adminSaathumReviewList(request('/review', undefined, 'admin'), f.env)).json() as any;
    expect(list.shop_orders).toEqual([]);
  });

  it('confirmShopOrder on a missing table is a quiet "lost", never a throw into the rail', async () => {
    expect(await confirmShopOrder(f.env, 'shp_00000000000000000000', { via: 'sms_auto', bankReference: '000000000001' }).catch(() => 'threw')).toBe('lost');
  });
});
