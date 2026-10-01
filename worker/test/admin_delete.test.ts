// [SAATHUM-ADMIN-DELETE-1] Permanent delete: events (money history refuses, clean event is gone with its rows)
// and free videos (row + views) — against real SQLite (node:sqlite) through a tiny D1 shim.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { deleteBlockers, deleteEventRows, MONEY_TABLES, CLEANUP_TABLES } from "../src/lib/event_delete";
import { createFreeVideo, deleteFreeVideo, getRow } from "../src/routes/free_videos";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };

function d1(db: any): D1Database {
  const stmt = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    run: async () => { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

const FV = readFileSync(new URL("../migrations/2026-10-01-free-videos.sql", import.meta.url), "utf8");
const VIEWS = readFileSync(new URL("../migrations/2026-10-01-freevid-views.sql", import.meta.url), "utf8");

let raw: any; let db: D1Database;
// Every table the delete touches, reduced to the one column it is keyed on (+ status where the SQL reads it).
function schema(skip: string[] = []) {
  raw.exec(`CREATE TABLE listings (id TEXT PRIMARY KEY, kind TEXT, status TEXT)`);
  for (const t of [...MONEY_TABLES, ...CLEANUP_TABLES.map((c) => c.table)]) {
    if (skip.includes(t) || t === "event_video_views") continue;
    raw.exec(`CREATE TABLE ${t} (listing_id TEXT NOT NULL, status TEXT)`);
  }
  raw.exec(VIEWS);
}
const count = (t: string, id: string) => Number(raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE listing_id=?`).get(id).n);

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
});

describe("deleteBlockers", () => {
  it("is empty for an event with no money rows", async () => {
    schema();
    raw.exec(`INSERT INTO listings VALUES ('e1','live_event','published'); INSERT INTO reviews VALUES ('e1',NULL); INSERT INTO listing_favorites VALUES ('e1',NULL);`);
    const b = await deleteBlockers(db = d1(raw), "e1");
    expect(b).toMatchObject({ counts: {}, total: 0, unsure: null, skipped: [] });
  });
  it("counts an order, a checkout and a UPI intent", async () => {
    schema();
    raw.exec(`INSERT INTO orders VALUES ('e1','held'); INSERT INTO saathum_checkouts VALUES ('e1',NULL); INSERT INTO saathum_checkouts VALUES ('e1',NULL); INSERT INTO hdfc_sms_payment_intents VALUES ('e1','pending'); INSERT INTO orders VALUES ('other','held');`);
    const b = await deleteBlockers(d1(raw), "e1");
    expect(b.counts).toEqual({ orders: 1, saathum_checkouts: 2, hdfc_sms_payment_intents: 1 });
    expect(b.total).toBe(4);
  });
  it("skips a table that does not exist", async () => {
    schema(["gateway_orders", "live_sessions"]);
    const b = await deleteBlockers(d1(raw), "e1");
    expect(b.skipped.sort()).toEqual(["gateway_orders", "live_sessions"]);
    expect(b.unsure).toBeNull();
  });
  it("is unsure (never 'clean') on any other error", async () => {
    schema();
    const boom = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR: disk I/O error"); } }) }) } as unknown as D1Database;
    const b = await deleteBlockers(boom, "e1");
    expect(b.unsure?.table).toBe(MONEY_TABLES[0]);
    expect(b.unsure?.error).toMatch(/disk I\/O/);
  });
});

describe("deleteEventRows", () => {
  it("removes the listing and its dependent rows, only for that listing", async () => {
    schema();
    raw.exec(`INSERT INTO listings VALUES ('e1','live_event','draft'),('e2','live_event','draft');`);
    for (const t of ["reviews", "listing_favorites", "event_videos", "push_sent", "availability_reservations"]) {
      if (t !== "event_video_views") raw.exec(`INSERT INTO ${t} (listing_id) VALUES ('e1'),('e2')`);
    }
    raw.exec(`INSERT INTO event_video_views (listing_id, uid, first_at, last_at, plays) VALUES ('e1','u1',1,1,1),('e2','u1',1,1,1)`);
    const out = await deleteEventRows(d1(raw), "e1");
    expect(out.listingDeleted).toBe(true);
    expect(raw.prepare(`SELECT id FROM listings`).all().map((r: any) => r.id)).toEqual(["e2"]);
    for (const t of ["reviews", "listing_favorites", "event_videos", "push_sent", "availability_reservations", "event_video_views"]) {
      expect(count(t, "e1")).toBe(0);
      expect(count(t, "e2")).toBe(1);
    }
  });
  it("keeps sent WhatsApp rows, drops unsent ones, and tolerates missing tables", async () => {
    schema(["affiliate_links", "listing_slots"]);
    raw.exec(`INSERT INTO listings VALUES ('e1','live_event','draft'); INSERT INTO whatsapp_outbox VALUES ('e1','queued'),('e1','sent'),('e1','failed');`);
    const out = await deleteEventRows(d1(raw), "e1");
    expect(out.skipped.sort()).toEqual(["affiliate_links", "listing_slots"]);
    expect(count("whatsapp_outbox", "e1")).toBe(1);
    expect(out.listingDeleted).toBe(true);
  });
  it("never deletes a non-event listing", async () => {
    schema();
    raw.exec(`INSERT INTO listings VALUES ('g1','goods','published')`);
    expect((await deleteEventRows(d1(raw), "g1")).listingDeleted).toBe(false);
    expect(raw.prepare(`SELECT COUNT(*) n FROM listings`).get().n).toBe(1);
  });
});

describe("deleteFreeVideo", () => {
  beforeEach(() => { raw.exec(FV); raw.exec(VIEWS); db = d1(raw); });
  it("removes the row and its views, any status, and 404s a missing id", async () => {
    const row = await createFreeVideo(db, { title: "Evening satsang", category: "satsang", youtube_video_id: "dQw4w9WgXcQ", status: "published" }, "admin1", 1000);
    raw.exec(`INSERT INTO event_video_views (listing_id, uid, first_at, last_at, plays) VALUES ('${row.id}','u1',1,1,3),('${row.id}','u2',1,1,1),('other','u1',1,1,1)`);
    expect(await deleteFreeVideo(db, row.id)).toBe(true);
    expect(await getRow(db, row.id)).toBeNull();
    expect(count("event_video_views", row.id)).toBe(0);
    expect(count("event_video_views", "other")).toBe(1);
    expect(await deleteFreeVideo(db, row.id)).toBe(false);
  });
  it("works for an archived video when the views table is missing", async () => {
    const r2 = new DatabaseSync(":memory:"); r2.exec(FV);
    const d = d1(r2);
    const row = await createFreeVideo(d, { title: "Old bhajan", category: "bhajan", youtube_video_id: "dQw4w9WgXcQ", status: "draft" }, "a", 1);
    r2.prepare(`UPDATE free_videos SET status='archived' WHERE id=?`).run(row.id);
    expect(await deleteFreeVideo(d, row.id)).toBe(true);
  });
});
