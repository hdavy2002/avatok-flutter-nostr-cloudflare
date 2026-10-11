// @ts-nocheck -- uses node:sqlite via the D1 shim
// [HF-TOK-PLAY-1] Purchase verify / credit / consume / refund / cron, against real SQL (node:sqlite) and a fake Play API (mocked fetch).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const topup = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("./hf_topup_notify", () => ({ notifyTopupCredited: async (_e: any, n: any) => { topup.calls.push(n); return { whatsapp: "sent", email: "queued" }; } }));
import { makePlayWorld, makeEnv, CFG } from "./hf_play_testkit";
import { processPlayPurchase, applyPlayRefund, runPlayCron, accountHashFor, rememberAccount, ackAndConsume } from "./hf_play";
import { balanceSummary, hasOpenDebt, getLots, settleCall } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

let world: any, env: any;
const count = (sql: string, ...a: unknown[]) => env.DB_META._raw.prepare(sql).get(...a).n;
const row = (token: string) => env.DB_META._raw.prepare("SELECT * FROM hf_play_purchases WHERE purchase_token=?").get(token);
const events = (name: string) => env._events.filter((e: any) => e.event === name);
const TOK = (n: number) => `purchase-token-${n}-abcdefghij`;

async function buyFor(uid: string, n: number, o: any = {}) {
  const hash = await accountHashFor(env, uid);
  await rememberAccount(env, uid, hash);
  world.buy(TOK(n), { obfuscated: hash, ...o });
  return TOK(n);
}
const verify = (uid: string, token: string, productId = "hf_tokens_100", cfg = CFG) => processPlayPurchase(env, cfg, { productId, purchaseToken: token, uid, source: "verify" });

beforeEach(() => {
  world = makePlayWorld(); env = makeEnv();
  vi.stubGlobal("fetch", world.fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("verify + credit", () => {
  it("[HF-TOPUP-NOTIFY-1] tells the buyer once per payment, whichever path credits it", async () => {
    topup.calls.length = 0;
    const t = await buyFor("u1", 901);
    await verify("u1", t);
    await verify("u1", t);
    await processPlayPurchase(env, CFG, { productId: "hf_tokens_100", purchaseToken: t, source: "rtdn" });
    expect(topup.calls).toHaveLength(1);
    expect(topup.calls[0]).toMatchObject({ uid: "u1", orderId: `GPA.${t}`, paidPaise: 12000 });
    expect(topup.calls[0].creditPaise).toBeGreaterThan(0);
  });

  it("happy path: one lot at the pack's value, paid from Play's rupee price, acknowledged and consumed", async () => {
    const t = await buyFor("u1", 1);
    const r = await verify("u1", t);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("consumed");
    expect(r.duplicate).toBe(false);
    expect(r.tokensMicro).toBe(102 * MICRO); // hf_tokens_100 is the Rs 120 pack = Rs 102 in the wallet (102 units)
    expect(r.paidPaise).toBe(12000);
    const lots = await getLots(env, "u1");
    expect(lots.length).toBe(1);
    expect(lots[0]).toMatchObject({ kind: "purchase", valuePaisePerToken: 100, pricingVersion: "gp-r1", leftMicro: 102 * MICRO, paidPaise: 12000, provider: "google_play", providerRef: "GPA." + t });
    expect(row(t).state).toBe("consumed");
    expect(row(t).lot_id).toBe(lots[0].id);
    expect(world.calls.filter((c: string) => c.includes(":acknowledge")).length).toBe(1);
    expect(world.calls.filter((c: string) => c.includes(":consume")).length).toBe(1);
    expect(events("hf_token_purchase_verified")[0].props).toMatchObject({ tokens: 102, paid_paise: 12000, duplicate: false });
  });

  it("falls back to the catalogue price when Play reports no rupee price", async () => {
    const t = await buyFor("u1", 1, { priceMicros: undefined });
    expect((await verify("u1", t)).paidPaise).toBe(12036) // approximate fallback: 102 x 118 paise;
  });

  it("the same purchase three times (verify, notification, cron) is ONE lot and one ledger row", async () => {
    const t = await buyFor("u1", 1);
    const a = await verify("u1", t);
    const b = await processPlayPurchase(env, CFG, { productId: "hf_tokens_100", purchaseToken: t, source: "rtdn" });
    const c = await processPlayPurchase(env, CFG, { productId: "hf_tokens_100", purchaseToken: t, uid: "u1", source: "cron" });
    for (const x of [a, b, c]) expect(x.ok).toBe(true);
    expect(b.duplicate).toBe(true); expect(c.duplicate).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE kind='purchase'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM hf_play_purchases")).toBe(1);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(102 * MICRO);
    expect(events("hf_token_purchase_verified").map((e: any) => e.props.duplicate)).toEqual([false, true, true]);
  });

  it("a purchase made by another account is rejected and credits nothing", async () => {
    const t = await buyFor("u1", 1);
    const r = await verify("u2", t); // u2 sends u1's token
    expect(r).toMatchObject({ ok: false, code: "account_mismatch", httpStatus: 403 });
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM hf_play_purchases")).toBe(0);
    expect(events("hf_token_purchase_failed")[0].props.reason).toBe("account_mismatch");
  });

  it("a purchase with no account id at all is rejected", async () => {
    world.buy(TOK(1), { obfuscated: undefined });
    expect((await verify("u1", TOK(1))).code).toBe("account_mismatch");
  });

  it("unknown or inactive products are rejected before Play is called", async () => {
    const t = await buyFor("u1", 1, { sku: "hf_tokens_bogus" });
    expect((await verify("u1", t, "hf_tokens_bogus")).code).toBe("unknown_product");
    env.DB_META._raw.exec("UPDATE hf_token_products SET active=0 WHERE product_id='hf_tokens_200'");
    const t2 = await buyFor("u1", 2, { sku: "hf_tokens_200" });
    expect((await verify("u1", t2, "hf_tokens_200")).code).toBe("unknown_product");
    expect(world.calls.length).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
  });

  it("refuses when tokens are disabled or the provider is not google_play", async () => {
    const t = await buyFor("u1", 1);
    expect((await verify("u1", t, "hf_tokens_100", { ...CFG, enabled: false })).code).toBe("disabled");
    expect((await verify("u1", t, "hf_tokens_100", { ...CFG, provider: "none" })).code).toBe("disabled");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
  });

  it("fails closed when the account salt is not configured", async () => {
    const t = await buyFor("u1", 1);
    delete env.HF_PLAY_ACCOUNT_SALT;
    expect((await verify("u1", t)).code).toBe("unconfigured");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
  });

  it("Play being down is transient: nothing credited, retry later", async () => {
    const t = await buyFor("u1", 1);
    world.flags.down = true;
    const r = await verify("u1", t);
    expect(r).toMatchObject({ ok: false, code: "unavailable", transient: true });
    world.flags.down = false;
    expect((await verify("u1", t)).ok).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
  });

  it("an unrecognised token is a clean 400", async () => {
    const r = await verify("u1", TOK(99));
    expect(r).toMatchObject({ ok: false, code: "invalid_purchase", httpStatus: 400, transient: false });
  });
});

describe("pending purchases", () => {
  it("pending stores a row and credits nothing; the later purchased state credits once", async () => {
    const t = await buyFor("u1", 1, { purchaseState: 2, orderId: undefined });
    const r = await verify("u1", t);
    expect(r).toMatchObject({ ok: true, status: "pending" });
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
    expect(row(t).state).toBe("pending");
    expect(row(t).order_id.startsWith("pending:")).toBe(true);
    // the buyer completes the payment
    world.purchases.get(t).purchaseState = 0; world.purchases.get(t).orderId = "GPA.REAL-1";
    const r2 = await verify("u1", t);
    expect(r2).toMatchObject({ ok: true, status: "consumed", duplicate: false, orderId: "GPA.REAL-1" });
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
    expect(row(t).order_id).toBe("GPA.REAL-1");
  });

  it("the cron credits a pending purchase that completed while the app was closed", async () => {
    const t = await buyFor("u1", 1, { purchaseState: 2, orderId: undefined });
    await verify("u1", t);
    world.purchases.get(t).purchaseState = 0; world.purchases.get(t).orderId = "GPA.REAL-2";
    env.DB_META._raw.exec("UPDATE hf_play_purchases SET created_at=created_at-600000");
    const r = await runPlayCron(env, CFG);
    expect(r.rechecked).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
    expect(row(t).state).toBe("consumed");
  });

  it("a pending purchase that is canceled never credits", async () => {
    const t = await buyFor("u1", 1, { purchaseState: 2, orderId: undefined });
    await verify("u1", t);
    world.purchases.get(t).purchaseState = 1;
    expect(await verify("u1", t)).toMatchObject({ ok: true, status: "canceled" });
    expect(row(t).state).toBe("revoked");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(0);
  });
});

describe("acknowledge + consume", () => {
  it("a consume failure keeps the credit (state credited) and the cron retries it", async () => {
    const t = await buyFor("u1", 1);
    world.flags.failConsume = true;
    const r = await verify("u1", t);
    expect(r).toMatchObject({ ok: true, status: "credited" });
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(102 * MICRO);
    expect(row(t).state).toBe("credited");
    // too fresh for the retry
    expect((await runPlayCron(env, CFG)).consumeRetried).toBe(0);
    env.DB_META._raw.exec("UPDATE hf_play_purchases SET created_at=created_at-600000");
    world.flags.failConsume = false;
    const c = await runPlayCron(env, CFG);
    expect(c).toMatchObject({ consumeRetried: 1, consumed: 1 });
    expect(row(t).state).toBe("consumed");
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
  });

  it("an acknowledge failure also keeps the credit and is retried", async () => {
    const t = await buyFor("u1", 1);
    world.flags.failAck = true;
    expect((await verify("u1", t)).status).toBe("credited");
    world.flags.failAck = false;
    expect(await ackAndConsume(env, CFG.playPackageId, row(t))).toBe(true);
    expect(row(t).state).toBe("consumed");
  });

  it("a half-credited row (crash before the lot) is resumed by the cron without a second lot", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    // simulate the crash: row back to verified
    env.DB_META._raw.exec("UPDATE hf_play_purchases SET state='verified', created_at=created_at-600000");
    world.purchases.get(t).consumptionState = 0;
    await runPlayCron(env, CFG);
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
    expect(row(t).state).toBe("consumed");
  });
});

describe("refunds", () => {
  it("voided before any spend: the lot is removed and there is no debt", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    const r = await applyPlayRefund(env, "GPA." + t, "rtdn");
    expect(r).toMatchObject({ found: true, applied: true, debtValuePaise: 0, removedMicro: 102 * MICRO });
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
    expect(await hasOpenDebt(env, "u1")).toBe(false);
    expect(row(t).state).toBe("refunded");
    expect(env.DB_META._raw.prepare("SELECT status FROM hf_token_lots").get().status).toBe("revoked");
    expect(events("hf_token_refund_applied")[0].props).toMatchObject({ debt_paise: 0, source: "rtdn" });
  });

  it("applied once: the same refund again changes nothing", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    await applyPlayRefund(env, "GPA." + t, "rtdn");
    const again = await applyPlayRefund(env, "GPA." + t, "voided_sweep");
    expect(again).toMatchObject({ found: true, applied: false, duplicate: true });
    expect(count("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE kind='refund_revoke'")).toBe(1);
    expect(events("hf_token_refund_applied").length).toBe(1);
  });

  it("voided after partial spend: unspent removed, spent part becomes a debt, calls blocked, host ledger untouched", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    const s = await settleCall(env, "u1", "call1", 2000, 148); // Rs 20/min for 148 s = Rs 49.33 = 49.33 units at Rs 1
    expect(s.ok).toBe(true);
    const r = await applyPlayRefund(env, "GPA." + t, "voided_sweep");
    expect(r.applied).toBe(true);
    expect(r.debtMicro).toBeGreaterThan(49 * MICRO);
    expect(r.debtMicro).toBeLessThan(50 * MICRO);
    expect(r.debtValuePaise).toBeGreaterThan(4900);
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM hf_host_ledger")).toBe(0);
    expect(events("hf_token_refund_applied")[0].props.debt_paise).toBe(r.debtValuePaise);
  });

  it("the next purchase clears the debt first", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    await settleCall(env, "u1", "call1", 2000, 148);
    const debt = (await applyPlayRefund(env, "GPA." + t, "rtdn")).debtValuePaise;
    expect(await hasOpenDebt(env, "u1")).toBe(true);
    const t2 = await buyFor("u1", 2);
    const r = await verify("u1", t2);
    expect(r.ok).toBe(true);
    expect(await hasOpenDebt(env, "u1")).toBe(false);
    const bal = await balanceSummary(env, "u1");
    // Rs 102 bought, the Rs 49.33 debt (4,933 paise) cleared first: about Rs 52.67 left
    expect(bal.totalMicro).toBeGreaterThan(52 * MICRO);
    expect(bal.totalMicro).toBeLessThan(53 * MICRO);
    expect(debt).toBeGreaterThan(0);
  });

  it("a void that arrives before the credit finishes revokes the row so it is never credited", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    // a second, never-credited purchase that is voided while pending
    const t2 = await buyFor("u1", 2, { purchaseState: 2, orderId: undefined });
    await verify("u1", t2);
    const r = await applyPlayRefund(env, null, "rtdn", t2);
    expect(r).toMatchObject({ found: true, applied: true });
    expect(row(t2).state).toBe("revoked");
    world.purchases.get(t2).purchaseState = 0; world.purchases.get(t2).orderId = "GPA.LATE";
    expect(await verify("u1", t2)).toMatchObject({ ok: true, status: "refunded" });
    expect(count("SELECT COUNT(*) AS n FROM hf_token_lots")).toBe(1);
  });

  it("the voided-purchases sweep refunds what Play lists and advances its cursor", async () => {
    const t = await buyFor("u1", 1);
    await verify("u1", t);
    world.voided.push({ purchaseToken: t, orderId: "GPA." + t, productId: "hf_tokens_100", voidedTimeMillis: String(Date.now()), voidedReason: 0 });
    const r = await runPlayCron(env, CFG);
    expect(r).toMatchObject({ swept: true, voidedScanned: 1, refundsApplied: 1 });
    expect(row(t).state).toBe("refunded");
    expect(env._kv.get("hf_play_void_sweep")).toBeTruthy();
    // within the hour: no second sweep
    expect((await runPlayCron(env, CFG)).swept).toBe(false);
  });

  it("the cron does nothing (no Play calls) when no purchase row exists", async () => {
    const r = await runPlayCron(env, CFG);
    expect(r).toMatchObject({ swept: false, consumeRetried: 0 });
    expect(world.calls.length).toBe(0);
  });
});
