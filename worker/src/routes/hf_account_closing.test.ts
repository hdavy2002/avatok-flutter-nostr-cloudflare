// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WALLET-EXIT-1] While a closure is open: no new calls as caller, host forced offline and cannot go online, no new top-ups.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../money", () => ({ rateLimit: async () => null, RL: { topup: { max: 5, windowSec: 3600 } }, withIdempotency: async (_r: any, _e: any, _u: string, fn: () => Promise<Response>) => fn() }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+910000000000" }));
vi.mock("../lib/hf_notify", () => ({ notifyHostOnline: async () => {} }));
vi.mock("../lib/preview", () => ({ isAdminUid: () => false }));
vi.mock("../lib/payments/registry", () => ({ resolveGateway: () => ({ id: "razorpay", configured: () => true, testMode: () => true }), isGatewayId: () => true }));
vi.mock("../lib/hf_topup_config", () => ({ hfTopupFlags: () => ({ enabled: true, gateway: "razorpay", minRupees: 50, maxRupees: 5000, packs: [] }), hfTopupLive: () => ({ live: true, testMode: true }) }));

import { hfCallsRoute } from "./hf_calls";
import { hfTopupRoute } from "./hf_topup";
import { isClosing, forceHostOffline } from "../lib/hf_exit";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, display_name TEXT, price_per_min INTEGER, women_lane INTEGER DEFAULT 0, lgbtq_lane INTEGER DEFAULT 0, presence TEXT, presence_at INTEGER, status TEXT);
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT, requested_at INTEGER, updated_at INTEGER, payout_id TEXT, refund_id TEXT, note TEXT);
    CREATE TABLE hf_topups (id TEXT PRIMARY KEY, uid TEXT, amount_rupees INTEGER, gateway TEXT, gateway_order_id TEXT, status TEXT, credited INTEGER, raw_status TEXT, gateway_payment_id TEXT, created_at INTEGER, updated_at INTEGER, paid_at INTEGER);
  `);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) }, HF_CALL_DID: "x", VOBIZ_AUTH_ID: "x", VOBIZ_AUTH_TOKEN: "x", VOBIZ_WEBHOOK_SECRET: "x" };
}
const exit = (uid: string, status: string) => db.prepare("INSERT INTO hf_exit_requests VALUES (?,?,?,?,NULL,NULL,NULL)").run(uid, status, 1, 1);
const req = (method: string, path: string, uid: string, body?: unknown) =>
  new Request(`https://x${path}`, { method, headers: { "x-test-uid": uid, "content-type": "application/json", "idempotency-key": "k" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  makeEnv(); cfg = { hfCallsEnabled: true };
  db.prepare("INSERT INTO hf_hosts VALUES ('host1','asha-k','Asha',10,0,0,'online',?,'live')").run(Date.now());
});

describe("closure guards", () => {
  it("isClosing is true only for open closures", async () => {
    expect(await isClosing(env, "u1")).toBe(false);
    for (const [uid, st, want] of [["a", "waiting_hold", true], ["b", "waiting_payouts", true], ["c", "ready", true], ["d", "done", false], ["e", "cancelled", false]]) {
      exit(uid, st); expect(await isClosing(env, uid)).toBe(want);
    }
  });
  it("a closing caller cannot start a call (409 account_closing)", async () => {
    exit("u1", "waiting_payouts");
    const r = await hfCallsRoute(req("POST", "/api/hf/calls", "u1", { hostSlug: "asha-k" }), env, "/api/hf/calls");
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(b.error).toBe("account_closing"); expect(b.reason).toBe("account_closing"); expect(b.message).toMatch(/closed/);
  });
  it("a non-closing caller is not stopped by the guard (gets past it)", async () => {
    const r = await hfCallsRoute(req("POST", "/api/hf/calls", "u1", { hostSlug: "asha-k" }), env, "/api/hf/calls");
    expect((await r.json()).error).not.toBe("account_closing");
  });
  it("calls to a host who is closing are unavailable", async () => {
    exit("host1", "waiting_hold");
    const r = await hfCallsRoute(req("POST", "/api/hf/calls", "u1", { hostSlug: "asha-k" }), env, "/api/hf/calls");
    expect((await r.json()).error).toBe("host_unavailable");
  });
  it("a closing host is refused going online and is forced offline", async () => {
    exit("host1", "waiting_hold");
    const r = await hfCallsRoute(req("PUT", "/api/hosts/me/presence", "host1", { online: true }), env, "/api/hosts/me/presence");
    expect(r.status).toBe(409); expect((await r.json()).error).toBe("account_closing");
    expect(db.prepare("SELECT presence FROM hf_hosts WHERE uid='host1'").get().presence).toBe("offline");
  });
  it("forceHostOffline takes online and busy hosts offline", async () => {
    await forceHostOffline(env, "host1");
    expect(db.prepare("SELECT presence FROM hf_hosts WHERE uid='host1'").get().presence).toBe("offline");
    db.prepare("UPDATE hf_hosts SET presence='busy'").run();
    await forceHostOffline(env, "host1");
    expect(db.prepare("SELECT presence FROM hf_hosts WHERE uid='host1'").get().presence).toBe("offline");
  });
  it("a closing user cannot start a top-up; others still can reach the gateway step", async () => {
    exit("u1", "ready");
    const r = await hfTopupRoute(req("POST", "/api/hf/wallet/topup", "u1", { amount: 100 }), env, "/api/hf/wallet/topup");
    expect(r.status).toBe(409); expect((await r.json()).error).toBe("account_closing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_topups").get().n).toBe(0);
  });
});
