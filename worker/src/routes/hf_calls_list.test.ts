// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-DASH-CALLS-1] GET /api/hf/calls: scoping, roles, status filter, keyset pagination, privacy.
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

import { hfCallsRoute } from "./hf_calls";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, display_name TEXT, status TEXT);
    CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, status TEXT, created_at INTEGER, connected_at INTEGER,
      billed_minutes INTEGER DEFAULT 0, billable_seconds INTEGER, charged_paise INTEGER DEFAULT 0, consumed_value_paise INTEGER,
      host_earning_paise INTEGER DEFAULT 0, end_reason TEXT);
  `);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) } };
  db.prepare("INSERT INTO users VALUES ('caller1','Riya Sharma'),('caller2','Aman'),('hostu','Meena')").run();
  db.prepare("INSERT INTO hf_hosts VALUES ('hostu','meena-k','Meena K','live')").run();
}
const addCall = (id: string, caller: string, status: string, at: number, extra: Record<string, unknown> = {}) => {
  const c = { billed_minutes: 0, billable_seconds: null, charged_paise: 0, consumed_value_paise: null, host_earning_paise: 0, end_reason: null, connected_at: null, ...extra };
  db.prepare("INSERT INTO hf_calls (id,caller_uid,host_uid,status,created_at,connected_at,billed_minutes,billable_seconds,charged_paise,consumed_value_paise,host_earning_paise,end_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, caller, "hostu", status, at, c.connected_at, c.billed_minutes, c.billable_seconds, c.charged_paise, c.consumed_value_paise, c.host_earning_paise, c.end_reason);
};
const get = async (qs = "", uid = "caller1") => {
  const r = await hfCallsRoute(new Request(`https://x/api/hf/calls${qs}`, { headers: { "x-test-uid": uid } }), env, "/api/hf/calls");
  return { status: r.status, body: await r.json(), headers: r.headers };
};

beforeEach(() => { makeEnv(); cfg = { hfCallsEnabled: true }; signedIn = true; });

describe("GET /api/hf/calls", () => {
  it("signed out is 401, flag off is 404", async () => {
    signedIn = false;
    expect((await get()).status).toBe(401);
    signedIn = true; cfg = {};
    const r = await get();
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_enabled");
  });

  it("caller sees only their own calls, every outcome, host handle and slug, no-store", async () => {
    addCall("call_aaaa0001", "caller1", "completed", 1000, { connected_at: 1100, billed_minutes: 3, billable_seconds: 170, charged_paise: 900, consumed_value_paise: 850, end_reason: "hangup" });
    addCall("call_aaaa0002", "caller1", "no_answer", 2000);
    addCall("call_aaaa0003", "caller2", "completed", 3000, { billed_minutes: 1, charged_paise: 500 });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.body.items.map((i: any) => i.id)).toEqual(["call_aaaa0002", "call_aaaa0001"]);
    expect(r.body.items[1]).toEqual({ id: "call_aaaa0001", status: "completed", otherHandle: "Meena K", hostSlug: "meena-k", at: 1100, seconds: 170, amountPaise: 850, endReason: "hangup" });
    expect(r.body.items[0].amountPaise).toBeNull();
    expect(r.body.nextCursor).toBeNull();
  });

  it("host role sees only received calls with caller first-name handle and earning; non-host gets an empty list", async () => {
    addCall("call_bbbb0001", "caller1", "completed", 1000, { billed_minutes: 2, host_earning_paise: 600 });
    addCall("call_bbbb0002", "caller2", "host_declined", 2000);
    const h = await get("?role=host", "hostu");
    expect(h.body.items.map((i: any) => [i.id, i.otherHandle, i.amountPaise, i.seconds])).toEqual([["call_bbbb0002", "Aman", null, 0], ["call_bbbb0001", "Riya", 600, 120]]);
    expect(h.body.items[0].hostSlug).toBeNull();
    const n = await get("?role=host", "caller1");
    expect(n.status).toBe(200);
    expect(n.body).toEqual({ ok: true, items: [], nextCursor: null });
  });

  it("status filter: completed and missed", async () => {
    addCall("call_cccc0001", "caller1", "completed", 1000, { billed_minutes: 1 });
    for (const [i, s] of ["no_answer", "host_declined", "caller_no_answer", "cancelled", "failed"].entries()) addCall(`call_cccc001${i}`, "caller1", s, 2000 + i);
    addCall("call_cccc0099", "caller1", "connected", 9000);
    expect((await get("?status=completed")).body.items.map((i: any) => i.id)).toEqual(["call_cccc0001"]);
    const missed = (await get("?status=missed")).body.items.map((i: any) => i.status);
    expect(missed.sort()).toEqual(["caller_no_answer", "cancelled", "failed", "host_declined", "no_answer"]);
    expect((await get("?status=all")).body.items).toHaveLength(7);
  });

  it("keyset pagination round-trips without gaps or repeats, including equal timestamps", async () => {
    for (let i = 1; i <= 5; i++) addCall(`call_dddd000${i}`, "caller1", "completed", i <= 2 ? 5000 : 1000 * i);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 5; n++) {
      const r = await get(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.items.map((i: any) => i.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(["call_dddd0005", "call_dddd0002", "call_dddd0001", "call_dddd0004", "call_dddd0003"]);
    expect(cursor).toBeNull();
  });

  it("validates inputs", async () => {
    for (const qs of ["?role=admin", "?status=weird", "?limit=0", "?limit=51", "?limit=x", "?cursor=!!!"]) {
      const r = await get(qs);
      expect(r.status, qs).toBe(400);
      expect(r.body.error).toBe("invalid_field");
    }
  });

  it("never exposes a phone number, e164 or another uid", async () => {
    addCall("call_eeee0001", "caller1", "completed", 1000, { billed_minutes: 1 });
    for (const qs of ["", "?role=host"]) {
      const txt = JSON.stringify((await get(qs, qs ? "hostu" : "caller1")).body);
      expect(txt).not.toMatch(/phone|e164|\+91|caller_uid|host_uid|"uid"/i);
    }
  });
});
