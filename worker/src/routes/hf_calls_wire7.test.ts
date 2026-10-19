// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-7] GET /api/hf/calls/:id app fields (phase, reason, costPaise, walletPaise, capAt) + history extras (reason, myStars).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

let cfg: Record<string, unknown> = {};
let signedIn = true;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => (signedIn ? { uid: req.headers.get("x-test-uid") ?? "caller1" } : { status: 401, error: "unauthorized" }),
  isFail: (u: any) => !!u?.error,
}));

import { hfCallsRoute, callPhase, callReason, LOW_BALANCE_SECONDS } from "./hf_calls";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const NOW = Date.UTC(2026, 9, 19, 10, 0, 0);

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, display_name TEXT, status TEXT);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, rate_paise INTEGER DEFAULT 500, status TEXT, created_at INTEGER,
      host_answered_at INTEGER, connected_at INTEGER, ended_at INTEGER, billed_minutes INTEGER DEFAULT 0, billable_seconds INTEGER, tokens_spent_micro INTEGER,
      charged_paise INTEGER DEFAULT 0, consumed_value_paise INTEGER, host_earning_paise INTEGER DEFAULT 0, end_reason TEXT, pricing_snapshot TEXT);
    CREATE TABLE hf_reviews (id TEXT PRIMARY KEY, call_id TEXT, caller_uid TEXT, stars INTEGER);
  `);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) },
    HF_CALL: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true, maxSeconds: 600, hardEndsAt: null, fundsPaise: 3000 }), { status: 200 }) }) },
  };
  db.prepare("INSERT INTO users VALUES ('caller1','Riya Sharma'),('caller2','Aman'),('hostu','Meena')").run();
  db.prepare("INSERT INTO hf_hosts VALUES ('hostu','meena-k','Meena K','live')").run();
}
const addCall = (id: string, status: string, extra: Record<string, unknown> = {}) => {
  const c = { created_at: NOW - 400_000, host_answered_at: null, connected_at: null, ended_at: null, billed_minutes: 0, charged_paise: 0, end_reason: null, ...extra };
  db.prepare("INSERT INTO hf_calls (id,caller_uid,host_uid,rate_paise,status,created_at,host_answered_at,connected_at,ended_at,billed_minutes,charged_paise,end_reason) VALUES (?,?,?,500,?,?,?,?,?,?,?,?)")
    .run(id, "caller1", "hostu", status, c.created_at, c.host_answered_at, c.connected_at, c.ended_at, c.billed_minutes, c.charged_paise, c.end_reason);
};
const get = async (id: string, uid = "caller1") => {
  const p = `/api/hf/calls/${id}`;
  const r = await hfCallsRoute(new Request(`https://x${p}`, { headers: { "x-test-uid": uid } }), env, p);
  return { status: r.status, text: await r.clone().text(), body: await r.json() };
};

beforeEach(() => { makeEnv(); cfg = { hfCallsEnabled: true }; signedIn = true; vi.spyOn(Date, "now").mockReturnValue(NOW); });

describe("phase and reason mapping", () => {
  it("maps every status", () => {
    expect(callPhase({ status: "ringing_host" })).toBe("ringing_host");
    expect(callPhase({ status: "ringing_host", host_answered_at: 1 })).toBe("host_accepted");
    expect(callPhase({ status: "ringing_caller" })).toBe("dialing_fan");
    expect(callPhase({ status: "connected" })).toBe("connected");
    for (const s of ["completed", "host_declined", "no_answer", "caller_no_answer", "failed", "blocked"]) expect(callPhase({ status: s })).toBe("ended");
    expect(callReason({ status: "host_declined" })).toBe("declined");
    expect(callReason({ status: "no_answer" })).toBe("missed");
    expect(callReason({ status: "blocked" })).toBe("busy");
    expect(callReason({ status: "failed" })).toBe("offline");
    expect(callReason({ status: "failed", end_reason: "caller_hangup" })).toBe("ended");
    expect(callReason({ status: "completed", end_reason: "balance" })).toBe("no_balance");
    expect(callReason({ status: "completed", end_reason: "caller_hangup" })).toBe("ended");
    expect(callReason({ status: "connected" })).toBeNull();
  });
});

describe("GET /api/hf/calls/:id", () => {
  it("401 when signed out", async () => {
    addCall("call_ring01", "ringing_host");
    signedIn = false;
    expect((await get("call_ring01")).status).toBe(401);
  });
  it("404 for someone else's call", async () => {
    addCall("call_ring02", "ringing_host");
    expect((await get("call_ring02", "caller2")).status).toBe(404);
  });
  it("ringing then accepted then dialing", async () => {
    addCall("call_ring03", "ringing_host");
    expect((await get("call_ring03")).body).toMatchObject({ phase: "ringing_host", reason: null, capAt: null, walletPaise: null, lowBalanceSeconds: LOW_BALANCE_SECONDS });
    db.prepare("UPDATE hf_calls SET host_answered_at=? WHERE id='call_ring03'").run(NOW - 1000);
    expect((await get("call_ring03")).body.phase).toBe("host_accepted");
    db.prepare("UPDATE hf_calls SET status='ringing_caller' WHERE id='call_ring03'").run();
    expect((await get("call_ring03")).body.phase).toBe("dialing_fan");
  });
  it("connected shows live cost, wallet left and the cap time (caller only)", async () => {
    addCall("call_conn01", "connected", { connected_at: NOW - 70_000 });
    const r = await get("call_conn01");
    // 70 s started = 2 minutes at 500 paise; funds 3000 paise
    expect(r.body).toMatchObject({ phase: "connected", costPaise: 1000, walletPaise: 2000, capAt: NOW - 70_000 + 600_000 });
    const host = await get("call_conn01", "hostu");
    expect(host.body).toMatchObject({ phase: "connected", costPaise: 0, walletPaise: null });
  });
  it("ended: declined and balance reasons", async () => {
    addCall("call_end001", "host_declined", { ended_at: NOW - 10 });
    expect((await get("call_end001")).body).toMatchObject({ phase: "ended", reason: "declined" });
    addCall("call_end002", "completed", { ended_at: NOW - 10, end_reason: "balance", billed_minutes: 3, charged_paise: 1500 });
    expect((await get("call_end002")).body).toMatchObject({ phase: "ended", reason: "no_balance", billedMinutes: 3, costPaise: 1500 });
  });
  it("never carries a phone number", async () => {
    addCall("call_conn02", "connected", { connected_at: NOW - 5000 });
    expect((await get("call_conn02")).text).not.toMatch(/\+\d{8,}|(?<!\d)[6-9]\d{9}(?!\d)/);
  });
});

describe("GET /api/hf/calls history extras", () => {
  it("adds reason and the caller's own stars", async () => {
    addCall("call_hist01", "completed", { ended_at: NOW, billed_minutes: 2, charged_paise: 1000 });
    addCall("call_hist02", "no_answer", { created_at: NOW - 500_000 });
    db.prepare("INSERT INTO hf_reviews VALUES ('r1','call_hist01','caller1',4)").run();
    const r = await hfCallsRoute(new Request("https://x/api/hf/calls?role=caller", { headers: { "x-test-uid": "caller1" } }), env, "/api/hf/calls");
    const b = await r.json();
    const by = Object.fromEntries(b.items.map((i) => [i.id, i]));
    expect(by.call_hist01).toMatchObject({ reason: "ended", myStars: 4 });
    expect(by.call_hist02).toMatchObject({ reason: "missed", myStars: null });
    expect(JSON.stringify(b)).not.toMatch(/\+\d{8,}|(?<!\d)[6-9]\d{9}(?!\d)/);
  });
});
