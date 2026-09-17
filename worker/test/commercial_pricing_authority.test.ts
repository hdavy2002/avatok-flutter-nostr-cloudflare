import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commercialQuoteFor, commercialQuoteError, roundMoneyRatio } from "../src/lib/session_pricing";
import { DEFAULTS } from "../src/routes/config";
import type { Env } from "../src/types";
import {
  quoteCommercialPurchase, freezeCommercialPurchaseQuote, loadCommercialPurchaseQuote,
  provisionCommercialPurchase, provisionFromGatewayPurchase,
} from "../src/routes/commercial_checkout";
import { partialRefundSplit } from "../src/commercial_settlement";
import { executeCommercialRefund, refundRailFor } from "../src/lib/commercial_refund_rail";

vi.mock("../src/lib/commercial_telemetry", () => ({ commercialEvent: vi.fn() }));
vi.mock("../src/ledger", async (original) => ({
  ...await original<typeof import("../src/ledger")>(),
  refund: vi.fn(async () => ({ ok: true })),
  refundExternal: vi.fn(async () => ({ ok: true })),
}));

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => any;
};
const migration = (name: string) => readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
const databases: any[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.clearAllMocks(); });

// D1's numbered bind parameters mapped onto node:sqlite named parameters.
function d1(db: any): any {
  return {
    prepare(sql: string) {
      const used = new Set<number>();
      const named = sql.replace(/\?(\d+)/g, (_, n) => { used.add(Number(n)); return `$p${n}`; });
      let params: Record<string, unknown> = {};
      const stmt = {
        bind(...values: unknown[]) {
          params = Object.fromEntries([...used].map(i => [`p${i}`, values[i - 1] ?? null]));
          return stmt;
        },
        async first() { return db.prepare(named).get(params) ?? null; },
        async all() { return { results: db.prepare(named).all(params) }; },
        async run() { return { meta: { changes: Number(db.prepare(named).run(params).changes) } }; },
      };
      return stmt;
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try { const out = []; for (const stmt of statements) out.push(await stmt.run()); db.exec("COMMIT"); return out; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

function setup() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(migration("2026-08-25-commercial-consult-extensions.sql"));
  // A legacy quote must survive the additive migration without a new pricing payload.
  db.exec(`INSERT INTO commercial_consult_extensions VALUES (
    'legacy','s','b','l','base','extension','buyer','creator',100,200,10,2,20,'INR','old',
    'proposed',NULL,NULL,NULL,NULL,1,1);
    CREATE TABLE commercial_policy_snapshots(order_id TEXT PRIMARY KEY,buyer_id TEXT,gross_amount INTEGER,gst_amount INTEGER);
    CREATE TABLE commercial_checkout_operations(operation_id TEXT PRIMARY KEY,account_id TEXT,state TEXT,response_json TEXT,updated_at INTEGER);
    CREATE TABLE direct_purchases(purchase_id TEXT PRIMARY KEY,order_id TEXT,gateway_order_id TEXT,status TEXT);
    CREATE TABLE gateway_orders(order_id TEXT PRIMARY KEY,gateway TEXT,gateway_order_id TEXT,status TEXT);
  `);
  db.exec(migration("2026-09-17-commercial-pricing-quotes.sql"));
  return { db, env: { DB_META: d1(db) } as Env };
}

function purchase(rail: "wallet" | "cashfree" | "razorpay" | "paytm" = "wallet") {
  return quoteCommercialPurchase({
    buyerId: "buyer", kind: "live_event", bookingId: null, rail,
    listing: {
      id: "listing", creator_id: "creator", kind: "live_event", title: "Session", status: "published",
      price: 600, duration_min: 30, starts_at: Date.now() + 86_400_000, capacity: 25,
      currency_display: "INR", attrs: "{}", free_entry: 0,
    },
    config: { ...DEFAULTS, sessionFeeRuleEnabled: true, gstEnabled: true, gstRatePct: 18 },
    sourcePrice: 600, slotStart: null, slotEnd: null,
  });
}

describe("authoritative commercial INR quote", () => {
  it.each([[1, 2], [15, 25], [30, 50], [45, 75], [60, 100], [90, 150], [120, 200]])(
    "%i minutes charges a %i rupee platform fee per paid seat", (minutes, fee) => {
      const q = commercialQuoteFor({ sourcePrice: 600, bookedMinutes: minutes, gstRatePct: 18 });
      expect(q.platformFeeAmount).toBe(fee);
      expect(q.creatorAmount).toBe(minutes * 10);
      expect(q.grossAmount).toBe(q.creatorAmount + fee);
      expect(q.buyerTotal).toBe(q.grossAmount + q.gstAmount);
      expect(commercialQuoteError(q)).toBeNull();
    },
  );

  it("rounds half up, per customer seat, without charging host/capacity seats", () => {
    expect(roundMoneyRatio(49, 30, 60)).toBe(25);
    const q = commercialQuoteFor({ sourcePrice: 49, bookedMinutes: 1, paidSeats: 3, gstRatePct: 0 });
    expect(q.platformFeePerSeat).toBe(2);
    expect(q.platformFeeAmount).toBe(6); // Not round(100 * 3 / 60) == 5.
    expect(q.creatorAmount).toBe(3);
    expect(purchase().pricing).toMatchObject({ paidSeats: 1, seatBasis: "paid_customer_seat", platformFeeAmount: 50 });
  });

  it("itemizes the buyer total and records duration, version and integer unit", () => {
    expect(purchase().pricing).toMatchObject({
      pricingVersion: "commercial-inr-100-hour-v1", bookedMinutes: 30,
      moneyUnit: "whole_inr", priceBasis: "hourly", feePolicy: "creator_subtotal_plus_fee",
      creatorSubtotal: 300, platformFeeAmount: 50, taxableBase: 350, gstAmount: 63, buyerTotal: 413,
    });
  });

  it("keeps zero-priced/free sessions free and supports the existing percentage policy", () => {
    expect(commercialQuoteFor({ sourcePrice: 0, bookedMinutes: 30, gstRatePct: 18 })).toMatchObject({
      paidSeats: 0, creatorAmount: 0, platformFeeAmount: 0, gstAmount: 0, buyerTotal: 0,
    });
    const oldPolicy = commercialQuoteFor({ sourcePrice: 600, bookedMinutes: 30,
      gstRatePct: 18, feePolicy: "legacy_percentage", creatorFeePct: 80 });
    expect(oldPolicy).toMatchObject({ grossAmount: 600, creatorAmount: 480, platformFeeAmount: 120, buyerTotal: 708 });
    expect(commercialQuoteError(oldPolicy)).toBeNull();
  });

  it("supports a fee-included contract without a negative creator payout", () => {
    expect(commercialQuoteFor({ sourcePrice: 600, bookedMinutes: 30, gstRatePct: 0,
      feePolicy: "included_platform_fee" })).toMatchObject({ grossAmount: 300, creatorAmount: 250, platformFeeAmount: 50 });
    expect(() => commercialQuoteFor({ sourcePrice: 49, bookedMinutes: 30, gstRatePct: 0,
      feePolicy: "included_platform_fee" })).toThrow("below platform fee");
  });

  it("rejects fractional money, invalid duration/seat counts, currencies and overflow", () => {
    for (const override of [{ sourcePrice: 1.5 }, { bookedMinutes: 0 }, { bookedMinutes: 30.5 },
      { paidSeats: -1 }, { paidSeats: 0 }, { gstRatePct: NaN }, { currency: "USD" },
      { sourcePrice: Number.MAX_SAFE_INTEGER }]) {
      expect(() => commercialQuoteFor({ sourcePrice: 600, bookedMinutes: 30, gstRatePct: 18, ...override })).toThrow();
    }
    const q = purchase().pricing;
    expect(commercialQuoteError({ ...q, buyerTotal: q.buyerTotal + 1 })).not.toBeNull();
    expect(commercialQuoteError({ ...q, creatorAmount: 299.5 })).not.toBeNull();
    expect(commercialQuoteError({ ...q, bookedMinutes: 60 })).not.toBeNull();
  });

  it("prices an extension with the same hourly fee and independent tax snapshot", () => {
    const extension = commercialQuoteFor({ sourcePrice: 10 * 60, bookedMinutes: 15, gstRatePct: 18 });
    expect(extension).toMatchObject({ creatorAmount: 150, platformFeeAmount: 25, gstAmount: 32, buyerTotal: 207 });
  });
});

describe("frozen checkout authority and migration", () => {
  it.each(["wallet", "cashfree", "razorpay", "paytm"] as const)("%s reuses the quote across price, tax and policy changes", async rail => {
    const { db, env } = setup();
    const original = purchase(rail);
    await freezeCommercialPurchaseQuote(env, "order", original);
    const changed = { ...original, pricing: commercialQuoteFor({ sourcePrice: 900, bookedMinutes: 30, gstRatePct: 0 }),
      settlementHoldHours: 999, listing: { ...original.listing, price: 900 } };
    expect(await freezeCommercialPurchaseQuote(env, "order", changed)).toEqual(original);
    expect(await loadCommercialPurchaseQuote(env, "order")).toEqual(original);
    const fund = vi.fn(async () => ({ ok: false, status: 402, duplicate: false }));
    const response = await provisionCommercialPurchase(env, {
      auth: { uid: "buyer" }, route: { kind: "live_event" }, listing: changed.listing,
      config: { ...DEFAULTS, gstEnabled: false }, policy: changed.policy,
      price: changed.pricing.grossAmount, tax: changed.pricing, purchaseQuote: changed,
      startsAt: changed.startsAt, endsAt: changed.endsAt, slotStart: null, slotEnd: null,
      orderId: "order", operationId: "op", bookingId: null, requestHash: "hash",
      funding: { rail, fund, reverse: vi.fn() },
    });
    expect(response.status).toBe(402);
    expect(fund).toHaveBeenCalledTimes(1);
    expect(fund).toHaveBeenCalledWith(413);
    expect(db.prepare("SELECT COUNT(*) n FROM commercial_pricing_quotes").get().n).toBe(1);
  });

  it("rejects quote ownership collisions and database rewrites", async () => {
    const { db, env } = setup();
    const q = purchase();
    await freezeCommercialPurchaseQuote(env, "order", q);
    await expect(freezeCommercialPurchaseQuote(env, "order", { ...q, buyerId: "other" })).rejects.toThrow("authority mismatch");
    expect(() => db.prepare("UPDATE commercial_pricing_quotes SET quote_json='{}' WHERE order_id='order'").run()).toThrow("immutable");
    expect(db.prepare("SELECT amount,pricing_quote_json FROM commercial_consult_extensions WHERE extension_id='legacy'").get())
      .toMatchObject({ amount: 20, pricing_quote_json: null });
    db.prepare("UPDATE commercial_consult_extensions SET state='consented' WHERE extension_id='legacy'").run();
    expect(() => db.prepare("UPDATE commercial_consult_extensions SET amount=30 WHERE extension_id='legacy'").run()).toThrow("immutable");
  });

  it("never guesses prices for a pre-migration payment without a quote", async () => {
    const { env } = setup();
    const response = await provisionFromGatewayPurchase(env, {
      uid: "buyer", listingId: "listing", bookingId: null, kind: "live_event",
      purchaseId: "old", chargedTokens: 600, gatewayRef: "provider-order", gateway: "razorpay",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ review_pending: true });
  });
});

describe("commercial refunds conserve the frozen money", () => {
  it("conserves all legs for odd amounts and every refund percentage", () => {
    for (const minutes of [1, 15, 30, 59, 60, 90, 120]) {
      for (const sourcePrice of [1, 49, 99, 499, 600, 1001]) {
        const q = commercialQuoteFor({ sourcePrice, bookedMinutes: minutes, gstRatePct: 18 });
        for (let percent = 0; percent <= 100; percent++) {
          const r = partialRefundSplit(q.grossAmount, q.gstAmount, q.creatorAmount, q.platformFeeAmount, percent / 100);
          expect(r.refundable + r.consumedCreatorAmount + r.consumedPlatformAmount + r.consumedGstAmount).toBe(q.buyerTotal);
          expect(r.consumedCreatorAmount).toBeGreaterThanOrEqual(0);
          expect(r.consumedCreatorAmount).toBeLessThanOrEqual(q.creatorAmount);
          expect(r.consumedPlatformAmount).toBeGreaterThanOrEqual(0);
          expect(r.consumedPlatformAmount).toBeLessThanOrEqual(q.platformFeeAmount);
        }
      }
    }
    expect(() => partialRefundSplit(100, 18, 80, 19, 0.5)).toThrow();
    expect(() => partialRefundSplit(100, 18, 80, 20, NaN)).toThrow();
  });

  it("pins refund amount and refuses over-refunds or changed retries before ledger calls", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO commercial_policy_snapshots VALUES ('commercial-order:x','buyer',350,63)");
    const { refund } = await import("../src/ledger");
    const request = { orderId: "commercial-order:x", buyerId: "buyer", amount: 100, reason: "partial" };
    expect(await executeCommercialRefund(env, { ...request, amount: 414 })).toMatchObject({ ok: false });
    expect(refund).not.toHaveBeenCalled();
    expect(await executeCommercialRefund(env, request)).toMatchObject({ ok: true });
    expect(await executeCommercialRefund(env, { ...request, amount: 101 })).toMatchObject({ error: "refund_intent_mismatch" });
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("never turns a missing external rail into wallet credit and resolves generic Cashfree", async () => {
    const { db, env } = setup();
    db.exec("DROP TABLE direct_purchases");
    await expect(refundRailFor(env, "razorpay-order:missing")).rejects.toThrow();
    db.exec("INSERT INTO gateway_orders VALUES ('purchase','cashfree','provider-order','refunded')");
    expect(await refundRailFor(env, "cashfree-order:purchase")).toMatchObject({ rail: "cashfree", gatewayOrderId: "provider-order" });
  });
});
