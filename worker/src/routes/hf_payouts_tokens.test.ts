// @ts-nocheck -- uses node:sqlite via the shim
// [HF-TOK-CALLS-1] Route-level payouts with hfTokensEnabled ON: the host INR ledger (paise) holds the money, the WalletDO is never touched
// for new requests, requests stay whole rupees >= Rs 500, and a request made before the flag flip still releases through the wallet.
import { describe, it, expect, beforeEach, vi } from "vitest";

const walletCalls: string[] = [];
vi.mock("./wallet", () => ({
  walletOp: async (_e: any, _u: string, op: any) => { walletCalls.push(op.op); return { status: 200, body: { ok: true, balance: 0, held: 0, consumed: 0 } }; },
}));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: currentUid }), isFail: (x: any) => x.error !== undefined }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin1" }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfPayoutsEnabled: true, hfPayoutMinRupees: 500, hfPayoutMaxPerWeek: 2, hfTokensEnabled: true }) }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../lib/pii_crypto", () => ({ tryDecryptPii: async (_e: any, v: string | null) => (v ? `dec(${v})` : null) }));
const idem = new Map<string, Response>();
vi.mock("../money", () => ({
  rateLimit: async () => null,
  withIdempotency: async (req: Request, _e: any, uid: string, fn: () => Promise<Response>) => {
    const key = req.headers.get("idempotency-key");
    if (!key) return new Response("{}", { status: 400 });
    const k = `${uid}:${key}`;
    if (idem.has(k)) return idem.get(k)!.clone();
    const res = await fn();
    idem.set(k, res.clone());
    return res;
  },
}));
let currentUid = "host1";

import { hfPayoutsRoute } from "./hf_payouts";
import { makeDb } from "../lib/hf_token_d1_shim";
import { creditCallEarning, hostSummary, HOST_HOLD_MS } from "../lib/hf_host_ledger";

const NOW = Date.now();
let db: any, env: any;
beforeEach(() => {
  idem.clear(); walletCalls.length = 0; currentUid = "host1";
  db = makeDb(["2026-10-09-hf-payouts.sql", "2026-10-10-hf-tokens.sql"]);
  db._raw.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT, display_name TEXT, slug TEXT);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, verified_at INTEGER);
    CREATE TABLE hf_payout (uid TEXT PRIMARY KEY, upi_enc TEXT, upi_verified INTEGER DEFAULT 0, account_enc TEXT, account_last4 TEXT, ifsc TEXT, name_at_bank_enc TEXT, name_match INTEGER DEFAULT 0);
    INSERT INTO hf_hosts VALUES ('host1','live','Asha','asha'); INSERT INTO hf_kyc VALUES ('host1', 1);
    INSERT INTO hf_payout VALUES ('host1','u','1','acc','1234','HDFC0001','nm',1);`);
  env = { DB_META: db, DB_WALLET: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } };
});
const hit = async (method: string, path: string, body?: unknown, key?: string) => {
  const r = await hfPayoutsRoute(new Request(`https://x${path}`, { method, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, path);
  return { ...(await r!.json()), code: r!.status };
};
const earn = (paise: number, id = "c1") => creditCallEarning(env, "host1", id, paise, "call_earning", NOW - HOST_HOLD_MS - 1000);

describe("token-mode payouts", () => {
  it("GET shows INR paise fields from the host ledger and never reads the wallet", async () => {
    await earn(150056);
    await creditCallEarning(env, "host1", "c2", 3000, "call_earning", NOW); // still in the hold
    await creditCallEarning(env, "host1", "c3", 700, "call_earning_test", NOW);
    const g = await hit("GET", "/api/hosts/me/payouts");
    expect(g).toMatchObject({ withdrawable: 1500, withdrawablePaise: 150056, pendingPaise: 3000, testEarningsPaise: 700, totalEarnedPaise: 153056 });
    expect(walletCalls).toEqual([]);
  });

  it("request: whole rupees, reserved in paise, wallet untouched; a second one that does not fit is refused", async () => {
    await earn(150056);
    const a = await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k1");
    expect(a).toMatchObject({ ok: true, status: "requested", amount: 600 });
    const row = db._raw.prepare("SELECT wallet_ref, amount_rupees FROM hf_payout_requests").get();
    expect(row.wallet_ref).toMatch(/^hfhl:/);
    expect((await hostSummary(env, "host1", NOW)).availablePaise).toBe(90056);
    const b = await hit("POST", "/api/hosts/me/payouts", { amount: 901 }, "k2");
    expect(b.code).toBe(402);
    expect(b.error).toBe("insufficient_withdrawable");
    expect(walletCalls).toEqual([]);
    expect((await hostSummary(env, "host1", NOW)).availablePaise).toBe(90056);
  });

  it("below Rs 500 and fractional amounts are refused", async () => {
    await earn(150056);
    expect((await hit("POST", "/api/hosts/me/payouts", { amount: 499 }, "a")).error).toBe("below_minimum");
    expect((await hit("POST", "/api/hosts/me/payouts", { amount: 600.5 }, "b")).error).toBe("invalid_amount");
  });

  it("only matured earnings can be requested", async () => {
    await creditCallEarning(env, "host1", "c1", 200000, "call_earning", NOW);
    const r = await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "a");
    expect(r.code).toBe(402);
  });

  it("host cancel returns the reserve; admin approve + paid freezes it, no wallet involved", async () => {
    await earn(150056);
    const a = await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k1");
    expect((await hit("POST", `/api/hosts/me/payouts/${a.id}/cancel`)).code).toBe(200);
    expect((await hostSummary(env, "host1", NOW)).availablePaise).toBe(150056);
    const b = await hit("POST", "/api/hosts/me/payouts", { amount: 700 }, "k2");
    currentUid = "admin1";
    expect((await hit("POST", `/api/admin/hf/payouts/${b.id}/approve`)).code).toBe(200);
    expect((await hit("POST", `/api/admin/hf/payouts/${b.id}/paid`, { utr: "UTR123456" })).code).toBe(200);
    expect(db._raw.prepare("SELECT status FROM hf_payout_requests WHERE id=?").get(b.id).status).toBe("paid");
    expect((await hostSummary(env, "host1", NOW)).availablePaise).toBe(80056);
    expect(walletCalls).toEqual([]);
  });

  it("admin reject gives the money back", async () => {
    await earn(150056);
    const a = await hit("POST", "/api/hosts/me/payouts", { amount: 600 }, "k1");
    currentUid = "admin1";
    expect((await hit("POST", `/api/admin/hf/payouts/${a.id}/reject`, { reason: "bank mismatch" })).code).toBe(200);
    expect((await hostSummary(env, "host1", NOW)).availablePaise).toBe(150056);
  });

  it("a request made on the old wallet path before the flag flip is still released through the wallet", async () => {
    db._raw.prepare("INSERT INTO hf_payout_requests (id, host_uid, amount_rupees, status, wallet_ref, created_at, updated_at) VALUES ('legacy-req1','host1',600,'requested','hfpayout:legacy-req1',?,?)").run(NOW, NOW);
    expect((await hit("POST", "/api/hosts/me/payouts/legacy-req1/cancel")).code).toBe(200);
    expect(walletCalls).toEqual(["release_reservation"]);
  });
});
