// @ts-nocheck -- node:sqlite via the shared D1 shim; the gateway, notifications and print partner are faked
// [HF-CHANNEL-CORE-1] Bag (group) checkout: wallet success + rollback, Cashfree one-order-for-the-group, reconcile against the group SUM, idempotent retry,
// per-order refunds on the group's gateway order, and the single-item body staying an ordinary order.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

const gw = vi.hoisted(() => ({ configured: true, created: [] as any[], createError: null as any, fetch: null as any, refunds: [] as any[] }));
vi.mock("../routes/config", () => ({ readConfig: async () => ({}) }));
vi.mock("./payments/registry", () => ({
  resolveGateway: () => ({
    configured: () => gw.configured,
    createOrder: async (_e: any, a: any) => {
      gw.created.push(a);
      return gw.createError ?? { gateway: "cashfree", gateway_order_id: a.orderId, amount_paise: a.amountPaise, currency: "INR", client_payload: { payment_session_id: "session_abcdefghij1234", checkout_url: "https://pay.test/x" } };
    },
    fetchOrder: async (_e: any, id: string) => (gw.fetch ? gw.fetch(id) : null),
    refund: async (_e: any, a: any) => { gw.refunds.push(a); return { accepted: true, gateway_refund_id: null }; },
    listRefunds: async () => ({ found: true, gateway_refund_id: "r1", status: "SUCCESS" }),
  }),
}));
vi.mock("./hf_topup_customer", () => ({ topupCustomer: async () => ({ phone: "9876543210", email: null, name: "Asha" }) }));
vi.mock("../routes/shop_orders", () => ({
  appendShopEvent: async (env: any, orderId: string, kind: string, actor: string | null, note: string | null = null, at = Date.now()) => {
    await env.DB_META.prepare("INSERT INTO shop_order_events (order_id, at, kind, actor, note) VALUES (?1,?2,?3,?4,?5)").bind(orderId, at, kind, actor, note).run();
  },
}));
vi.mock("./hf_merch_notify", () => ({
  snapOf: (row: any) => { try { return JSON.parse(row.merch_json || "{}"); } catch { return {}; } },
  merchTrack: async () => undefined, merchFail: async () => undefined, merchPush: async () => undefined,
  alertOwnerMerchRefund: async () => undefined, notifyMerchApproved: async () => undefined, notifyMerchPaid: async () => undefined,
  notifyMerchRejected: async () => undefined, notifyMerchStatusPush: async () => undefined,
}));
vi.mock("./pod_fulfil", () => ({ sendOrderToPartner: async () => ({ ok: false, error: "manual_provider" }), advanceOrder: async () => true }));
vi.mock("./hf_merch_catalog", () => ({ liveBaseUnitForOrder: async () => ({ ok: false, message: "n/a" }) }));
vi.mock("./hf_merch_delivered", () => ({ creditMerchEarning: async () => "credited", reverseMerchEarning: async () => "none" }));
vi.mock("./hf_merch_wallet", async (orig) => {
  const a: any = await orig();
  return { ...a, spendWalletForOrder: vi.fn(a.spendWalletForOrder) };
});

import { startMerchBagCheckout } from "./hf_merch_group";
import { startMerchCheckout, reconcileCashfreeOrder, rejectMerchOrder, confirmCashfreeRefundsForGroup, merchRefundId } from "./hf_merch_flow";
import { spendWalletForOrder } from "./hf_merch_wallet";
import { getGroupRows, hostByUid, getProduct } from "./hf_merch_store";

const MIGS = ["2026-10-10-hf-tokens.sql", "2026-10-09-hf-hosts.sql", "2026-10-01-saathum-shop.sql", "2026-10-01-aumfe-pod.sql", "2026-10-23-hf-merch-alters.sql", "2026-10-23-hf-merch-tables.sql"];
const ADDR = { name: "Asha Rao", phone: "9876543210", line1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001" };
const T = (n: number) => Math.round(n * MICRO);
let env: any;

const lot = (uid: string, tokens: number, op: string) =>
  creditLot(env, uid, { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: T(tokens), paidPaise: tokens * 100, provider: "cashfree", providerRef: op }, op);

function seedProduct(id: string, seller: string, slug: string, o: { markup?: number; base?: number; sizes?: string[]; colours?: string[] } = {}) {
  const raw = env.DB_META._raw;
  raw.prepare("INSERT OR IGNORE INTO hf_hosts (uid, slug, status, display_name, created_at, updated_at) VALUES (?,?,?,?,1,1)").run(seller, `host-${seller}`, "live", `Host ${seller}`);
  const merch = {
    v: 1, productSlug: slug, provider: "printrove", catalogId: "c1", catalogName: "Men's T-shirt", kind: "mens_tee", side: "front",
    sizes: (o.sizes ?? ["M", "L"]).map((s) => ({ size: s, baseUnitPaise: o.base ?? 30000 })), bufferRupees: 0,
    colours: (o.colours ?? ["Black"]).map((n) => ({ name: n, hex: "#111111" })), placement: { print_w_in: 10, print_h_in: 10 }, mockups: ["https://m/x.png"], printPreviewUrl: "https://m/p.png", artUrl: null, moderation: "ok",
  };
  raw.prepare("INSERT INTO shop_products (id, slug, name, price_rupees, status, created_at, updated_at, seller_uid, review_status, markup_rupees, merch_json) VALUES (?,?,?,?,?,1,1,?,?,?,?)")
    .run(id, `host-${seller}--${slug}`, `Shirt ${slug}`, 400, "hidden", seller, "live", o.markup ?? 100, JSON.stringify(merch));
}
const rows = (q = "SELECT * FROM shop_orders ORDER BY request_key") => env.DB_META._raw.prepare(q).all();
const bag = (lines: any[], o: any = {}) => startMerchBagCheckout(env, { uid: "buyer", lines, address: ADDR, saveAddress: false, method: "wallet", requestKey: "key-12345678", client: "web", ...o });
const L1 = { productId: "prd-1", colour: "Black", size: "M", qty: 1 }; // 30000 + 10000 = 40000 paise
const L2 = { productId: "prd-2", colour: "Black", size: "L", qty: 2 }; // 2 x 40000 = 80000

beforeEach(() => {
  env = { DB_META: makeDb(MIGS, { alters: true }), TOKENS: { get: async () => null, put: async () => undefined } };
  const kv = new Map<string, string>();
  env.TOKENS = { get: async (k: string, t?: string) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k: string, v: string) => { kv.set(k, v); } };
  gw.configured = true; gw.created = []; gw.createError = null; gw.fetch = null; gw.refunds = [];
  (spendWalletForOrder as any).mockClear();
  seedProduct("prd-1", "sellerA", "one");
  seedProduct("prd-2", "sellerB", "two");
});

describe("bag checkout: wallet", () => {
  it("charges once per order, links the orders by groupId, and a retry with the same key creates nothing new", async () => {
    await lot("buyer", 2000, "p1");
    const r: any = await bag([L1, L2]);
    expect(r.ok).toBe(true);
    expect(r.groupId).toMatch(/^mgp_[a-f0-9]{20}$/);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x: any) => x.amount_paise)).toEqual([40000, 80000]);
    expect(r.rows.every((x: any) => x.pay_status === "confirmed" && x.approval_status === "pending")).toBe(true);
    const all = rows();
    expect(all.map((x: any) => x.request_key)).toEqual(["key-12345678:0", "key-12345678:1"]);
    expect(all.every((x: any) => JSON.parse(x.merch_json).groupId === r.groupId)).toBe(true);
    expect(new Set(all.map((x: any) => x.seller_uid))).toEqual(new Set(["sellerA", "sellerB"]));
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(200000 - 120000);

    const again: any = await bag([L1, L2]);
    expect(again.ok).toBe(true);
    expect(again.groupId).toBe(r.groupId);
    expect(again.rows.map((x: any) => x.order_id)).toEqual(r.rows.map((x: any) => x.order_id));
    expect(rows()).toHaveLength(2);
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(80000); // not charged twice
  });

  it("a short wallet is refused up front: 402, nothing charged, every order cancelled", async () => {
    await lot("buyer", 1000, "p1"); // 100000 < 120000
    const r: any = await bag([L1, L2]);
    expect(r).toMatchObject({ ok: false, status: 402, error: "insufficient_balance" });
    expect(r.extra).toMatchObject({ balancePaise: 100000, shortPaise: 20000 });
    expect(spendWalletForOrder).not.toHaveBeenCalled();
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(100000);
    expect(rows().every((x: any) => x.pay_status === "cancelled")).toBe(true);
  });

  it("a charge that fails part-way gives the earlier charge back and cancels the whole group", async () => {
    await lot("buyer", 2000, "p1");
    const real = (await vi.importActual("./hf_merch_wallet")) as any;
    (spendWalletForOrder as any).mockImplementationOnce(real.spendWalletForOrder).mockResolvedValueOnce({ ok: false, reason: "conflict" });
    const r: any = await bag([L1, L2]);
    expect(r).toMatchObject({ ok: false, status: 503, error: "wallet_unavailable" });
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(200000); // first order refunded
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all.every((x: any) => x.pay_status === "cancelled" && x.confirmed_at == null)).toBe(true);
    // the same key now reports a closed order instead of charging again
    const retry: any = await bag([L1, L2]);
    expect(retry).toMatchObject({ ok: false, status: 409, error: "order_closed" });
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(200000);
  });

  it("validates every line first: one bad colour = 409 item_unavailable and nothing is created", async () => {
    await lot("buyer", 2000, "p1");
    const r: any = await bag([L1, { ...L2, colour: "Pink" }]);
    expect(r).toMatchObject({ ok: false, status: 409, error: "item_unavailable", extra: { productId: "prd-2", reason: "bad_colour" } });
    expect(rows()).toHaveLength(0);
    const gone: any = await bag([L1, { ...L2, productId: "prd-missing" }], { requestKey: "key-other-1234" });
    expect(gone).toMatchObject({ ok: false, status: 409, error: "item_unavailable", extra: { productId: "prd-missing", reason: "gone" } });
    expect(rows()).toHaveLength(0);
    expect((await balanceSummary(env, "buyer")).availablePaidPaise).toBe(200000);
  });

  it("rejects an empty bag, more than 10 lines, qty above the per-line cap, and the buyer's own product", async () => {
    expect(await bag([])).toMatchObject({ ok: false, error: "invalid_items" });
    expect(await bag(Array.from({ length: 11 }, () => L1))).toMatchObject({ ok: false, error: "invalid_items" });
    expect(await bag([{ ...L1, qty: 4 }])).toMatchObject({ ok: false, error: "bad_qty" });
    expect(await bag([L1], { uid: "sellerA" })).toMatchObject({ ok: false, status: 403, error: "own_product" });
    expect(rows()).toHaveLength(0);
  });
});

describe("bag checkout: Cashfree", () => {
  it("creates ONE gateway order (id = groupId, amount = sum) and stores the group id on every row; a retry reuses the session", async () => {
    const r: any = await bag([L1, L2], { method: "cashfree" });
    expect(r.ok).toBe(true);
    expect(gw.created).toHaveLength(1);
    expect(gw.created[0]).toMatchObject({ orderId: r.groupId, amountPaise: 40000 + 80000, kind: "hf_merch" });
    expect(rows().every((x: any) => x.cashfree_order_id === r.groupId && x.pay_status === "awaiting_payment")).toBe(true);
    expect(r.checkoutUrl).toBe("https://pay.test/x");
    expect(r.paymentSessionId).toBe("session_abcdefghij1234");
    gw.fetch = () => ({ status: "ACTIVE", amount_paise: 120000 });
    const again: any = await bag([L1, L2], { method: "cashfree" });
    expect(again.ok).toBe(true);
    expect(again.groupId).toBe(r.groupId);
    expect(again.checkoutUrl).toBe("https://pay.test/x");
    expect(gw.created).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  });

  it("reconcile (by group id, or via any one order) compares to the GROUP sum and settles every order", async () => {
    const r: any = await bag([L1, L2], { method: "cashfree" });
    gw.fetch = () => ({ status: "PAID", amount_paise: 120000 });
    expect(await reconcileCashfreeOrder(env, r.rows[0].order_id)).toBe("confirmed");
    const all = rows();
    expect(all.every((x: any) => x.pay_status === "confirmed" && x.confirm_source === "cashfree")).toBe(true);
    expect(await reconcileCashfreeOrder(env, r.groupId)).toBe("duplicate");
    expect((await getGroupRows(env, r.groupId)).map((x: any) => x.order_id)).toEqual(r.rows.map((x: any) => x.order_id));
  });

  it("an amount that is not the group sum (e.g. one line's amount) confirms nothing", async () => {
    const r: any = await bag([L1, L2], { method: "cashfree" });
    gw.fetch = () => ({ status: "PAID", amount_paise: 40000 });
    expect(await reconcileCashfreeOrder(env, r.groupId)).toBe("mismatch");
    expect(rows().every((x: any) => x.pay_status === "awaiting_payment")).toBe(true);
    gw.fetch = () => ({ status: "ACTIVE", amount_paise: 120000 });
    expect(await reconcileCashfreeOrder(env, r.groupId)).toBe("pending");
    gw.fetch = () => ({ status: "EXPIRED", amount_paise: 120000 });
    expect(await reconcileCashfreeOrder(env, r.groupId)).toBe("failed");
  });

  it("a crash that left one order confirmed is repaired by the next reconcile (the other order is settled)", async () => {
    const r: any = await bag([L1, L2], { method: "cashfree" });
    env.DB_META._raw.prepare("UPDATE shop_orders SET pay_status='confirmed', confirmed_at=5 WHERE order_id=?").run(r.rows[0].order_id);
    gw.fetch = () => ({ status: "PAID", amount_paise: 120000 });
    expect(await reconcileCashfreeOrder(env, r.groupId)).toBe("confirmed");
    expect(rows().every((x: any) => x.pay_status === "confirmed")).toBe(true);
  });

  it("refunds are per order: a partial refund of that order's amount on the group's gateway order, with a unique refund id each", async () => {
    const r: any = await bag([L1, L2], { method: "cashfree" });
    gw.fetch = () => ({ status: "PAID", amount_paise: 120000 });
    await reconcileCashfreeOrder(env, r.groupId);
    const [a, b] = r.rows;
    expect(await rejectMerchOrder(env, a.order_id, "admin1", "out of stock")).toMatchObject({ ok: true, refund: "pending_gateway" });
    expect(await rejectMerchOrder(env, b.order_id, "admin1", "out of stock")).toMatchObject({ ok: true, refund: "pending_gateway" });
    expect(gw.refunds).toHaveLength(2);
    expect(gw.refunds.map((x) => x.gatewayOrderId)).toEqual([r.groupId, r.groupId]);
    expect(gw.refunds.map((x) => x.amountPaise)).toEqual([40000, 80000]);
    expect(gw.refunds[0].opId).toBe(merchRefundId(a.order_id));
    expect(gw.refunds[1].opId).toBe(merchRefundId(b.order_id));
    expect(gw.refunds[0].opId).not.toBe(gw.refunds[1].opId);
    // the refund webhook names the group: every waiting order is checked
    expect(await confirmCashfreeRefundsForGroup(env, r.groupId)).toBe("done");
    expect(rows().every((x: any) => x.refund_status === "done")).toBe(true);
  });
});

describe("single-item checkout is untouched", () => {
  it("an ordinary body still makes one order with the plain request key and no groupId", async () => {
    await lot("buyer", 2000, "p1");
    const product = await getProduct(env, "prd-1");
    const host = await hostByUid(env, "sellerA");
    const r: any = await startMerchCheckout(env, { uid: "buyer", product, host, colour: "Black", size: "M", qty: 1, address: ADDR, saveAddress: false, method: "wallet", requestKey: "single-key-123", client: "web" });
    expect(r.ok).toBe(true);
    expect(r.order).toMatchObject({ pay_status: "confirmed", amount_paise: 40000, request_key: "single-key-123" });
    expect(JSON.parse(r.order.merch_json).groupId).toBeUndefined();
    expect(rows()).toHaveLength(1);
  });
});
