// @ts-nocheck -- uses node:sqlite via the shim

// [HF-TOK-EXIT-1] Admin account deletion goes through the same pay-out-first logic: 409 money_remains unless force + a note (audit logged).
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg = vi.hoisted(() => ({ tokens: true }));
vi.mock("./config", () => ({ readConfig: async () => ({ hfTokensEnabled: cfg.tokens, hfExitGateEnabled: true, hfRefundWindowDays: 180 }) }));
vi.mock("./wallet", () => ({ walletOp: async () => ({ status: 200, body: { balance: 0, held: 0 } }) }));
vi.mock("../lib/pii_crypto", () => ({ tryDecryptPii: async () => null }));
vi.mock("../hooks", () => ({ track: () => {}, trackException: async () => {} }));
vi.mock("../lib/hf_credits", () => ({ getTestBalance: async () => ({ balance: 0, reserved: 0 }) }));
vi.mock("../lib/payments/registry", () => ({ resolveGateway: () => null }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => null }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async () => ({ ok: true }) }));
vi.mock("../auth", () => ({ setVerifiedCache: async () => {} }));
vi.mock("../db/shard", () => ({ metaDb: (env: any) => env.DB_META }));
vi.mock("./admin_money", () => ({ requireAdmin: async () => ({ uid: "adm" }) }));
vi.mock("../sentinel/purge", () => ({ enqueueMem0Purge: async () => {} }));
vi.mock("./account", () => ({ enqueueDeletion: async () => {} }));

import { makeDb } from "../lib/hf_token_d1_shim";
import { creditLot } from "../lib/hf_token_ledger";
import { adminDeleteUser } from "./admin_delete_user";
import { MICRO } from "../lib/hf_token_math";

const MIGS = [
  "2026-10-10-hf-tokens.sql", "2026-10-09-hf-hosts.sql", "2026-10-09-hf-calls.sql", "2026-10-09-hf-credits.sql", "2026-10-09-hf-payouts.sql",
  "2026-10-09-hf-host-kyc.sql", "2026-10-10-hf-calls-token-snapshot.sql", "2026-10-09-hf-topups.sql", "2026-10-10-hf-wallet-exit.sql", "2026-10-10-hf-tok-exit-alters.sql",
];
let env: any;
const req = (body: any) => new Request("https://x.test/api/admin/delete-user/s3cret", { method: "POST", body: JSON.stringify(body) });
const delRows = () => env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM deletion_requests").get().n;

beforeEach(() => {
  cfg.tokens = true;
  env = { DB_META: makeDb(MIGS, { alters: true }), DB_WALLET: makeDb([]), ADMIN_DELETE_SECRET: "s3cret", ADMIN_UIDS: "adm" };
  env.DB_META._raw.exec("CREATE TABLE deletion_requests (uid TEXT PRIMARY KEY, clerk_user_id TEXT, pubkey_hex TEXT, requested_at INTEGER, scheduled_at INTEGER, processed_at INTEGER, status TEXT)");
  env.DB_WALLET._raw.exec("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER)");
});

const buy = () => creditLot(env, "u1", { kind: "purchase", pricingVersion: "gp-v1", valuePaisePerToken: 82, micro: 100 * MICRO, paidPaise: 10000, provider: "google_play", providerRef: "GPA.1" }, "GPA.1");

describe("admin delete with tokens", () => {
  it("refuses while money remains, deleting nothing", async () => {
    await buy();
    const r = await adminDeleteUser(req({ uid: "u1" }), env, "s3cret");
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.error).toBe("money_remains");
    expect(delRows()).toBe(0);
  });

  it("force needs a real note; with one it deletes and writes an audit row", async () => {
    await buy();
    const weak = await adminDeleteUser(req({ uid: "u1", force: true, note: "ok" }), env, "s3cret");
    expect(weak.status).toBe(409);
    const r = await adminDeleteUser(req({ uid: "u1", force: true, note: "legal order 123" }), env, "s3cret");
    expect(r.status).toBe(200);
    expect(delRows()).toBe(1);
    const a = env.DB_WALLET._raw.prepare("SELECT * FROM admin_audit").all();
    expect(a.length).toBe(1);
    expect(a[0].action).toBe("admin_delete_user_force_money");
    expect(a[0].target).toBe("u1");
  });

  it("refuses while the user is on a call even with no money", async () => {
    env.DB_META._raw.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at) VALUES ('c1','u1','h1',2000,'connected',?)").run(Date.now());
    const r = await adminDeleteUser(req({ uid: "u1" }), env, "s3cret");
    expect(r.status).toBe(409);
    expect((await r.json()).activeCall).toBe(true);
  });

  it("a user with nothing to settle is deleted as before", async () => {
    const r = await adminDeleteUser(req({ uid: "nobody" }), env, "s3cret");
    expect(r.status).toBe(200);
    expect(delRows()).toBe(1);
  });

  it("flag OFF: behaves exactly as before, money or not", async () => {
    cfg.tokens = false;
    await buy();
    const r = await adminDeleteUser(req({ uid: "u1" }), env, "s3cret");
    expect(r.status).toBe(200);
    expect(delRows()).toBe(1);
  });
});
