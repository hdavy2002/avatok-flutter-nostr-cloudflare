// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for

// [HF-TOPUP-1] Real hf_topups SQL (in-memory SQLite behind a D1 shim) + a FakeAdapter. No network, no real gateway.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const credits = new Map<string, number>(); // op_id -> amount (WalletDO dedupes by op_id)
let cfg: Record<string, unknown> = {};
let fakeOrderPaid = true;
let fakePaidPaise = 0;
let fakeOrderError: string | null = null; // [HF-WIRE-20] makes the fake gateway refuse the order
let customerNow = { phone: "9876543210", email: "fan@example.com" as string | null } as { phone: string | null; email: string | null };
const orderCalls: any[] = [];
vi.mock("../lib/hf_topup_customer", () => ({ topupCustomer: async () => customerNow }));

vi.mock("./wallet", () => ({
  walletOp: async (_env: unknown, _uid: string, op: any) => {
    if (op.op === "credit") { if (!credits.has(op.op_id)) credits.set(op.op_id, op.amount); return { status: 200, body: { ok: true, balance: [...credits.values()].reduce((a, b) => a + b, 0) } }; }
    return { status: 200, body: { ok: true } };
  },
}));
const lots = new Map<string, any>(); // op_id -> creditLot args (the ledger dedupes by op_id)
const notices: any[] = [];
vi.mock("../lib/hf_token_ledger", () => ({
  creditLot: async (_env: unknown, uid: string, a: any, opId: string) => {
    if (lots.has(opId)) return { applied: false, lotId: lots.get(opId).lotId };
    lots.set(opId, { ...a, uid, lotId: `lot_${lots.size + 1}` });
    return { applied: true, lotId: `lot_${lots.size}` };
  },
}));
vi.mock("../lib/hf_topup_notify", () => ({ notifyTopupCredited: async (_e: unknown, n: any) => { notices.push(n); return {}; } }));
vi.mock("../hooks", () => ({ track: async () => undefined, trackException: async () => undefined }));
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: unknown, uid: string) => uid === "admin" }));

const fake = {
  id: "razorpay",
  configured: () => true,
  testMode: () => true,
  createOrder: async (_env: unknown, a: any) => fakeOrderError ? (orderCalls.push(a), { error: fakeOrderError, status: 422 }) : (orderCalls.push(a), {
    gateway: "razorpay", gateway_order_id: `gw_${a.orderId}`, amount_paise: a.amountPaise, currency: "INR", client_payload: { key_id: "k", razorpay_order_id: `gw_${a.orderId}` },
  }),
  verifyWebhook: async (_e: unknown, raw: string, h: Headers) => h.get("x-sig") === "good",
  parseWebhook: (raw: string) => JSON.parse(raw),
  fetchOrder: async (_e: unknown, id: string) => ({ status: fakeOrderPaid ? "paid" : "created", amount_paise: fakePaidPaise || 0 }),
  refund: async () => ({ accepted: false, gateway_refund_id: null }),
};
vi.mock("../lib/payments/registry", () => ({ resolveGateway: (id: string) => (id === "razorpay" ? fake : null), isGatewayId: () => true }));

import { hfTopupRoute } from "./hf_topup";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/2026-10-09-hf-topups.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/2026-10-15-hf-topups-rupee-wallet.sql", import.meta.url), "utf8"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  return { prepare: (q: string) => stmt(q), raw: db };
}
function makeKv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
}

let env: any;
const ON = { hfTopupEnabled: true, hfTopupGateway: "razorpay", hfTopupPacks: "100,200", hfTopupMinRupees: 50, hfTopupMaxRupees: 5000 };
let idem = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  hfTopupRoute(new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": `k${++idem}`, ...headers } }), env, path);
const webhook = (body: unknown, sig = "good") =>
  hfTopupRoute(new Request("https://x/api/hf/wallet/topup/webhook/razorpay", { method: "POST", body: JSON.stringify(body), headers: { "x-sig": sig } }), env, "/api/hf/wallet/topup/webhook/razorpay");

beforeEach(() => {
  env = { DB_META: makeDb(), TOKENS: makeKv() };
  orderCalls.length = 0; fakeOrderError = null; customerNow = { phone: "9876543210", email: "fan@example.com" };
  credits.clear(); lots.clear(); notices.length = 0; cfg = { ...ON }; fakeOrderPaid = true; fakePaidPaise = 0; idem = 0;
});

async function newTopup(amount = 200) {
  const res = await post("/api/hf/wallet/topup", { amount });
  expect(res.status).toBe(200);
  const b = await res.json();
  fakePaidPaise = amount * 100;
  return b as { topupId: string; testMode: boolean; gateway: string };
}
const paidEvent = (id: string, paise: number, over: Record<string, unknown> = {}) => ({
  gateway_order_id: `gw_${id}`, our_order_id: id, status: "paid", amount_paise: paise, currency: "INR", gateway_payment_id: "pay_1", ...over,
});

describe("hf top-up", () => {
  it("flag off -> 503 topup_unavailable and nothing written", async () => {
    cfg = { ...ON, hfTopupEnabled: false };
    const res = await post("/api/hf/wallet/topup", { amount: 100 });
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("topup_unavailable");
    expect(env.DB_META.raw.prepare("SELECT COUNT(*) c FROM hf_topups").get().c).toBe(0);
  });

  it('gateway "none" (or an unknown name) -> 503', async () => {
    cfg = { ...ON, hfTopupGateway: "none" };
    expect((await post("/api/hf/wallet/topup", { amount: 100 })).status).toBe(503);
    cfg = { ...ON, hfTopupGateway: "hdfc_sms" };
    expect((await post("/api/hf/wallet/topup", { amount: 100 })).status).toBe(503);
  });

  it("creates an order, returns the client payload and test mode, and rejects out-of-range amounts", async () => {
    const t = await newTopup(200);
    expect(t.topupId).toMatch(/^hftop_[a-f0-9]{24}$/);
    expect(t.gateway).toBe("razorpay");
    expect(t.testMode).toBe(true);
    expect((await post("/api/hf/wallet/topup", { amount: 10 })).status).toBe(400);
    expect((await post("/api/hf/wallet/topup", { amount: 99999 })).status).toBe(400);
    expect((await post("/api/hf/wallet/topup", { amount: 75.5 })).status).toBe(400);
  });

  // [HF-WIRE-20] The gateway order gets the payer's real details and, from the app, the app return target.
  it("passes the real phone/email and client=app to the gateway; the web default is client=web", async () => {
    expect((await post("/api/hf/wallet/topup", { amount: 100, client: "app" })).status).toBe(200);
    expect((await post("/api/hf/wallet/topup", { amount: 100 })).status).toBe(200);
    expect(orderCalls[0].client).toBe("app");
    expect(orderCalls[0].customer).toEqual({ phone: "9876543210", email: "fan@example.com" });
    expect(orderCalls[1].client).toBe("web");
  });

  it("no verified number: 409 whatsapp_required in plain words, the row is marked failed, no gateway name", async () => {
    customerNow = { phone: null, email: null };
    fakeOrderError = "customer_phone_required";
    const res = await post("/api/hf/wallet/topup", { amount: 100, client: "app" });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.error).toBe("whatsapp_required");
    expect(b.message).toMatch(/WhatsApp/);
    expect(b.message).not.toMatch(/cashfree|razorpay/i);
    expect(env.DB_META.raw.prepare("SELECT status FROM hf_topups").get().status).toBe("failed");
  });

  it("webhook is idempotent: a double delivery credits once", async () => {
    const { topupId } = await newTopup(200);
    const a = await (await webhook(paidEvent(topupId, 20000))).json();
    const b = await (await webhook(paidEvent(topupId, 20000))).json();
    expect(a.credited).toBe(true);
    expect(b.duplicate).toBe(true);
    expect([...credits.entries()]).toEqual([[`hftop:${topupId}`, 200]]);
    const row = env.DB_META.raw.prepare("SELECT status, credited FROM hf_topups WHERE id=?").get(topupId);
    expect(row).toEqual({ status: "paid", credited: 1 });
  });

  it("a replay after a crash between credit and row update still credits only once", async () => {
    const { topupId } = await newTopup(200);
    credits.set(`hftop:${topupId}`, 200); // wallet already credited, row still 'created'
    const r = await (await webhook(paidEvent(topupId, 20000))).json();
    expect(r.credited).toBe(true);
    expect(credits.size).toBe(1);
    expect(env.DB_META.raw.prepare("SELECT credited FROM hf_topups WHERE id=?").get(topupId).credited).toBe(1);
  });

  it("amount mismatch is ignored with 200 and credits nothing", async () => {
    const { topupId } = await newTopup(200);
    const res = await webhook(paidEvent(topupId, 100));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe("amount_mismatch");
    expect(credits.size).toBe(0);
    // gateway read-back disagreeing with the webhook is also refused
    fakePaidPaise = 100;
    expect((await (await webhook(paidEvent(topupId, 20000))).json()).ignored).toBe("amount_mismatch");
    expect(credits.size).toBe(0);
  });

  it("webhook saying paid while the gateway says not paid credits nothing", async () => {
    const { topupId } = await newTopup(200);
    fakeOrderPaid = false;
    expect((await (await webhook(paidEvent(topupId, 20000))).json()).ignored).toBe("not_paid_at_gateway");
    expect(credits.size).toBe(0);
  });

  it("bad signature -> 401; unknown order -> 200 ignored", async () => {
    const { topupId } = await newTopup(200);
    expect((await webhook(paidEvent(topupId, 20000), "forged")).status).toBe(401);
    expect(credits.size).toBe(0);
    const res = await webhook(paidEvent("hftop_" + "0".repeat(24), 20000));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe("unknown_topup");
  });

  it("only the owner can read a top-up; admin reconcile settles a paid-at-gateway order", async () => {
    const { topupId } = await newTopup(200);
    const other = await hfTopupRoute(new Request(`https://x/api/hf/wallet/topup/${topupId}`, { headers: { "x-test-uid": "u2" } }), env, `/api/hf/wallet/topup/${topupId}`);
    expect(other.status).toBe(404);
    const nonAdmin = await post(`/api/admin/hf/topups/${topupId}/reconcile`, {});
    expect(nonAdmin.status).toBe(403);
    const rec = await post(`/api/admin/hf/topups/${topupId}/reconcile`, {}, { "x-test-uid": "admin" });
    expect((await rec.json()).status).toBe("paid");
    expect(credits.get(`hftop:${topupId}`)).toBe(200);
  });

  // [HF-CASHFREE-TOPUP-1] Rupee wallet on: the credit is a rupee lot with 18% GST taken out, once, and the legacy WalletDO is not touched.
  it("rupee wallet: Rs 2 paid -> Rs 1.69 into a lot, Rs 0.31 GST, exactly once", async () => {
    cfg = { ...ON, hfTokensEnabled: true, hfTopupMinRupees: 1 };
    const { topupId } = await newTopup(2);
    const a = await (await webhook(paidEvent(topupId, 200))).json();
    const b = await (await webhook(paidEvent(topupId, 200))).json();
    expect(a.credited).toBe(true);
    expect(b.duplicate).toBe(true);
    expect(credits.size).toBe(0);
    expect(lots.size).toBe(1);
    const lot = lots.get(`hftop:${topupId}`);
    expect(lot).toMatchObject({ kind: "purchase", paidPaise: 200, gstPaise: 31, micro: 169 * 10_000, valuePaisePerToken: 100, provider: "razorpay", providerRef: topupId });
    const row = env.DB_META.raw.prepare("SELECT status, credited, wallet_paise, gst_paise, lot_id FROM hf_topups WHERE id=?").get(topupId);
    expect(row).toEqual({ status: "paid", credited: 1, wallet_paise: 169, gst_paise: 31, lot_id: "lot_1" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ paidPaise: 200, creditPaise: 169, gstPaise: 31 });
    const st = await hfTopupRoute(new Request(`https://x/api/hf/wallet/topup/${topupId}`), env, `/api/hf/wallet/topup/${topupId}`);
    expect(await st.json()).toMatchObject({ credited: true, paidPaise: 200, walletPaise: 169, gstPaise: 31 });
  });

  it("rupee wallet: Rs 120 -> Rs 101.69 + GST Rs 18.31", async () => {
    cfg = { ...ON, hfTokensEnabled: true };
    const { topupId } = await newTopup(120);
    await webhook(paidEvent(topupId, 12000));
    expect(lots.get(`hftop:${topupId}`)).toMatchObject({ paidPaise: 12000, gstPaise: 1831, micro: 10169 * 10_000 });
  });

  // [HF-WIRE-6]
  it("create returns the app fields: Rs 500 -> credit Rs 423.72, GST Rs 76.28, sandbox in test mode", async () => {
    cfg = { ...ON, hfTokensEnabled: true };
    const b = await (await post("/api/hf/wallet/topup", { amount: 500 })).json();
    expect(b).toMatchObject({ amountPaise: 50000, creditPaise: 42372, gstPaise: 7628, environment: "sandbox", orderId: b.topupId });
  });

  it("status gives pending -> paid state with creditPaise; min is Rs 10 by default", async () => {
    cfg = { ...ON, hfTokensEnabled: true, hfTopupMinRupees: 10 };
    expect((await post("/api/hf/wallet/topup", { amount: 9 })).status).toBe(400);
    const { topupId } = await newTopup(500);
    const get = async () => (await hfTopupRoute(new Request(`https://x/api/hf/wallet/topup/${topupId}`), env, `/api/hf/wallet/topup/${topupId}`)).json();
    expect(await get()).toMatchObject({ state: "pending", creditPaise: null });
    await webhook(paidEvent(topupId, 50000));
    expect(await get()).toMatchObject({ state: "paid", creditPaise: 42372, gstPaise: 7628 });
  });
});
