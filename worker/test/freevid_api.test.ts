// [SAATHUM-FREEVID-API-1 2026-10-01] Free events + video crop API rules.
// Pure rules (crop parsing, free/paid playable decision, admin form) plus the two SQL
// statements that matter, run against real SQLite (node:sqlite) through a tiny D1 shim:
// the 60-second view rate limit and the analytics video_views queries.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { parseCropField, isPlayable, isReplay, isMissingColumnError, recordVideoView, VIEW_RATE_LIMIT_MS } from "../src/lib/freevid_compat";
import { normalizeEventInput, splitPatch } from "../src/lib/admin2_events_logic";
import { shapeVideoViews, VIDEO_VIEWS_TOTALS_SQL, videoViewsByEventSql } from "../src/routes/admin2_analytics";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };

/** Minimal D1 shim: prepare().bind().run()/all()/first() over node:sqlite. */
function d1(db: any): D1Database {
  const stmt = (sql: string, binds: unknown[] = []) => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    run: async () => { const r = db.prepare(sql).run(...binds); return { meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
    first: async () => db.prepare(sql).get(...binds) ?? null,
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

describe("parseCropField (YouTube save body)", () => {
  it("absent = leave the stored crop alone", () => {
    expect(parseCropField({ url: "x" })).toEqual({ present: false });
    expect(parseCropField({ url: "x", crop: undefined })).toEqual({ present: false });
  });
  it("null = clear", () => {
    expect(parseCropField({ crop: null })).toEqual({ present: true, crop: null });
  });
  it("a valid box is normalised by toCrop", () => {
    expect(parseCropField({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } })).toEqual({ present: true, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } });
    expect(parseCropField({ crop: { x: 0.12345678, y: 0, w: 0.5, h: 0.5 } })).toEqual({ present: true, crop: { x: 0.1235, y: 0, w: 0.5, h: 0.5 } });
  });
  it("a full-frame box is stored as no crop", () => {
    expect(parseCropField({ crop: { x: 0, y: 0, w: 1, h: 1 } })).toEqual({ present: true, crop: null });
  });
  it("invalid boxes are bad_crop (-> 400)", () => {
    for (const bad of [
      {}, "x", 5, [], { x: 0, y: 0, w: 0.01, h: 0.5 }, { x: 0.8, y: 0, w: 0.5, h: 0.5 },
      { x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: "0", y: 0, w: 0.5, h: 0.5 }, { x: NaN, y: 0, w: 0.5, h: 0.5 },
    ]) expect(parseCropField({ crop: bad })).toEqual({ error: "bad_crop" });
  });
});

describe("free / paid playable decision", () => {
  it("free: playable live and after the end (replay), not before", () => {
    expect(isPlayable({ free: true, hasVideo: true, state: "live" })).toBe(true);
    expect(isPlayable({ free: true, hasVideo: true, state: "ended" })).toBe(true);
    expect(isPlayable({ free: true, hasVideo: true, state: "none" })).toBe(true); // [SAATHUM-FREEVID-ANYTIME-1] free plays anytime
  });
  it("paid: live only — an ended paid event keeps today's no-player rule", () => {
    expect(isPlayable({ free: false, hasVideo: true, state: "live" })).toBe(true);
    expect(isPlayable({ free: false, hasVideo: true, state: "ended" })).toBe(false);
    expect(isPlayable({ free: false, hasVideo: true, state: "none" })).toBe(false);
  });
  it("no saved video is never playable; admin preview plays whenever a video is saved", () => {
    expect(isPlayable({ free: true, hasVideo: false, state: "live" })).toBe(false);
    expect(isPlayable({ free: false, hasVideo: true, state: "none", preview: true })).toBe(true);
    expect(isPlayable({ free: false, hasVideo: false, state: "live", preview: true })).toBe(false);
  });
  it("replay is advertised only for a free event that has ended", () => {
    expect(isReplay(true, "ended")).toBe(true);
    expect(isReplay(true, "live")).toBe(false);
    expect(isReplay(false, "ended")).toBe(false);
  });
});

describe("missing-column detection", () => {
  it("recognises D1/SQLite wording and nothing else", () => {
    expect(isMissingColumnError(new Error("D1_ERROR: no such column: free_watch at offset 7"))).toBe(true);
    expect(isMissingColumnError(new Error("table event_videos has no column named crop_x"))).toBe(true);
    expect(isMissingColumnError(new Error("D1_ERROR: database is locked"))).toBe(false);
  });
});

describe("admin event form: free_watch", () => {
  const base = { title: "Morning meditation", category: "meditation" };
  it("a free event needs no price and stores 0 (any sent price is ignored)", () => {
    const a = normalizeEventInput({ ...base, free_watch: true }, { partial: false });
    expect(a.errors).toEqual([]);
    expect(a.patch.free_watch).toBe(true);
    expect(a.patch.price).toBe(0);
    const b = normalizeEventInput({ ...base, free_watch: true, price: 500 }, { partial: false });
    expect(b.patch.price).toBe(0);
    expect(splitPatch(b.patch).edit.price).toBe(0);
  });
  it("a paid event still validates its price", () => {
    expect(normalizeEventInput({ ...base, free_watch: false, price: 0 }, { partial: false }).errors[0]?.field).toBe("price");
    expect(normalizeEventInput({ ...base, price: 251 }, { partial: false }).patch.price).toBe(251);
  });
  it("free_watch must be a boolean; it is not an attrs/admin-edit key", () => {
    expect(normalizeEventInput({ ...base, free_watch: "yes" }, { partial: false }).errors[0]?.field).toBe("free_watch");
    const { edit, attrs } = splitPatch(normalizeEventInput({ ...base, free_watch: true }, { partial: false }).patch);
    expect("free_watch" in edit).toBe(false);
    expect("free_watch" in attrs).toBe(false);
  });
});

describe("recordVideoView: 60 s rate limit per uid+listing", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE event_video_views (listing_id TEXT NOT NULL, uid TEXT NOT NULL, first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL, plays INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (listing_id, uid));`);
    return db;
  };
  const T0 = 1_760_000_000_000;
  it("first view inserts; a repeat inside 60 s is ignored without incrementing", async () => {
    const db = fresh(); const d = d1(db);
    expect(await recordVideoView(d, "L1", "u1", T0)).toEqual({ counted: true, firstView: true });
    expect(await recordVideoView(d, "L1", "u1", T0 + 30_000)).toEqual({ counted: false, firstView: false });
    expect(await recordVideoView(d, "L1", "u1", T0 + VIEW_RATE_LIMIT_MS - 1)).toEqual({ counted: false, firstView: false });
    expect(db.prepare("SELECT plays, first_at, last_at FROM event_video_views").get()).toEqual({ plays: 1, first_at: T0, last_at: T0 });
  });
  it("after 60 s a play counts: plays+1, last_at moves, first_at stays, first_view false", async () => {
    const db = fresh(); const d = d1(db);
    await recordVideoView(d, "L1", "u1", T0);
    expect(await recordVideoView(d, "L1", "u1", T0 + VIEW_RATE_LIMIT_MS)).toEqual({ counted: true, firstView: false });
    expect(db.prepare("SELECT plays, first_at, last_at FROM event_video_views").get()).toEqual({ plays: 2, first_at: T0, last_at: T0 + VIEW_RATE_LIMIT_MS });
  });
  it("other viewers and other listings are independent", async () => {
    const db = fresh(); const d = d1(db);
    await recordVideoView(d, "L1", "u1", T0);
    expect(await recordVideoView(d, "L1", "u2", T0 + 1)).toEqual({ counted: true, firstView: true });
    expect(await recordVideoView(d, "L2", "u1", T0 + 2)).toEqual({ counted: true, firstView: true });
  });
});

describe("analytics video_views SQL", () => {
  const DAY = 86_400_000;
  const seed = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE event_video_views (listing_id TEXT NOT NULL, uid TEXT NOT NULL, first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL, plays INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (listing_id, uid));
      CREATE TABLE listings (id TEXT PRIMARY KEY, title TEXT, free_watch INTEGER NOT NULL DEFAULT 0);
      INSERT INTO listings VALUES ('A','Satsang',1),('B','Havan',0);`);
    const ins = db.prepare("INSERT INTO event_video_views VALUES (?,?,?,?,?)");
    // window = [10*DAY, 20*DAY), previous = [0, 10*DAY)
    ins.run("A", "u1", 11 * DAY, 11 * DAY, 1);      // new in window
    ins.run("A", "u2", 12 * DAY, 15 * DAY, 3);      // new in window, 3 plays
    ins.run("B", "u1", 13 * DAY, 13 * DAY, 1);      // u1 again on another event
    ins.run("A", "u3", 2 * DAY, 14 * DAY, 4);       // first seen previous period, played again now
    ins.run("B", "u4", 3 * DAY, 4 * DAY, 2);        // previous period only
    return db;
  };
  it("counts viewers by first_at and plays by last_at, current vs previous", () => {
    const db = seed();
    const t = db.prepare(VIDEO_VIEWS_TOTALS_SQL).get(0, 10 * DAY, 20 * DAY);
    // viewers: distinct uid with first_at in window = u1,u2 ; previous = u3,u4
    expect(t).toMatchObject({ viewers_cur: 2, viewers_prev: 2, plays_cur: 1 + 3 + 1 + 4, plays_prev: 2 });
    expect(shapeVideoViews(t, []).viewers).toEqual({ cur: 2, prev: 2 });
  });
  it("by_event ranks events by viewers in the window and carries free", () => {
    const db = seed();
    const rows = db.prepare(videoViewsByEventSql(true)).all(10 * DAY, 20 * DAY);
    expect(shapeVideoViews(null, rows).by_event).toEqual([
      { listing_id: "A", title: "Satsang", free: true, kind: "event", viewers: 2, plays: 8 },
      { listing_id: "B", title: "Havan", free: false, kind: "event", viewers: 1, plays: 1 },
    ]);
  });
  it("the fallback query (no free_watch column) still runs and reports free=false", () => {
    const db = seed();
    const rows = db.prepare(videoViewsByEventSql(false)).all(10 * DAY, 20 * DAY);
    expect(shapeVideoViews(null, rows).by_event.every((e) => e.free === false)).toBe(true);
  });
  it("an empty table yields zeros, not nulls", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE event_video_views (listing_id TEXT, uid TEXT, first_at INTEGER, last_at INTEGER, plays INTEGER)");
    expect(shapeVideoViews(db.prepare(VIDEO_VIEWS_TOTALS_SQL).get(0, 1, 2), [])).toEqual({
      viewers: { cur: 0, prev: 0 }, plays: { cur: 0, prev: 0 }, by_event: [],
    });
  });
});
