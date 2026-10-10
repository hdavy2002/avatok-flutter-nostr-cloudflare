// @ts-nocheck -- uses node:sqlite via the shim

// [HF-TOK-EXIT-1] Purchase records, token reconciliation + invariants, purge / retention of token money records, low-balance push once per call.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const push = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./hf_push", () => ({ notifyLowBalance: async (_e: any, uid: string) => { push.calls.push(uid); } }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));

import { makeDb } from "./hf_token_d1_shim";
import { creditLot, reserveForCall } from "./hf_token_ledger";
import { settleTokenCall, maybeNotifyLowBalance } from "./hf_token_calls";
import { creditCallEarning } from "./hf_host_ledger";
import { issuePurchaseRecord, backfillPurchaseRecords, listReceipts, renderReceiptHtml, supplierFrom, tokenCallPlatformPaise } from "./hf_receipts";
import { loadTokenReconciliation, tokenReconciliationCsv, callSplitMismatches, testPartOfCall } from "./hf_reconcile_tokens";
import { purgeHfUser } from "./hf_purge";
import { runHfRetention, HF_RETENTION } from "./hf_retention";
import { MICRO } from "./hf_token_math";

const T = (n: number) => Math.round(n * MICRO);
const DAY = 86_400_000;
const MIGS = [
  "2026-10-10-hf-tokens.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql",
  "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-tok-exit-alters.sql", "2026-10-10-hf-wallet-limits.sql",
];
let env: any;
const raw = () => env.DB_META._raw;
beforeEach(() => { env = { DB_META: makeDb(MIGS, { alters: true }) }; push.calls.length = 0; });

const lot = (uid: string, kind: "purchase" | "test", tokens: number, v: number, op: string, paidRupees?: number) =>
  creditLot(env, uid, {
    kind, pricingVersion: v === 82 ? "gp-v1" : "pt-v1", valuePaisePerToken: v, micro: T(tokens),
    paidPaise: kind === "test" ? 0 : (paidRupees ?? tokens) * 100, provider: kind === "test" ? "admin" : "google_play", providerRef: op,
  }, op).then((r) => r.lotId as string);
const callRow = (id: string, caller: string, host: string, rate: number) =>
  raw().prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, call_cost_paise_per_min, host_share_bps, tax_mode, split_rule_version) VALUES (?,?,?,?, 'completed', ?, 200, 6000, 'none_unregistered', 'gp-v1/split-v1')")
    .run(id, caller, host, rate, Date.now());
const settle = async (id: string, caller: string, host: string, rate: number, secs: number) => {
  callRow(id, caller, host, rate);
  await reserveForCall(env, caller, id, rate, 3600);
  return settleTokenCall(env, { callId: id, callerUid: caller, hostUid: host, ratePaise: rate, callCostPaisePerMin: 200, hostShareBps: 6000, connectedSeconds: secs, maxSeconds: 3600, endedAt: Date.now() });
};

describe("purchase records", () => {
  it("one record per purchase lot, once, no GST, with order id and value per token", async () => {
    const id = await lot("u1", "purchase", 100, 82, "GPA.3300-1", 100);
    const row = raw().prepare("SELECT * FROM hf_token_lots WHERE id=?").get(id);
    const a = await issuePurchaseRecord(env, {}, row);
    const b = await issuePurchaseRecord(env, {}, row);
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_receipts WHERE source='play_purchase'").get().n).toBe(1);
    expect(a.kind).toBe("receipt");
    expect(a.gst_paise ?? null).toBe(null);
    const html = renderReceiptHtml(a, supplierFrom({}), null);
    expect(html).toContain("Purchase record");
    expect(html).toContain("paid via Google Play");
    expect(html).toContain("GPA.3300-1");
    expect(html).not.toMatch(/CGST|SGST|IGST/);
  });

  it("backfill gives earlier purchases their record, never test lots", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 100);
    await lot("u1", "purchase", 50, 82, "GPA.2", 50);
    await lot("u1", "test", 30, 100, "t1");
    await backfillPurchaseRecords(env, {}, "u1");
    await backfillPurchaseRecords(env, {}, "u1");
    expect((await listReceipts(env, "u1")).length).toBe(2);
  });

  it("platform share of a token-era call counts only the part paid with purchased tokens", () => {
    const lots_used = JSON.stringify([{ kind: "purchase", valuePaise: 3000 }, { kind: "test", valuePaise: 1000 }]);
    expect(tokenCallPlatformPaise({ platform_paise: 1000, consumed_value_paise: 4000, lots_used })).toBe(750);
    expect(tokenCallPlatformPaise({ platform_paise: 0, consumed_value_paise: 4000, lots_used })).toBe(0);
    expect(tokenCallPlatformPaise({ platform_paise: 1000, consumed_value_paise: 4000, lots_used: "not json" })).toBe(0);
  });
});

describe("token reconciliation", () => {
  const range = () => [Date.now() - DAY, Date.now() + DAY] as const;
  const seed = async () => {
    const l = await lot("u1", "purchase", 100, 82, "GPA.1", 100);
    raw().prepare("INSERT INTO hf_play_purchases (id, purchase_token, order_id, product_id, uid, state, lot_id, created_at) VALUES ('p1','tok','GPA.1','pack100','u1','credited',?,?)").run(l, Date.now());
    const o = await settle("c1", "u1", "h1", 2000, 60);
    await creditCallEarning(env, "h1", "c1", o.hostPaise, "call_earning", Date.now());
    return l;
  };

  it("a clean ledger has sections and no mismatches", async () => {
    await seed();
    await lot("u2", "test", 30, 100, "t1");
    const r = await loadTokenReconciliation(env, ...range());
    expect(r.mismatches).toEqual([]);
    expect(r.totals.purchases.count).toBe(1);
    expect(r.totals.purchases.paidPaise).toBe(10000);
    expect(r.totals.spent.calls).toBe(1);
    expect(r.totals.spent.consumedPaise).toBe(r.totals.spent.callCostPaise + r.totals.spent.hostPaise + r.totals.spent.platformPaise);
    expect(r.totals.testLots.grantedLots).toBe(1);
    const csv = tokenReconciliationCsv(r);
    expect(csv).toContain("purchases");
  });

  it("flags a lot whose balance is not granted - spent - revoked", async () => {
    const l = await seed();
    raw().prepare("UPDATE hf_token_lots SET tokens_left_micro = tokens_left_micro + 5000 WHERE id=?").run(l);
    const r = await loadTokenReconciliation(env, ...range());
    expect(r.mismatches.map((m) => m.kind)).toContain("lot_balance");
  });

  it("flags a call whose value is not cost + host + platform", async () => {
    await seed();
    raw().prepare("UPDATE hf_calls SET platform_paise = platform_paise + 1 WHERE id='c1'").run();
    const r = await loadTokenReconciliation(env, ...range());
    expect(r.mismatches.map((m) => m.kind)).toContain("call_split");
    expect(callSplitMismatches([{ id: "x", uid: "u", ts: 1, consumed_value_paise: 100, call_cost_paise: 10, host_earning_paise: 60, platform_paise: 30 }])).toEqual([]);
  });

  it("flags a host ledger that no longer matches the call, a purchase without a lot, and a negative host balance", async () => {
    await seed();
    raw().prepare("UPDATE hf_host_ledger SET amount_paise = amount_paise + 7 WHERE call_id='c1'").run();
    raw().prepare("INSERT INTO hf_play_purchases (id, purchase_token, order_id, product_id, uid, state, lot_id, created_at) VALUES ('p2','tok2','GPA.2','pack100','u1','credited',NULL,?)").run(Date.now());
    raw().prepare("INSERT INTO hf_host_ledger (id, host_uid, kind, amount_paise, op_id, created_at) VALUES ('x','h9','admin_adjust',-500,'op-x',?)").run(Date.now());
    const kinds = (await loadTokenReconciliation(env, ...range())).mismatches.map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(["host_earning_ledger", "purchase_without_lot", "host_balance_negative"]));
  });

  it("test part of a call is read from lots_used", () => {
    expect(testPartOfCall(JSON.stringify([{ kind: "test", micro: 5, valuePaise: 7 }, { kind: "purchase", micro: 9, valuePaise: 9 }]))).toEqual({ micro: 5, valuePaise: 7 });
    expect(testPartOfCall("bad")).toEqual({ micro: 0, valuePaise: 0 });
  });
});

describe("purge keeps hashed money records, drops test records", () => {
  it("test lots go; purchase lots, ledger, debts, purchases and host ledger keep a hashed uid", async () => {
    const real = await lot("userabc1", "purchase", 100, 82, "GPA.1", 100);
    const test = await lot("userabc1", "test", 30, 100, "t1");
    raw().prepare("INSERT INTO hf_play_purchases (id, purchase_token, order_id, product_id, uid, state, lot_id, created_at) VALUES ('p1','tok','GPA.1','pack100','userabc1','credited',?,?)").run(real, Date.now());
    raw().prepare("INSERT INTO hf_token_debts (id, uid, amount_micro, value_paise, source_order_id, status, created_at) VALUES ('d1','userabc1',1,1,'O','written_off',?)").run(Date.now());
    await creditCallEarning(env, "userabc1", "cx", 500, "call_earning", Date.now());
    await creditCallEarning(env, "userabc1", "cy", 300, "call_earning_test", Date.now());
    const res = await purgeHfUser(env, "userabc1", {});
    expect(res.errors).toEqual([]);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_lots WHERE id=?").get(test).n).toBe(0);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE lot_id=?").get(test).n).toBe(0);
    const kept = raw().prepare("SELECT uid FROM hf_token_lots WHERE id=?").get(real);
    expect(kept.uid.startsWith("del:")).toBe(true);
    expect(kept.uid).not.toContain("userabc1");
    for (const [t, col] of [["hf_token_ledger", "uid"], ["hf_token_debts", "uid"], ["hf_host_ledger", "host_uid"]]) {
      const u = raw().prepare(`SELECT DISTINCT ${col} AS u FROM ${t} WHERE ${col} IS NOT NULL`).all().map((x: any) => x.u);
      expect(u.every((x: string) => x.startsWith("del:"))).toBe(true);
    }
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_host_ledger WHERE kind='call_earning_test'").get().n).toBe(0);
    expect(raw().prepare("SELECT COUNT(*) AS n FROM hf_host_ledger WHERE kind='call_earning'").get().n).toBe(1);
    expect(raw().prepare("SELECT uid, raw FROM hf_play_purchases WHERE id='p1'").get().uid.startsWith("del:")).toBe(true);
    // idempotent
    const again = await purgeHfUser(env, "userabc1", {});
    expect(again.errors).toEqual([]);
  });

  it("the consumers copy is identical", () => {
    const a = readFileSync(new URL("./hf_purge.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("../../../consumers/src/hf_purge.ts", import.meta.url), "utf8");
    expect(b).toBe(a);
  });

  it("retention: money records are kept 8 years, hashed ones older than that are deleted", async () => {
    expect(HF_RETENTION.moneyDays).toBe(8 * 365);
    const old = Date.now() - (8 * 365 + 5) * DAY;
    raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES ('l1','del:aaa','purchase',NULL,1,1,'o1',?)").run(old);
    raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES ('l2','del:bbb','purchase',NULL,1,1,'o2',?)").run(Date.now() - 2 * 365 * DAY);
    raw().prepare("INSERT INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, op_id, created_at) VALUES ('l3','live_user','purchase',NULL,1,1,'o3',?)").run(old);
    env.TOKENS = { get: async () => null, put: async () => {} };
    await runHfRetention(env, { waitUntil: () => {} });
    const ids = raw().prepare("SELECT id FROM hf_token_ledger ORDER BY id").all().map((x: any) => x.id);
    expect(ids).toEqual(["l2", "l3"]);
  });
});

describe("low balance push", () => {
  it("fires once per call when less than 2 minutes remain at the host's rate, nothing when plenty is left", async () => {
    await lot("u1", "purchase", 100, 82, "GPA.1", 82); // Rs 82 of value; 2 min at Rs 20/min = Rs 40
    await settle("c1", "u1", "h1", 2000, 60); // spends ~Rs 20 -> Rs 62 left: still enough for 2 minutes
    expect(push.calls).toEqual([]);
    await lot("u2", "purchase", 100, 82, "GPA.2", 82);
    await settle("c2", "u2", "h1", 2000, 200); // 200 s at Rs 20/min = Rs 66.67 -> about Rs 15 left: low
    expect(push.calls).toEqual(["u2"]);
    // a retry of the same call sends nothing more
    expect(await maybeNotifyLowBalance(env, "u2", "c2", 2000, 200)).toBe(false);
    expect(push.calls).toEqual(["u2"]);
  });
});
