// [SAATHUM-UPI-3LAYER 2026-09-29] Real-SQLite tests (same harness as hdfc_sms_payments.test.ts) for
// the 3-layer UPI confirmation: unique-amount reservation, exactly-one-candidate auto-match,
// multi-device ingest, /paid + review_pending, admin confirm/reject and the cron alerts.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const H = vi.hoisted(() => ({
  provision: 0, emails: [] as any[], waTexts: [] as { to: string; text: string }[], pdfArgs: [] as any[],
}));
vi.mock('../src/routes/config', () => ({
  readConfig: async () => ({ hdfcSmsEnabled: true, saathumGstEnabled: false, gstRatePct: 18, saathumLiveLinkNotifyEnabled: false }),
}));
vi.mock('../src/authz', () => ({
  requireUser: async (req: Request) => req.headers.get('x-test-uid') === 'anonymous' ? { error: 'unauthorized', status: 401 } : { uid: req.headers.get('x-test-uid') ?? 'outsider' },
  isFail: (v: any) => Boolean(v.error),
  requireVerifiedWhatsApp: async () => null,
}));
vi.mock('../src/routes/commercial_checkout', () => ({
  quoteCommercialPurchase: () => ({ pricing: { buyerTotal: 1 } }),
  freezeCommercialPurchaseQuote: async () => undefined,
  provisionFromGatewayPurchase: async () => { H.provision++; return { ok: true, status: 200 }; },
}));
vi.mock('../src/lib/identity', () => ({ emailFor: async () => 'buyer@example.in' }));
vi.mock('../src/lib/email_outbox', () => ({ enqueueEmail: async (_e: any, m: any) => { H.emails.push(m); return { status: 'queued' }; } }));
vi.mock('../src/lib/me_receipt_pdf', () => ({ renderSaathumReceiptPdf: async (a: any) => { H.pdfArgs.push(a); return new Uint8Array([1, 2, 3]); } }));
vi.mock('../src/lib/saathum_stream_state', () => ({
  streamStateForListing: async () => ({ state: 'none', video: null }),
  computeStreamState: () => 'none',
}));
vi.mock('../src/lib/listing_schedule', () => ({ bookability: () => ({ ok: true }) }));
vi.mock('../src/lib/whatsapp_send', () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { H.waTexts.push({ to, text }); return { ok: true }; } }));
vi.mock('../src/hooks', async (orig) => ({ ...(await orig<any>()), track: async () => undefined, trackException: async () => undefined }));

import { fixture, request } from './hdfc_test_db';
import { hdfcSmsIncoming, hdfcSmsHeartbeat } from '../src/routes/hdfc_sms_payments';
import { saathumCheckoutCreate, saathumCheckoutGet, saathumCheckoutPaid } from '../src/routes/saathum_checkout';
import { adminSaathumReviewList, adminSaathumCheckoutConfirm, adminSaathumCheckoutReject } from '../src/routes/saathum_payment_review';
import { reserveUniqueAmount, checkSourceHealth, alertStaleReviews, persistAwaitingBank, runSaathumPaymentSweeps } from '../src/lib/saathum_upi3';
import { receiptAmounts, externalStatus, externalReason, type Quote } from '../src/lib/saathum_checkout_logic';
import { hmacSha256Hex, sha256Hex } from '../src/lib/payments/types';

const sql = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
const ACCOUNT = createHash('sha256').update('HDFC|1234|INR').digest('hex');
const WATCHER_SECRET = 'watcher-secret-synthetic-only';
const MIN = 60_000;
let f: ReturnType<typeof fixture>;
let now: number;
const uuid = () => crypto.randomUUID();

beforeEach(() => {
  now = 1800000000500;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  H.provision = 0; H.emails.length = 0; H.waTexts.length = 0; H.pdfArgs.length = 0;
  f = fixture();
  f.sql.exec(sql('2026-09-26-saathum-checkout.sql'));
  f.sql.exec(sql('2026-09-28-saathum-refund-policy-accept.sql'));
  f.sql.exec(sql('2026-09-29-saathum-upi-3layer.sql'));
  f.sql.exec(sql('2026-09-29-saathum-upi-3layer-tables.sql'));
  f.sql.exec(sql('2026-09-28-whatsapp-outbox.sql'));
  f.sql.exec(`CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,creator_id TEXT,kind TEXT,title TEXT,status TEXT,price INTEGER,currency_display TEXT,starts_at INTEGER,duration_min INTEGER,capacity INTEGER,attrs TEXT,cover_media TEXT,location TEXT,performed_by TEXT,free_entry INTEGER);
   CREATE TABLE IF NOT EXISTS contact_verification(uid TEXT PRIMARY KEY,phone_verified INTEGER,phone_hash TEXT);
   CREATE TABLE IF NOT EXISTS phone_otp(uid TEXT,phone_hash TEXT,e164 TEXT,status TEXT,verified_at INTEGER);`);
  f.sql.prepare(`INSERT INTO listings(id,creator_id,kind,title,status,price,starts_at,duration_min,attrs) VALUES('L1','c1','live_event','Ganesh Havan','published',200,${now + 86_400_000},60,'{}')`).run();
  f.sql.prepare(`INSERT INTO contact_verification VALUES('buyer1',1,'h1')`).run();
  f.sql.prepare(`INSERT INTO phone_otp VALUES('buyer1','h1','+919999900001','verified',1)`).run();
  (f.env as any).HDFC_SMS_WATCHER_DEVICE_ID = 'watcher-1';
  (f.env as any).HDFC_SMS_WATCHER_DEVICE_SECRET = WATCHER_SECRET;
  (f.env as any).ADMIN_ALERT_WHATSAPP = '+919876500000';
});
afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });

const quoteJson = JSON.stringify({ lines: [{ kind: 'ticket', label: 'Havan ticket', qty: 1, unit_rupees: 200, amount_rupees: 200 }], subtotal_rupees: 200, gst_rate_pct: 0, gst_rupees: 0, total_rupees: 200 });
function insertCheckout(o: { id?: string; uid?: string; amount_paise: number; status?: string; created_at?: number; expires_at?: number; paid_claimed_at?: number | null; reason_code?: string | null; confirmed_at?: number | null; payer_reference?: string | null; total_rupees?: number }) {
  const id = o.id ?? uuid();
  const created = o.created_at ?? now - 5 * MIN;
  f.sql.prepare(`INSERT INTO saathum_checkouts(checkout_id,uid,listing_id,request_key,quote_json,subtotal_rupees,gst_rupees,total_rupees,ticket_rupees,sankalp_json,prasad,status,receiving_account_key,amount_paise,created_at,expires_at,updated_at,paid_claimed_at,reason_code,confirmed_at,payer_reference,rounding_discount_paise)
    VALUES(?,?,?,?,?,200,0,?,200,'{"name":"Asha"}',0,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, o.uid ?? 'buyer1', 'L1', uuid(), quoteJson, o.total_rupees ?? 200, o.status ?? 'awaiting_payment', ACCOUNT, o.amount_paise,
    created, o.expires_at ?? created + 30 * MIN, created, o.paid_claimed_at ?? null, o.reason_code ?? null, o.confirmed_at ?? null, o.payer_reference ?? null,
    (o.total_rupees ?? 200) * 100 - o.amount_paise);
  return id;
}
const row = (id: string) => f.sql.prepare('SELECT * FROM saathum_checkouts WHERE checkout_id=?').get(id) as any;

async function sms(opts: { amount?: string; ref?: string; device?: string; secret?: string; received?: string; nonce?: string } = {}) {
  const device = opts.device ?? 'test-device';
  const secret = opts.secret ?? (device === 'watcher-1' ? WATCHER_SECRET : f.env.HDFC_SMS_DEVICE_SECRET!);
  const received = opts.received ?? new Date(now).toISOString();
  const message = `Rs.${opts.amount ?? '199.99'} credited to A/c XX1234 from Shopping sapin@okhdfc (UPI ${opts.ref ?? '000123456789'}).`;
  const b: any = { device_id: device, sender: 'VM-HDFCBK', message, received_at: received, sim_slot: -1, message_hash: '', nonce: opts.nonce ?? uuid(), sent_at: new Date(now).toISOString(), signature: '' };
  b.message_hash = await sha256Hex(`${b.sender}|${b.message}|${b.received_at}`);
  b.signature = await hmacSha256Hex(secret, [b.device_id, b.sender, b.message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
  return b;
}
const ingest = async (body: unknown) => { const r = await hdfcSmsIncoming(request('/incoming', body), f.env); return { status: r.status, body: await r.json() as any }; };
async function heartbeat(device: string, secret: string) {
  const nonce = uuid(), sent = new Date(now).toISOString();
  const signature = await hmacSha256Hex(secret, `${device}\n${nonce}\n${sent}`);
  const r = await hdfcSmsHeartbeat(request('/heartbeat', { device_id: device, nonce, sent_at: sent, signature }), f.env);
  return r.status;
}

describe('unique amount reservation', () => {
  const reserve = (id: string, total = 200, rand = () => 0, at = now, account = ACCOUNT) =>
    reserveUniqueAmount(f.env, { account, totalRupees: total, checkoutId: id, now: at, expiresAt: at + 30 * MIN }, rand);

  it('hands out distinct amounts in total*100-k, k 1..199, and is independent per account', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const r = await reserve(uuid(), 200, Math.random);
      expect(r).not.toBeNull();
      expect(r!.amountPaise).toBe(20000 - r!.roundingDiscountPaise);
      expect(r!.roundingDiscountPaise).toBeGreaterThanOrEqual(1);
      expect(r!.roundingDiscountPaise).toBeLessThanOrEqual(199);
      seen.add(r!.amountPaise);
    }
    expect(seen.size).toBe(60);
    const other = await reserve(uuid(), 200, () => 0, now, 'other-account');
    expect(other!.amountPaise).toBe(19999); // slot 19999 is free on another account
  });

  it('returns null (-> 503 amount_pool_exhausted) when all 199 slots are held', async () => {
    for (let i = 0; i < 199; i++) expect(await reserve(uuid(), 200, () => 0)).not.toBeNull();
    expect(await reserve(uuid(), 200, () => 0)).toBeNull();
  });

  it('create endpoint answers 503 amount_pool_exhausted and stores nothing', async () => {
    for (let i = 0; i < 199; i++) await reserve(uuid(), 200, () => 0);
    const body = { listing_id: 'L1', request_key: uuid(), accept_terms: true, refund_policy_accepted: true, sankalp: { name: 'Asha' } };
    const res = await saathumCheckoutCreate(request('/checkout', body, 'buyer1'), f.env);
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toBe('amount_pool_exhausted');
    expect(f.sql.prepare('SELECT count(*) n FROM saathum_checkouts').get()?.n).toBe(0);
  });

  it('create endpoint stores the unique payable amount and the rounding discount', async () => {
    const body = { listing_id: 'L1', request_key: uuid(), accept_terms: true, refund_policy_accepted: true, sankalp: { name: 'Asha' } };
    const res = await saathumCheckoutCreate(request('/checkout', body, 'buyer1'), f.env);
    expect(res.status).toBe(200);
    const { checkout } = await res.json() as any;
    expect(checkout.pay_amount_paise).toBeLessThan(20000);
    expect(checkout.pay_amount_paise).toBeGreaterThanOrEqual(19801);
    expect(checkout.rounding_discount_paise).toBe(20000 - checkout.pay_amount_paise);
    expect(checkout.payment.amount_paise).toBe(checkout.pay_amount_paise);
    expect(checkout.upi.uri).toContain(`am=${(checkout.pay_amount_paise / 100).toFixed(2)}`);
    expect(checkout.status).toBe('awaiting_payment');
    // idempotent replay keeps the same amount
    const again = await saathumCheckoutCreate(request('/checkout', body, 'buyer1'), f.env);
    expect((await again.json() as any).checkout.pay_amount_paise).toBe(checkout.pay_amount_paise);
  });

  it('2 h cooldown after expiry; a review_pending holder keeps its slot past the cooldown', async () => {
    const a = uuid();
    insertCheckout({ id: a, amount_paise: 19999, status: 'expired' });
    const first = await reserve(a, 200, () => 0);
    expect(first!.amountPaise).toBe(19999);
    // 1 h after the window closed: still cooling down -> next holder gets a different amount
    const t1 = now + 31 * MIN + 60 * MIN;
    expect((await reserve(uuid(), 200, () => 0, t1))!.amountPaise).toBe(19998);
    // 3 h later the slot is free again ...
    const t2 = now + 30 * MIN + 3 * 60 * MIN;
    expect((await reserve(uuid(), 200, () => 0, t2))!.amountPaise).toBe(19999);
    // ... unless its holder is sitting in the review queue
    const b = uuid();
    insertCheckout({ id: b, amount_paise: 19997, status: 'review_pending' });
    f.sql.prepare(`INSERT INTO saathum_amount_reservations VALUES(?,?,?,?,?)`).run(ACCOUNT, 19997, b, now, now - 10 * MIN);
    const t3 = now + 10 * 60 * MIN;
    const got = await reserve(uuid(), 200, () => 0, t3);
    expect(got!.amountPaise).not.toBe(19997);
  });
});

describe('auto-match (no UTR)', () => {
  it('exactly one candidate -> confirms, stores the SMS reference, sends email + WhatsApp, releases the slot', async () => {
    const id = insertCheckout({ amount_paise: 19999 });
    f.sql.prepare(`INSERT INTO saathum_amount_reservations VALUES(?,?,?,?,?)`).run(ACCOUNT, 19999, id, now + 3 * 3600_000, now);
    const r = await ingest(await sms({ amount: '199.99' }));
    expect(r.status).toBe(200);
    expect(r.body.match_state).toBe('confirmed');
    const c = row(id);
    expect(c.status).toBe('confirmed');
    expect(c.utr).toBe('000123456789');
    expect(c.payer_reference).toBe('000123456789');
    expect(c.confirm_source).toBe('sms_auto');
    expect(c.matched_message_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(H.provision).toBe(1);
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_confirmation')).toHaveLength(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM whatsapp_outbox WHERE checkout_id=? AND kind='booking_confirmed'`).get(id)?.n).toBe(1);
    // receipt is on the amount collected, with a rounding-discount line
    const pdf = H.pdfArgs[H.pdfArgs.length - 1];
    expect(pdf.totalRupees).toBe(199.99);
    expect(pdf.lines.some((l: any) => l.label === 'UPI rounding discount' && l.amount_rupees === -0.01)).toBe(true);
    expect(f.sql.prepare('SELECT reserved_until FROM saathum_amount_reservations WHERE checkout_id=?').get(id)?.reserved_until).toBeLessThan(now);
  });

  it('zero candidates -> stays unmatched and nothing confirms', async () => {
    const id = insertCheckout({ amount_paise: 19999 });
    const r = await ingest(await sms({ amount: '199.98' }));
    expect(r.body.match_state).toBe('unmatched');
    expect(row(id).status).toBe('awaiting_payment');
    expect(H.provision).toBe(0);
  });

  it('two candidates with the same amount -> ambiguous, neither confirms', async () => {
    const a = insertCheckout({ amount_paise: 19999 }), b = insertCheckout({ amount_paise: 19999 });
    const r = await ingest(await sms({ amount: '199.99' }));
    expect(r.body.match_state).not.toBe('confirmed');
    expect(row(a).status).toBe('awaiting_payment');
    expect(row(b).status).toBe('awaiting_payment');
    expect(H.provision).toBe(0);
  });

  it('a checkout created AFTER the SMS is never a candidate', async () => {
    const id = insertCheckout({ amount_paise: 19999, created_at: now + 5 * MIN });
    await ingest(await sms({ amount: '199.99' }));
    expect(row(id).status).toBe('awaiting_payment');
  });

  it('late SMS after review_pending (3-minute rule) still auto-confirms and notifies', async () => {
    const id = insertCheckout({ amount_paise: 19998, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    const r = await ingest(await sms({ amount: '199.98', ref: '000555666777' }));
    expect(r.body.match_state).toBe('confirmed');
    expect(row(id).status).toBe('confirmed');
    expect(row(id).reason_code).toBeNull();
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_confirmation')).toHaveLength(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM whatsapp_outbox WHERE checkout_id=?`).get(id)?.n).toBe(1);
  });

  it('typed UTR stays a working optional path', async () => {
    const id = insertCheckout({ amount_paise: 19996, payer_reference: '000999888777' });
    await ingest(await sms({ amount: '199.96', ref: '000999888777' }));
    expect(row(id).status).toBe('confirmed');
    expect(row(id).confirm_source).toBe('utr');
  });

  it('same SMS from both devices confirms once and never double-confirms the bank reference', async () => {
    const a = insertCheckout({ amount_paise: 19999 });
    const b = insertCheckout({ amount_paise: 19999 }); // would be a 2nd candidate
    f.sql.prepare('DELETE FROM saathum_checkouts WHERE checkout_id=?').run(b); // start with one candidate
    const fromCompanion = await sms({ device: 'test-device' });
    const fromWatcher = await sms({ device: 'watcher-1' });
    expect((await ingest(fromCompanion)).body.match_state).toBe('confirmed');
    // a second, still-open checkout with the same amount appears; the duplicate delivery must not touch it
    const c = insertCheckout({ amount_paise: 19999, created_at: now - 4 * MIN });
    const second = await ingest(fromWatcher);
    expect(second.status).toBe(200);
    expect(second.body.match_state).toBe('confirmed'); // already confirmed by the first delivery
    expect(row(a).status).toBe('confirmed');
    expect(row(c).status).toBe('awaiting_payment');
    expect(H.provision).toBe(1);
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_confirmation')).toHaveLength(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM whatsapp_outbox WHERE kind='booking_confirmed'`).get()?.n).toBe(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM saathum_checkouts WHERE payer_reference='000123456789'`).get()?.n).toBe(1);
  });
});

describe('multi-device ingest', () => {
  it('accepts the watcher device signature on /api/sms/incoming and /api/sms/heartbeat', async () => {
    expect((await ingest(await sms({ device: 'watcher-1', amount: '5.00' }))).status).toBe(200);
    expect(await heartbeat('watcher-1', WATCHER_SECRET)).toBe(200);
    expect(await heartbeat('test-device', f.env.HDFC_SMS_DEVICE_SECRET!)).toBe(200);
    const rows = f.sql.prepare('SELECT device_id,source,last_heartbeat_at,last_sms_at FROM sms_source_health ORDER BY device_id').all() as any[];
    expect(rows.map((r) => [r.device_id, r.source])).toEqual([['test-device', 'companion'], ['watcher-1', 'watcher']]);
    expect(rows.every((r) => r.last_heartbeat_at === now)).toBe(true);
    expect(rows.find((r) => r.device_id === 'watcher-1').last_sms_at).toBe(now);
  });

  it('rejects a wrong watcher secret, the companion secret on the watcher id, and unknown devices', async () => {
    expect((await ingest(await sms({ device: 'watcher-1', secret: 'wrong-secret' }))).status).toBe(401);
    expect((await ingest(await sms({ device: 'watcher-1', secret: f.env.HDFC_SMS_DEVICE_SECRET! }))).status).toBe(401);
    expect((await ingest(await sms({ device: 'nobody', secret: WATCHER_SECRET }))).status).toBe(401);
    expect(await heartbeat('watcher-1', 'wrong-secret')).toBe(401);
    expect(await heartbeat('nobody', WATCHER_SECRET)).toBe(401);
    expect(f.sql.prepare('SELECT count(*) n FROM sms_source_health').get()?.n).toBe(0);
  });

  it('with the watcher env unset, the watcher id is unknown (companion keeps working)', async () => {
    delete (f.env as any).HDFC_SMS_WATCHER_DEVICE_ID; delete (f.env as any).HDFC_SMS_WATCHER_DEVICE_SECRET;
    expect((await ingest(await sms({ device: 'watcher-1' }))).status).toBe(401);
    expect((await ingest(await sms({ device: 'test-device', amount: '5.00' }))).status).toBe(200);
  });
});

describe("/paid, review_pending and the 180 s rule", () => {
  it('stamps paid_claimed_at once; after 180 s reads as review_pending/awaiting_bank; cron persists it', async () => {
    const id = insertCheckout({ amount_paise: 19999, created_at: now, expires_at: now + 30 * MIN });
    const r1 = await saathumCheckoutPaid(request(`/paid`, {}, 'buyer1'), f.env, id);
    const c1 = (await r1.json() as any).checkout;
    expect(c1.status).toBe('awaiting_payment');
    expect(c1.paid_claimed_at).toBe(now);
    now += 100_000;
    await saathumCheckoutPaid(request(`/paid`, {}, 'buyer1'), f.env, id); // idempotent: keeps the first stamp
    expect(row(id).paid_claimed_at).toBe(now - 100_000);
    now += 81_000; // 181 s after the tap
    const g = (await (await saathumCheckoutGet(request(`/x`, undefined, 'buyer1'), f.env, id)).json() as any).checkout;
    expect(g.status).toBe('review_pending');
    expect(g.reason_code).toBe('awaiting_bank');
    expect(g.pay_amount_paise).toBe(19999);
    expect(row(id).status).toBe('awaiting_payment'); // computed on read only
    expect(await persistAwaitingBank(f.env, now)).toBe(1);
    expect(row(id).status).toBe('review_pending');
    expect(row(id).reason_code).toBe('awaiting_bank');
  });

  it("a stranger's checkout is a 404, and a polled GET auto-confirms from already-stored SMS evidence", async () => {
    const id = insertCheckout({ amount_paise: 19999 });
    expect((await saathumCheckoutPaid(request('/paid', {}, 'someone-else'), f.env, id)).status).toBe(404);
    // evidence stored while the checkout was not yet a candidate for this poll (e.g. ingest hook failed)
    await ingest(await sms({ amount: '199.99' }));
    f.sql.prepare(`UPDATE saathum_checkouts SET status='awaiting_payment',confirmed_at=NULL,payer_reference=NULL,matched_message_hash=NULL WHERE checkout_id=?`).run(id);
    const g = (await (await saathumCheckoutGet(request('/x', undefined, 'buyer1'), f.env, id)).json() as any).checkout;
    expect(g.status).toBe('confirmed');
  });

  it('pure status rules', () => {
    const base = { expires_at: now + MIN, reason_code: null };
    expect(externalStatus({ ...base, status: 'awaiting_payment', paid_claimed_at: now - 179_000 }, now)).toBe('awaiting_payment');
    expect(externalStatus({ ...base, status: 'awaiting_payment', paid_claimed_at: now - 181_000 }, now)).toBe('review_pending');
    expect(externalStatus({ status: 'awaiting_payment', expires_at: now - 1 }, now)).toBe('expired');
    expect(externalReason({ ...base, status: 'awaiting_payment', paid_claimed_at: now - 181_000 }, now)).toBe('awaiting_bank');
  });
});

describe('receipt / GST on the collected amount', () => {
  const q = (gst: number, subtotal: number): Quote => ({ lines: [{ kind: 'ticket', label: 'Havan ticket', qty: 1, unit_rupees: subtotal, amount_rupees: subtotal }], subtotal_rupees: subtotal, gst_rate_pct: gst ? 18 : 0, gst_rupees: gst, total_rupees: subtotal + gst });
  it('no discount -> identical to the quote', () => {
    const a = receiptAmounts(q(0, 200), 20000);
    expect(a.totalRupees).toBe(200); expect(a.lines).toHaveLength(1);
  });
  it('with GST, subtotal + GST equals exactly what the bank received', () => {
    const quote = q(36, 200); // total 236
    const a = receiptAmounts(quote, 23600 - 137);
    expect(a.discountPaise).toBe(137);
    expect(Math.round((a.subtotalRupees + a.gstRupees) * 100)).toBe(23600 - 137);
    expect(Math.round(a.totalRupees * 100)).toBe(23600 - 137);
    expect(a.lines[a.lines.length - 1].label).toBe('UPI rounding discount');
    expect(a.lines[a.lines.length - 1].amount_rupees).toBeLessThan(0);
  });
});

describe('admin confirm / reject (layer 3)', () => {
  const post = (path: string, body: unknown, uid = 'admin') => request(path, body, uid);

  it('is admin-only', async () => {
    const id = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    expect((await adminSaathumReviewList(request('/r', undefined, 'buyer1'), f.env)).status).toBe(403);
    expect((await adminSaathumCheckoutConfirm(post('/c', {}, 'buyer1'), f.env, id)).status).toBe(403);
    expect((await adminSaathumCheckoutReject(post('/c', { reason: 'x' }, 'buyer1'), f.env, id)).status).toBe(403);
    expect((await adminSaathumReviewList(request('/r', undefined, 'anonymous'), f.env)).status).toBe(401);
  });

  it('lists review items, unmatched SMS and source health per the contract', async () => {
    const id = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    await ingest(await sms({ amount: '150.00', ref: '000111222333', device: 'watcher-1' })); // matches nothing
    await heartbeat('watcher-1', WATCHER_SECRET);
    const res = await adminSaathumReviewList(request('/r', undefined, 'admin'), f.env);
    const b = await res.json() as any;
    expect(b.checkouts).toHaveLength(1);
    expect(b.checkouts[0]).toMatchObject({ checkout_id: id, uid: 'buyer1', buyer_name: 'Asha', whatsapp: '+919999900001', email: 'buyer@example.in', listing_title: 'Ganesh Havan', pay_amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank' });
    expect(b.unmatched_sms).toHaveLength(1);
    expect(b.unmatched_sms[0]).toMatchObject({ amount_paise: 15000, bank_reference: '000111222333', source_device: 'watcher-1' });
    expect(typeof b.unmatched_sms[0].message_hash).toBe('string');
    expect(b.sources).toEqual([expect.objectContaining({ device_id: 'watcher-1', source: 'watcher', healthy: true })]);
  });

  it('confirm links an SMS, logs the admin uid, sends the same notifications as auto-confirm, and is idempotent', async () => {
    const id = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    // an SMS with the right amount that the matcher skipped (two candidates at the time)
    const dup = insertCheckout({ amount_paise: 19999 });
    const s = await sms({ amount: '199.99' });
    await ingest(s);
    expect(row(id).status).toBe('review_pending');
    const wrong = await adminSaathumCheckoutConfirm(post('/c', { message_hash: 'f'.repeat(64) }), f.env, id);
    expect(wrong.status).toBe(404);
    const res = await adminSaathumCheckoutConfirm(post('/c', { message_hash: s.message_hash, note: 'saw it in the bank app' }), f.env, id);
    expect(res.status).toBe(200);
    const c = row(id);
    expect(c.status).toBe('confirmed');
    expect(c.reviewed_by).toBe('admin');
    expect(c.review_note).toBe('saw it in the bank app');
    expect(c.confirm_source).toBe('admin');
    expect(c.utr).toBe('000123456789');
    expect(H.provision).toBe(1);
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_confirmation')).toHaveLength(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM whatsapp_outbox WHERE checkout_id=? AND kind='booking_confirmed'`).get(id)?.n).toBe(1);
    // the same bank reference can no longer confirm the other checkout
    const again = await adminSaathumCheckoutConfirm(post('/c', { message_hash: s.message_hash }), f.env, dup);
    expect(again.status).toBe(409);
    expect(row(dup).status).toBe('awaiting_payment');
    // idempotent second confirm
    const twice = await adminSaathumCheckoutConfirm(post('/c', {}), f.env, id);
    expect((await twice.json() as any).already_confirmed).toBe(true);
    expect(H.provision).toBe(1);
  });

  it('confirm without an SMS works, but an SMS with a different amount is refused', async () => {
    const id = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    const s = await sms({ amount: '150.00', ref: '000777888999' });
    await ingest(s);
    expect((await adminSaathumCheckoutConfirm(post('/c', { message_hash: s.message_hash }), f.env, id)).status).toBe(409);
    expect((await adminSaathumCheckoutConfirm(post('/c', { note: 'paid in cash at the temple' }), f.env, id)).status).toBe(200);
    expect(row(id).status).toBe('confirmed');
    expect(row(id).utr).toBeNull();
    expect(row(id).reviewed_by).toBe('admin');
  });

  it('reject cancels with a reason, cools the amount down, notifies the buyer and cannot hit a confirmed checkout', async () => {
    const id = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    f.sql.prepare(`INSERT INTO saathum_amount_reservations VALUES(?,?,?,?,?)`).run(ACCOUNT, 19999, id, now, now - 20 * MIN);
    expect((await adminSaathumCheckoutReject(post('/r', {}), f.env, id)).status).toBe(400);
    const res = await adminSaathumCheckoutReject(post('/r', { reason: 'no matching credit in the bank statement' }), f.env, id);
    expect(res.status).toBe(200);
    const c = row(id);
    expect(c.status).toBe('cancelled');
    expect(c.reason_code).toBe('rejected');
    expect(c.review_note).toBe('no matching credit in the bank statement');
    expect(c.reviewed_by).toBe('admin');
    expect(f.sql.prepare('SELECT reserved_until FROM saathum_amount_reservations WHERE checkout_id=?').get(id)?.reserved_until).toBeGreaterThan(now + 100 * MIN); // 2 h cooldown
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_rejected')).toHaveLength(1);
    expect(f.sql.prepare(`SELECT count(*) n FROM whatsapp_outbox WHERE checkout_id=? AND kind='booking_rejected'`).get(id)?.n).toBe(1);
    expect(H.provision).toBe(0);
    // a late SMS must not resurrect a rejected checkout
    await ingest(await sms({ amount: '199.99' }));
    expect(row(id).status).toBe('cancelled');
    // cannot reject a confirmed one
    const ok = insertCheckout({ amount_paise: 19998, status: 'confirmed', confirmed_at: now });
    expect((await adminSaathumCheckoutReject(post('/r', { reason: 'x' }), f.env, ok)).status).toBe(409);
    expect((await adminSaathumCheckoutConfirm(post('/c', {}), f.env, id)).status).toBe(409);
  });
});

describe('cron alerts', () => {
  it('stale source: one alert after 15 min, hourly re-alert only, then one "recovered"', async () => {
    await heartbeat('watcher-1', WATCHER_SECRET);
    await heartbeat('test-device', f.env.HDFC_SMS_DEVICE_SECRET!);
    now += 10 * MIN;
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 0, recovered: 0 });
    now += 6 * MIN; // 16 min silent
    await heartbeat('test-device', f.env.HDFC_SMS_DEVICE_SECRET!); // companion is fine
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 1, recovered: 0 });
    expect(H.waTexts).toHaveLength(1);
    expect(H.waTexts[0].to).toBe('919876500000');
    expect(H.waTexts[0].text).toContain('Google Messages watcher');
    now += 5 * MIN; await heartbeat('test-device', f.env.HDFC_SMS_DEVICE_SECRET!);
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 0, recovered: 0 }); // no spam inside the hour
    now += 56 * MIN; await heartbeat('test-device', f.env.HDFC_SMS_DEVICE_SECRET!);
    expect((await checkSourceHealth(f.env, now)).stale).toBe(1); // hourly re-alert
    expect(H.waTexts).toHaveLength(2);
    await heartbeat('watcher-1', WATCHER_SECRET);
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 0, recovered: 1 });
    expect(H.waTexts[2].text).toContain('back online');
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 0, recovered: 0 });
  });

  it('no alert number configured -> nothing is sent and nothing is marked alerted', async () => {
    delete (f.env as any).ADMIN_ALERT_WHATSAPP;
    await heartbeat('watcher-1', WATCHER_SECRET);
    now += 20 * MIN;
    expect(await checkSourceHealth(f.env, now)).toEqual({ stale: 0, recovered: 0 });
    expect(H.waTexts).toHaveLength(0);
    expect(f.sql.prepare('SELECT stale_alert_open FROM sms_source_health WHERE device_id=?').get('watcher-1')?.stale_alert_open).toBe(0);
  });

  it('review_pending older than 10 min alerts the admin exactly once per item', async () => {
    const fresh = insertCheckout({ amount_paise: 19999, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 5 * MIN });
    const old = insertCheckout({ amount_paise: 19998, status: 'review_pending', reason_code: 'awaiting_bank', paid_claimed_at: now - 20 * MIN });
    expect(await alertStaleReviews(f.env, now)).toBe(1);
    expect(H.waTexts).toHaveLength(1);
    expect(H.waTexts[0].text).toContain(old.slice(0, 8));
    expect(await alertStaleReviews(f.env, now)).toBe(0);
    now += 10 * MIN;
    expect(await alertStaleReviews(f.env, now)).toBe(1); // the fresh one has now aged past 10 min
    expect(row(fresh).review_alerted_at).toBe(now);
    const sweep = await runSaathumPaymentSweeps(f.env, now);
    expect(sweep.review_alerts).toBe(0);
  });
});
