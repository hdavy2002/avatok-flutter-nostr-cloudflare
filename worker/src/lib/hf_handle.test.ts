// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-FIX-HANDLE-1] Lazy handle assignment for Hello Fraands users.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const events: any[] = [];
vi.mock("../hooks", () => ({ track: async (_e: any, uid: string, ev: string, _a: string, props: any) => { events.push({ uid, ev, props }); }, trackException: async () => {} }));

import { resolveHfHandle } from "./hf_handle";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;

beforeEach(() => {
  events.length = 0;
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (uid TEXT PRIMARY KEY, handle TEXT UNIQUE, display_name TEXT, first_name TEXT, last_name TEXT, updated_at INTEGER);
    CREATE TABLE identity_proofs (uid TEXT, proof TEXT, status TEXT, provider TEXT, verified_at INTEGER, updated_at INTEGER, PRIMARY KEY (uid, proof));
  `);
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) } };
});

describe("resolveHfHandle", () => {
  it("returns a registered username untouched", async () => {
    expect(await resolveHfHandle(env, "u1", "maya")).toBe("maya");
    expect(events).toHaveLength(0);
  });
  it("assigns a handle once, then keeps it (idempotent) and emits telemetry once", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','Meena Rao')").run();
    const h = await resolveHfHandle(env, "u1", null);
    expect(h).toMatch(/^meena_rao(\d+)?$/);
    expect(await resolveHfHandle(env, "u1", null)).toBe(h);
    expect(db.prepare("SELECT handle FROM users WHERE uid='u1'").get().handle).toBe(h);
    expect(events.filter((e) => e.ev === "hf_handle_auto_assigned")).toEqual([{ uid: "u1", ev: "hf_handle_auto_assigned", props: { outcome: "ok", handle_length: h.length } }]);
  });
  it("never overwrites an existing handle and two users never share one", async () => {
    db.prepare("INSERT INTO users (uid, handle) VALUES ('u1','keepme')").run();
    expect(await resolveHfHandle(env, "u1", null)).toBe("keepme");
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('a','Sam'), ('b','Sam')").run();
    const a = await resolveHfHandle(env, "a", null); const b = await resolveHfHandle(env, "b", null);
    expect(a).not.toBe(b);
  });
  it("returns null without a users row, and never throws on a broken schema", async () => {
    expect(await resolveHfHandle(env, "ghost", null)).toBeNull();
    db.exec("DROP TABLE users");
    expect(await resolveHfHandle(env, "u1", null)).toBeNull();
    expect(events.some((e) => e.props.outcome === "failed")).toBe(true);
  });
});
