// [SAATHUM-UPI-3LAYER 2026-09-29] Real-SQLite tests for the third-party SMS-forwarder webhook
// (layer 2): lenient formats, strict content, token auth, dedupe with the watcher, corroboration
// flag, capture mode and the silence alert. Same harness as saathum_upi3.test.ts.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const H = vi.hoisted(() => ({
  provision: 0, emails: [] as any[], waTexts: [] as { to: string; text: string }[],
  cfg: {} as Record<string, unknown>,
}));
vi.mock('../src/routes/config', () => ({ readConfig: async () => H.cfg }));
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
vi.mock('../src/lib/me_receipt_pdf', () => ({ renderSaathumReceiptPdf: async () => new Uint8Array([1, 2, 3]) }));
vi.mock('../src/lib/saathum_stream_state', () => ({
  streamStateForListing: async () => ({ state: 'none', video: null }),
  computeStreamState: () => 'none',
}));
vi.mock('../src/lib/listing_schedule', () => ({ bookability: () => ({ ok: true }) }));
vi.mock('../src/lib/whatsapp_send', () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { H.waTexts.push({ to, text }); return { ok: true }; } }));
vi.mock('../src/hooks', async (orig) => ({ ...(await orig<any>()), track: async () => undefined, trackException: async () => undefined }));

import { fixture, request } from './hdfc_test_db';
import { hdfcSmsIncoming } from '../src/routes/hdfc_sms_payments';
import { smsForwarderIncoming, adminForwarderCaptures, senderRule } from '../src/routes/sms_forwarder';
import { adminSaathumReviewList } from '../src/routes/saathum_payment_review';
import { checkSourceHealth, checkForwarderSilence, runSaathumPaymentSweeps } from '../src/lib/saathum_upi3';
import { hmacSha256Hex, sha256Hex } from '../src/lib/payments/types';

const sql = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
const ACCOUNT = createHash('sha256').update('HDFC|1234|INR').digest('hex');
const TOKEN = 'forwarder-token-synthetic-0123456789abcdef';
const WATCHER_SECRET = 'watcher-secret-synthetic-only';
const MIN = 60_000;
let f: ReturnType<typeof fixture>;
let now: number;
const uuid = () => crypto.randomUUID();

beforeEach(() => {
  now = 1800000000500;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  H.provision = 0; H.emails.length = 0; H.waTexts.length = 0;
  H.cfg = { hdfcSmsEnabled: true, saathumGstEnabled: false, gstRatePct: 18, saathumLiveLinkNotifyEnabled: false, saathumSmsIngestEnabled: true, smsForwarderEnabled: true, smsForwarderCaptureEnabled: false };
  f = fixture();
  for (const m of ['2026-09-26-saathum-checkout.sql', '2026-09-28-saathum-refund-policy-accept.sql', '2026-09-29-saathum-upi-3layer.sql', '2026-09-29-saathum-upi-3layer-tables.sql', '2026-09-29-sms-forwarder.sql', '2026-09-28-whatsapp-outbox.sql']) f.sql.exec(sql(m));
  f.sql.exec(`CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,creator_id TEXT,kind TEXT,title TEXT,status TEXT,price INTEGER,currency_display TEXT,starts_at INTEGER,duration_min INTEGER,capacity INTEGER,attrs TEXT,cover_media TEXT,location TEXT,performed_by TEXT,free_entry INTEGER);
   CREATE TABLE IF NOT EXISTS contact_verification(uid TEXT PRIMARY KEY,phone_verified INTEGER,phone_hash TEXT);
   CREATE TABLE IF NOT EXISTS phone_otp(uid TEXT,phone_hash TEXT,e164 TEXT,status TEXT,verified_at INTEGER);`);
  f.sql.prepare(`INSERT INTO listings(id,creator_id,kind,title,status,price,starts_at,duration_min,attrs) VALUES('L1','c1','live_event','Ganesh Havan','published',200,${now + 86_400_000},60,'{}')`).run();
  f.sql.prepare(`INSERT INTO contact_verification VALUES('buyer1',1,'h1')`).run();
  f.sql.prepare(`INSERT INTO phone_otp VALUES('buyer1','h1','+919999900001','verified',1)`).run();
  (f.env as any).HDFC_SMS_WATCHER_DEVICE_ID = 'watcher-1';
  (f.env as any).HDFC_SMS_WATCHER_DEVICE_SECRET = WATCHER_SECRET;
  (f.env as any).ADMIN_ALERT_WHATSAPP = '+919876500000';
  (f.env as any).SMS_FORWARDER_TOKEN = TOKEN;
});
afterEach(() => { f.sql.close(); vi.restoreAllMocks(); });

const quoteJson = JSON.stringify({ lines: [{ kind: 'ticket', label: 'Havan ticket', qty: 1, unit_rupees: 200, amount_rupees: 200 }], subtotal_rupees: 200, gst_rate_pct: 0, gst_rupees: 0, total_rupees: 200 });
function insertCheckout(amount_paise: number) {
  const id = uuid(), created = now - 5 * MIN;
  f.sql.prepare(`INSERT INTO saathum_checkouts(checkout_id,uid,listing_id,request_key,quote_json,subtotal_rupees,gst_rupees,total_rupees,ticket_rupees,sankalp_json,prasad,status,receiving_account_key,amount_paise,created_at,expires_at,updated_at,rounding_discount_paise)
    VALUES(?,?,?,?,?,200,0,200,200,'{"name":"Asha"}',0,'awaiting_payment',?,?,?,?,?,?)`).run(id, 'buyer1', 'L1', uuid(), quoteJson, ACCOUNT, amount_paise, created, created + 30 * MIN, created, 20000 - amount_paise);
  return id;
}
const row = (id: string) => f.sql.prepare('SELECT * FROM saathum_checkouts WHERE checkout_id=?').get(id) as any;
const count = (t: string) => Number(f.sql.prepare(`SELECT count(*) n FROM ${t}`).get()?.n);

const text = (amount = '199.99', ref = '000123456789') => `Rs.${amount} credited to A/c XX1234 from Shopping sapin@okhdfc (UPI ${ref}).`;
const URL_ = (token = TOKEN, qs = '') => `https://test.invalid/api/sms/forward/${token}${qs}`;
const send = async (req: Request, token: string | null = TOKEN) => {
  const r = await smsForwarderIncoming(req, f.env, token);
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const postJson = (b: unknown, token = TOKEN) => send(new Request(URL_(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), token);

async function watcherSms(amount = '199.99', ref = '000123456789', received = new Date(now).toISOString()) {
  const b: any = { device_id: 'watcher-1', sender: 'VM-HDFCBK', message: text(amount, ref), received_at: received, sim_slot: -1, message_hash: '', nonce: uuid(), sent_at: new Date(now).toISOString(), signature: '' };
  b.message_hash = await sha256Hex(`${b.sender}|${b.message}|${b.received_at}`);
  b.signature = await hmacSha256Hex(WATCHER_SECRET, [b.device_id, b.sender, b.message, b.received_at, b.sim_slot, b.message_hash, b.nonce, b.sent_at].join('\n'));
  const r = await hdfcSmsIncoming(request('/incoming', b), f.env);
  return { status: r.status, body: await r.json() as any };
}
const review = async () => await (await adminSaathumReviewList(request('/r', undefined, 'admin'), f.env)).json() as any;

describe('lenient formats, strict content', () => {
  it('JSON body (flat) confirms a matching checkout', async () => {
    const id = insertCheckout(19999);
    const r = await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ignored: false, match_state: 'confirmed', sender_rule: 'sender_code' });
    expect(row(id)).toMatchObject({ status: 'confirmed', utr: '000123456789', confirm_source: 'sms_auto' });
    expect(H.provision).toBe(1);
    expect(f.sql.prepare(`SELECT device_id FROM hdfc_sms_receipts`).get()?.device_id).toBe('forwarder');
  });

  it('JSON body with deep nesting and odd key case/ISO timestamp', async () => {
    const id = insertCheckout(19998);
    const r = await postJson({ Event: { Notification: { Title: 'HDFC Bank', BigText: text('199.98', '000222333444') }, PostTime: new Date(now - 1000).toISOString() } });
    expect(r.body).toMatchObject({ ignored: false, sender_rule: 'sender_name' });
    expect(row(id).status).toBe('confirmed');
  });

  it('urlencoded form body', async () => {
    const id = insertCheckout(19997);
    const body = new URLSearchParams({ sender: 'AD-HDFCBK', msg: text('199.97', '000333444555'), date: String(Math.floor(now / 1000)) }).toString();
    const r = await send(new Request(URL_(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }));
    expect(r.body.ignored).toBe(false);
    expect(row(id).status).toBe('confirmed');
  });

  it('multipart body', async () => {
    const id = insertCheckout(19996);
    const fd = new FormData(); fd.set('address', 'VM-HDFCBK'); fd.set('body', text('199.96', '000444555666')); fd.set('sentStamp', String(now));
    const r = await send(new Request(URL_(), { method: 'POST', body: fd }));
    expect(r.body.ignored).toBe(false);
    expect(row(id).status).toBe('confirmed');
  });

  it('text/plain raw SMS with no sender: needs "HDFC Bank A/c" in the text, whole body is the message', async () => {
    const id = insertCheckout(19995);
    const plain = `Credit Alert! Rs.199.95 credited to HDFC Bank A/c XX1234 on 29-09-26 from VPA shop@okhdfc (UPI 000555666777)`;
    const r = await send(new Request(URL_(), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: plain }));
    expect(r.body).toMatchObject({ ignored: false, sender_rule: 'text_hdfc_ac' });
    expect(row(id).status).toBe('confirmed');
  });

  it('GET with query parameters', async () => {
    const id = insertCheckout(19994);
    const qs = '?' + new URLSearchParams({ from: 'VM-HDFCBK', message: text('199.94', '000666777888') }).toString();
    const r = await send(new Request(URL_(TOKEN, qs), { method: 'GET' }));
    expect(r.body.ignored).toBe(false);
    expect(row(id).status).toBe('confirmed');
  });

  it('token in X-Forward-Token header works when the path has none', async () => {
    const id = insertCheckout(19993);
    const r = await send(new Request('https://test.invalid/api/sms/forward', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forward-token': TOKEN }, body: JSON.stringify({ from: 'VM-HDFCBK', message: text('199.93', '000777888999') }) }), null);
    expect(r.body.ignored).toBe(false);
    expect(row(id).status).toBe('confirmed');
  });

  it('wrong token, missing token and unset/short server token all 404 and store nothing', async () => {
    insertCheckout(19999);
    expect((await postJson({ from: 'VM-HDFCBK', message: text() }, 'x'.repeat(40))).status).toBe(404);
    expect((await postJson({ from: 'VM-HDFCBK', message: text() }, TOKEN.slice(0, -1))).status).toBe(404);
    expect((await send(new Request('https://test.invalid/api/sms/forward', { method: 'POST', body: '{}' }), null)).status).toBe(404);
    (f.env as any).SMS_FORWARDER_TOKEN = 'short';
    expect((await postJson({ from: 'VM-HDFCBK', message: text() }, 'short')).status).toBe(404);
    delete (f.env as any).SMS_FORWARDER_TOKEN;
    expect((await postJson({ from: 'VM-HDFCBK', message: text() })).status).toBe(404);
    expect(count('hdfc_sms_receipts')).toBe(0);
    expect(count('sms_source_health')).toBe(0); // unauthenticated requests do not even count as "alive"
  });

  it('flags off -> 410, and nothing is processed', async () => {
    const id = insertCheckout(19999);
    H.cfg.smsForwarderEnabled = false;
    expect((await postJson({ from: 'VM-HDFCBK', message: text() })).status).toBe(410);
    H.cfg.smsForwarderEnabled = true; H.cfg.saathumSmsIngestEnabled = false;
    expect((await postJson({ from: 'VM-HDFCBK', message: text() })).status).toBe(410);
    expect(row(id).status).toBe('awaiting_payment');
    expect(count('hdfc_sms_receipts')).toBe(0);
  });

  it('non-HDFC / non-credit content is ignored, never stored, but the source still counts as alive', async () => {
    const id = insertCheckout(19999);
    const cases: unknown[] = [
      { from: 'AX-ICICIB', message: text() },                                            // other bank sender
      { from: 'VM-HDFCBK', message: 'Rs.199.99 debited from A/c XX1234 (UPI 000123456789).' }, // debit
      { from: 'VM-HDFCBK', message: 'Your OTP is 123456. Rs.199.99 credited' },          // otp
      { from: 'VM-HDFCBK', message: 'Rs.199.99 credited to A/c XX9999 (UPI 000123456789).' }, // wrong account
      { from: 'VM-HDFCBK', message: 'Rs.199.99 credited to A/c XX1234.' },               // no 12-digit ref
      { from: 'Mom', message: text() },                                                   // sender present but not HDFC
      { message: 'hello there' },                                                         // no sender, no HDFC text
      { message: text() },                                                                // no sender, text lacks "HDFC Bank A/c"
    ];
    for (const c of cases) {
      const r = await postJson(c);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, ignored: true });
    }
    expect(count('hdfc_sms_receipts')).toBe(0);
    expect(count('hdfc_sms_smoke_receipts')).toBe(0);
    expect(row(id).status).toBe('awaiting_payment');
    expect(f.sql.prepare(`SELECT last_sms_at FROM sms_source_health WHERE device_id='forwarder'`).get()?.last_sms_at).toBe(now);
  });

  it('senderRule unit: code, name, text-only-when-no-sender', () => {
    expect(senderRule(['VM-HDFCBK'], '')).toBe('sender_code');
    expect(senderRule(['HDFC Bank'], '')).toBe('sender_name');
    expect(senderRule([], 'x HDFC Bank A/c XX1')).toBe('text_hdfc_ac');
    expect(senderRule(['Mom'], 'x HDFC Bank A/c XX1')).toBeNull();
  });

  it('an implausible app timestamp (far future / ancient) falls back to server time and still matches', async () => {
    const id = insertCheckout(19999);
    const r = await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now + 6 * 3_600_000 });
    expect(r.body.match_state).toBe('confirmed');
    expect(row(id).status).toBe('confirmed');
  });
});

describe('forwarder + watcher (dedupe, confirms once)', () => {
  it('forwarder first, then watcher: one confirmation, one provision', async () => {
    const id = insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    const w = await watcherSms();
    expect(w.status).toBe(200);
    expect(w.body.match_state).toBe('confirmed');
    expect(H.provision).toBe(1);
    expect(row(id).status).toBe('confirmed');
    expect(count('hdfc_sms_smoke_receipts')).toBe(1);
    expect(H.emails.filter((e) => e.kind === 'saathum_checkout_confirmation')).toHaveLength(1);
  });

  it('watcher first, then forwarder (timestamps differ): still once', async () => {
    const id = insertCheckout(19999);
    await watcherSms();
    now += 20_000;
    const r = await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    expect(r.body.match_state).toBe('confirmed');
    expect(H.provision).toBe(1);
    expect(row(id).confirm_source).toBe('sms_auto');
    expect(count('hdfc_sms_smoke_receipts')).toBe(1);
  });

  it('the same forwarded SMS retried is idempotent', async () => {
    insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    expect(H.provision).toBe(1);
    expect(count('hdfc_sms_smoke_receipts')).toBe(1);
  });
});

describe('corroboration flag (forwarder-only confirmations)', () => {
  it('forwarder-only confirmation is flagged needs_corroboration in confirmed_uncorroborated', async () => {
    const id = insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    let b = await review();
    expect(b.confirmed_uncorroborated).toHaveLength(1);
    expect(b.confirmed_uncorroborated[0]).toMatchObject({ checkout_id: id, needs_corroboration: true, bank_reference: '000123456789', pay_amount_paise: 19999, confirmed_via: 'forwarder', corroboration_window_open: true, buyer_name: 'Asha' });
    now += 31 * MIN;
    b = await review();
    expect(b.confirmed_uncorroborated[0].corroboration_window_open).toBe(false);
    now += 8 * 86_400_000; // older than 7 days drops off
    expect((await review()).confirmed_uncorroborated).toHaveLength(0);
  });

  it('watcher delivering the same SMS within 30 min corroborates it (not flagged)', async () => {
    insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    now += 10 * MIN;
    await watcherSms('199.99', '000123456789', new Date(now).toISOString());
    expect((await review()).confirmed_uncorroborated).toHaveLength(0);
  });

  it('a watcher copy arriving > 30 min later does not count', async () => {
    insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    now += 45 * MIN;
    await watcherSms('199.99', '000123456789', new Date(now).toISOString());
    expect((await review()).confirmed_uncorroborated).toHaveLength(1);
  });

  it('confirmed by the watcher first -> never flagged, and unconfirmed rows carry needs_corroboration:false', async () => {
    insertCheckout(19999);
    await watcherSms();
    await postJson({ from: 'VM-HDFCBK', message: text(), timestamp: now });
    const stuck = insertCheckout(19990);
    f.sql.prepare(`UPDATE saathum_checkouts SET status='review_pending',reason_code='awaiting_bank',paid_claimed_at=? WHERE checkout_id=?`).run(now - 20 * MIN, stuck);
    const b = await review();
    expect(b.confirmed_uncorroborated).toHaveLength(0);
    expect(b.checkouts[0].needs_corroboration).toBe(false);
  });
});

describe('capture mode', () => {
  it('off by default: nothing stored', async () => {
    await postJson({ from: 'VM-HDFCBK', message: text() });
    expect(count('sms_forwarder_captures')).toBe(0);
  });

  it('keeps only the last 20, redacted to the last 4 digits of 10+ digit runs, never the token', async () => {
    H.cfg.smsForwarderCaptureEnabled = true;
    for (let i = 0; i < 25; i++) {
      now += 1000;
      await postJson({ from: 'VM-HDFCBK', message: `${text('5.00', '000123456789')} call 9876543210 seq${i}`, extra: { n: i } });
    }
    expect(count('sms_forwarder_captures')).toBe(20);
    const res = await adminForwarderCaptures(request('/c', undefined, 'admin'), f.env);
    const b = await res.json() as any;
    expect(b.capture_enabled).toBe(true);
    expect(b.captures).toHaveLength(20);
    expect(b.captures[0].body_sample).toContain('seq24');   // newest first
    expect(b.captures[19].body_sample).toContain('seq5');   // seq0..4 pruned
    for (const c of b.captures) {
      expect(c.body_sample).not.toContain('9876543210');
      expect(c.body_sample).not.toContain('000123456789');
      expect(c.body_sample).toContain('******3210');
      expect(c.body_sample).toContain('********6789');
      expect(c.body_sample).not.toContain(TOKEN);
      expect(c.top_keys).toEqual(['from', 'message', 'extra']);
      expect(c.content_type).toBe('application/json');
      expect(c.body_sample.length).toBeLessThanOrEqual(2048);
    }
  });

  it('caps the sample at 2 KB', async () => {
    H.cfg.smsForwarderCaptureEnabled = true;
    await postJson({ message: 'a'.repeat(9000) });
    expect(String(f.sql.prepare('SELECT body_sample FROM sms_forwarder_captures').get()?.body_sample).length).toBe(2048);
  });

  it('capture-only (forwarder off) records the format but confirms nothing; captures are admin-only', async () => {
    const id = insertCheckout(19999);
    H.cfg.smsForwarderEnabled = false; H.cfg.smsForwarderCaptureEnabled = true;
    const r = await postJson({ from: 'VM-HDFCBK', message: text() });
    expect(r.body).toMatchObject({ ok: true, ignored: true, capture_only: true });
    expect(count('sms_forwarder_captures')).toBe(1);
    expect(row(id).status).toBe('awaiting_payment');
    expect(count('hdfc_sms_receipts')).toBe(0);
    expect((await adminForwarderCaptures(request('/c', undefined, 'buyer1'), f.env)).status).toBe(403);
  });

  it('GET captures store the redacted query string, not the path token', async () => {
    H.cfg.smsForwarderCaptureEnabled = true;
    await send(new Request(URL_(TOKEN, '?from=VM-HDFCBK&message=x&phone=919876543210'), { method: 'GET' }));
    const c = f.sql.prepare('SELECT * FROM sms_forwarder_captures').get() as any;
    expect(c.body_sample).not.toContain(TOKEN);
    expect(c.body_sample).toContain('********3210');
    expect(JSON.parse(c.top_keys)).toEqual(['?from', '?message', '?phone']);
  });
});

describe('source health + silence alert', () => {
  it('accepted request upserts sms_source_health for device forwarder', async () => {
    insertCheckout(19999);
    await postJson({ from: 'VM-HDFCBK', message: text() });
    expect(f.sql.prepare(`SELECT source,last_sms_at,last_heartbeat_at FROM sms_source_health WHERE device_id='forwarder'`).get()).toMatchObject({ source: 'forwarder', last_sms_at: now, last_heartbeat_at: null });
  });

  it('the heartbeat stale-source cron never alerts on the forwarder', async () => {
    await postJson({ from: 'Mom', message: 'hi' });
    now += 3 * 3_600_000;
    await checkSourceHealth(f.env, now); // may alert on companion/watcher, never on the forwarder
    expect(H.waTexts.filter((w) => /forwarder/i.test(w.text))).toHaveLength(0);
  });

  it('alerts only after 24 h of zero requests WHILE the watcher saw HDFC credits; once per 12 h; then "sending again"', async () => {
    await postJson({ from: 'Mom', message: 'hi' }); // forwarder alive at t0
    now += 25 * 3_600_000;
    expect(await checkForwarderSilence(f.env, now)).toEqual({ silent: 0, recovered: 0 }); // silent, but the watcher saw nothing
    await watcherSms('50.00', '000999111222', new Date(now).toISOString()); // watcher sees a credit
    expect(await checkForwarderSilence(f.env, now)).toEqual({ silent: 1, recovered: 0 });
    expect(H.waTexts).toHaveLength(1);
    expect(H.waTexts[0].text).toMatch(/forwarder/i);
    now += 3_600_000;
    expect(await checkForwarderSilence(f.env, now)).toEqual({ silent: 0, recovered: 0 }); // no spam inside 12 h
    const sweep = await runSaathumPaymentSweeps(f.env, now);
    expect(sweep.forwarder_silent).toBe(0);
    now += 12 * 3_600_000;
    expect((await checkForwarderSilence(f.env, now)).silent).toBe(1);
    // the review payload reflects it
    const s = (await review()).sources.find((x: any) => x.device_id === 'forwarder');
    expect(s).toMatchObject({ source: 'forwarder', healthy: false, heartbeat: false });
    await postJson({ from: 'Mom', message: 'hi' });
    expect(await checkForwarderSilence(f.env, now)).toEqual({ silent: 0, recovered: 1 });
    expect((await review()).sources.find((x: any) => x.device_id === 'forwarder').healthy).toBe(true);
  });

  it('never alerts when the forwarder flag is off', async () => {
    await postJson({ from: 'Mom', message: 'hi' });
    now += 25 * 3_600_000;
    await watcherSms('50.00', '000999111222', new Date(now).toISOString());
    H.cfg.smsForwarderEnabled = false;
    expect(await checkForwarderSilence(f.env, now)).toEqual({ silent: 0, recovered: 0 });
  });
});
