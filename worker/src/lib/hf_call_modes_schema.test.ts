// @ts-nocheck -- uses node:sqlite (the D1 shim), which the worker tsconfig has no types for
// [HF-CALL-MODES-P0] The four 2026-10-24 migrations apply on top of every earlier migration, add what spec 2.6 lists, and the backfill is idempotent.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const dir = new URL("../../migrations/", import.meta.url);
const strip = (t: string) => t.replace(/^\s*--.*$/gm, "");
const stmts = (f: string) => strip(readFileSync(new URL(f, dir), "utf8")).split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);

function build(upTo: "before" | "alters" | "all") {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const mine = f.startsWith("2026-10-24-hf-call-modes") || f === "2026-10-24-hf-call-queue.sql" || f === "2026-10-24-hf-booking-hold-alters.sql";
    if (mine) continue;
    for (const s of stmts(f)) { try { db.exec(s); } catch { /* step not needed here */ } }
  }
  if (upTo !== "before") {
    for (const f of ["2026-10-24-hf-call-modes-alters.sql", "2026-10-24-hf-booking-hold-alters.sql", "2026-10-24-hf-call-queue.sql"]) for (const s of stmts(f)) db.exec(s); // must NOT throw
  }
  return db;
}
const cols = (db, t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

describe("2026-10-24 call-modes migrations", () => {
  it("add the columns, the queue table and its indexes", () => {
    const db = build("alters");
    for (const c of ["call_mode", "on_call_since", "queue_paused"]) expect(cols(db, "hf_hosts")).toContain(c);
    for (const c of ["source", "queue_entry_id", "funded_seconds", "chunks"]) expect(cols(db, "hf_calls")).toContain(c);
    expect(cols(db, "hf_bookings")).toContain("hold_seconds");
    expect(cols(db, "hf_booking_quotes")).toContain("hold_seconds");
    for (const c of ["id", "host_uid", "fan_uid", "seq", "status", "skip_reason", "host_miss_count", "call_id", "joined_at", "offered_at", "ended_at", "updated_at", "wa_join_at", "wa_next_at"]) expect(cols(db, "hf_call_queue")).toContain(c);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='hf_call_queue'").all().map((r) => r.name);
    expect(idx).toContain("idx_hf_call_queue_fan_active");
    expect(idx).toContain("idx_hf_call_queue_host");
  });

  it("queue: one active entry per fan, a finished one does not block a new join", () => {
    const db = build("alters");
    const ins = (id, status) => db.prepare("INSERT INTO hf_call_queue (id,host_uid,fan_uid,seq,status,joined_at,updated_at) VALUES (?,?,?,?,?,1,1)").run(id, "h", "f", 1, status);
    ins("a", "waiting");
    expect(() => ins("b", "offered")).toThrow();
    db.prepare("UPDATE hf_call_queue SET status='done' WHERE id='a'").run();
    expect(() => ins("c", "waiting")).not.toThrow();
  });

  it("backfill: offline -> bookings_only, online/busy -> online; idempotent; on_call_since from a connected call", () => {
    const db = build("alters");
    const host = (uid, presence, callId = null) => db.prepare("INSERT INTO hf_hosts (uid, status, presence, presence_call_id, price_per_min, created_at, updated_at) VALUES (?, 'live', ?, ?, 1000, 1, 1)").run(uid, presence, callId);
    try { host("on", "online"); host("busy", "busy", "c1"); host("off", "offline"); } catch (e) { throw new Error("seed hf_hosts failed: " + e.message); }
    db.prepare("INSERT INTO hf_calls (id, caller_uid, host_uid, rate_paise, status, created_at, connected_at) VALUES ('c1','f','busy',1000,'connected',1,12345)").run();
    const run = () => { for (const s of stmts("2026-10-24-hf-call-modes-backfill.sql")) db.exec(s); };
    run();
    const mode = (u) => db.prepare("SELECT call_mode m, on_call_since o FROM hf_hosts WHERE uid=?").get(u);
    expect(mode("on").m).toBe("online");
    expect(mode("busy").m).toBe("online");
    expect(mode("off").m).toBe("bookings_only");
    expect(mode("busy").o).toBe(12345);
    expect(mode("on").o).toBeNull();
    // a host who later chose Offline / Online must survive a re-run
    db.prepare("UPDATE hf_hosts SET call_mode='offline' WHERE uid='off'").run();
    db.prepare("UPDATE hf_hosts SET call_mode='online', presence='online' WHERE uid='on'").run();
    run();
    expect(mode("off").m).toBe("offline");
    expect(mode("on").m).toBe("online");
    expect(mode("busy").o).toBe(12345);
  });
});
