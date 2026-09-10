import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(resolve(root, "migrations/2026-09-10-unified-availability.sql"), "utf8");
const engine = readFileSync(resolve(root, "src/cal/engine.ts"), "utf8");
const route = readFileSync(resolve(root, "src/routes/calendar_availability.ts"), "utf8");

// Python sqlite3 is available in CI's Node 20 image. Exercise the real schema
// and trigger-backed occupancy bridge so a parsing-only migration cannot pass.
const SQLITE_HARNESS = String.raw`
import json, sqlite3, sys
payload=json.load(sys.stdin)
db=sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE calendar_blocks (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_app TEXT NOT NULL,source_ref TEXT,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,title TEXT,status TEXT NOT NULL,created_at INTEGER);
CREATE TABLE bookings (id TEXT PRIMARY KEY,creator_id TEXT,starts_at INTEGER,ends_at INTEGER,status TEXT);
""")
db.executescript(payload["migration"])
db.execute("INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,source_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ("r1","creator","listing-a","booking","confirmed",100,200,"order-1",1,1))
block=db.execute("SELECT source_app,source_ref,status FROM calendar_blocks WHERE id='availability:r1'").fetchone()
claim="""INSERT INTO availability_reservations (id,creator_id,listing_id,kind,status,starts_at,ends_at,source_ref,created_at,updated_at)
SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM calendar_blocks b WHERE b.user_id=? AND b.status='busy' AND b.starts_at < ? AND b.ends_at > ?)"""
r2=db.execute(claim,("r2","creator","listing-b","booking","confirmed",150,250,"order-2",2,2,"creator",250,150)).rowcount
db.execute("UPDATE availability_reservations SET status='expired',updated_at=3 WHERE id='r1'")
expired=db.execute("SELECT status FROM calendar_blocks WHERE id='availability:r1'").fetchone()[0]
print(json.dumps({"block":block,"competing_claim_changes":r2,"expired_block":expired}))
`;

describe("[AVAILABILITY-1] unified availability contract", () => {
  it("exports the checkout validation and atomic claim boundary", () => {
    expect(engine).toContain("export async function validateListingSlot");
    expect(engine).toContain("export async function claimListingSlot");
    expect(engine).toContain("INSERT INTO availability_reservations");
    expect(engine).toContain("source_app='availability'");
  });

  it("exposes the versioned schedule, public picker, and conflict preview routes", () => {
    expect(route).toContain("export const getAvailabilitySchedule");
    expect(route).toContain("export const putAvailabilitySchedule");
    expect(route).toContain("export const getListingAvailability");
    expect(route).toContain("export const previewAvailabilityConflicts");
    expect(route).toContain("listing_id mismatch");
  });

  it("mirrors reservations into canonical blocks and rejects overlap", () => {
    const result = JSON.parse(execFileSync("python3", ["-c", SQLITE_HARNESS], { cwd: root, input: JSON.stringify({ migration }), encoding: "utf8" }));
    expect(result.block).toEqual(["availability", "r1", "busy"]);
    expect(result.competing_claim_changes).toBe(0);
    expect(result.expired_block).toBe("cancelled");
  });
});
