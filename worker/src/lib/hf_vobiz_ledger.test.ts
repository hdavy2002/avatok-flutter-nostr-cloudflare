// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { canonicalJson, computeRowHash, chainInsert, recordLegFromWebhook, upsertLegFromCdr, verifyChain } from "./hf_vobiz_ledger";
import { parseCdr } from "./hf_vobiz_api";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../migrations/2026-10-10-hf-vobiz-spend.sql", import.meta.url), "utf8"));
  db.exec("CREATE TABLE hf_calls (id TEXT PRIMARY KEY, caller_uid TEXT, host_uid TEXT, host_leg_uuid TEXT, caller_leg_uuid TEXT)");
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  return { raw: db, prepare: (q: string) => stmt(q) };
}

let env: any;
beforeEach(() => {
  env = { DB_META: makeDb() };
  env.DB_META.raw.exec("INSERT INTO hf_calls VALUES ('c1','caller1','host1','hl1','cl1')");
});

const hook = { CallUUID: "hl1", From: "+911111111111", To: "+912222222222", Direction: "outbound", Duration: "60", BillDuration: "55",
  TotalCost: "0.385", StartTime: "2026-10-10 06:00:00", EndTime: "2026-10-10 06:01:00", HangupCause: "NORMAL_CLEARING" };

describe("hash", () => {
  it("canonical json sorts keys and is deterministic", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"c":null,"d":2},"b":1}');
    const h1 = await computeRowHash("", { a: 1, b: 2 });
    const h2 = await computeRowHash("", { b: 2, a: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeRowHash("x", { a: 1, b: 2 })).not.toBe(h1);
  });
});

describe("ledger", () => {
  it("records a webhook leg with attribution, idempotently, and the chain verifies", async () => {
    await recordLegFromWebhook(env, { callId: "c1", role: "host", legUuid: "hl1", fields: hook });
    await recordLegFromWebhook(env, { callId: "c1", role: "host", legUuid: "hl1", fields: hook });
    await recordLegFromWebhook(env, { callId: "c1", role: "caller", legUuid: "cl1", fields: { ...hook, CallUUID: "cl1" } });
    const rows = env.DB_META.raw.prepare("SELECT * FROM hf_vobiz_legs ORDER BY seq").all();
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ user_uid: "host1", role: "host", total_cost_paise: 39, billsec: 55, source: "webhook" });
    expect(rows[1]).toMatchObject({ user_uid: "caller1", role: "caller", prev_hash: rows[0].row_hash });
    expect(await verifyChain(env, "hf_vobiz_legs")).toEqual({ ok: true, rows: 2 });
  });

  it("detects a tampered row", async () => {
    for (const id of ["a", "b", "c"]) await recordLegFromWebhook(env, { callId: "c1", role: "host", legUuid: id, fields: { ...hook, CallUUID: id } });
    env.DB_META.raw.exec("UPDATE hf_vobiz_legs SET total_cost_paise = 1 WHERE leg_uuid = 'b'");
    const v = await verifyChain(env, "hf_vobiz_legs");
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it("CDR fill is allowed (not hashed), flags a mismatch, and logs a chained row", async () => {
    await recordLegFromWebhook(env, { callId: "c1", role: "host", legUuid: "hl1", fields: hook });
    const cdr = parseCdr({ uuid: "hl1", billsec: 60, total_cost: 0.9, duration: 61 })!;
    expect(await upsertLegFromCdr(env, cdr)).toBe("filled");
    expect(await upsertLegFromCdr(env, cdr)).toBe("unchanged");
    const r = env.DB_META.raw.prepare("SELECT * FROM hf_vobiz_legs").get();
    expect(r.cdr_checked_at).not.toBeNull();
    expect(r.mismatch).toContain("cost");
    expect(r.mismatch).toContain("billsec");
    expect(await verifyChain(env, "hf_vobiz_legs")).toMatchObject({ ok: true });
    expect(await verifyChain(env, "hf_vobiz_leg_cdr_log")).toEqual({ ok: true, rows: 1 });
  });

  it("CDR for an unknown leg becomes role unknown with no call; known leg is attributed", async () => {
    expect(await upsertLegFromCdr(env, parseCdr({ uuid: "zzz", billsec: 10, total_cost: 0.1 })!)).toBe("inserted");
    expect(await upsertLegFromCdr(env, parseCdr({ uuid: "cl1", billsec: 10, total_cost: 0.1 })!)).toBe("inserted");
    const z = env.DB_META.raw.prepare("SELECT * FROM hf_vobiz_legs WHERE leg_uuid='zzz'").get();
    expect(z).toMatchObject({ role: "unknown", call_id: null, source: "cdr" });
    const k = env.DB_META.raw.prepare("SELECT * FROM hf_vobiz_legs WHERE leg_uuid='cl1'").get();
    expect(k).toMatchObject({ role: "caller", call_id: "c1", user_uid: "caller1" });
    expect(await verifyChain(env, "hf_vobiz_legs")).toEqual({ ok: true, rows: 2 });
  });

  it("chains balance and recharge rows; confirm flip does not break the chain", async () => {
    await chainInsert(env, "hf_vobiz_balance", { at: 1, balance_paise: 100, ok: 1 });
    await chainInsert(env, "hf_vobiz_balance", { at: 2, balance_paise: 90, ok: 1 });
    await chainInsert(env, "hf_vobiz_recharges", { id: "r1", at: 3, amount_paise: 5000, kind: "detected", confirmed: 0, created_at: 3 });
    env.DB_META.raw.exec("UPDATE hf_vobiz_recharges SET confirmed = 1");
    expect(await verifyChain(env, "hf_vobiz_balance")).toEqual({ ok: true, rows: 2 });
    expect(await verifyChain(env, "hf_vobiz_recharges")).toEqual({ ok: true, rows: 1 });
    expect(await verifyChain(env, "nope")).toMatchObject({ ok: false });
  });
});
