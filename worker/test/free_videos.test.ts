// [SAATHUM-FREEVIDEOS-API-1 2026-10-01] Free videos: validation, the public card shape, ordering,
// admin create -> publish -> public, archive, live refresh and the analytics tag — against real
// SQLite (node:sqlite) through a tiny D1 shim, using the real migration file.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  validateFreeVideoInput, toCard, createFreeVideo, updateFreeVideo, archiveFreeVideo, listPublicCards, getRow,
  listAdmin, refreshFreeVideoLive, freeVideosRoute, ytThumbnail,
} from "../src/routes/free_videos";
import { shapeVideoViews, videoViewsByEventSql } from "../src/routes/admin2_analytics";
import { recordVideoView } from "../src/lib/freevid_compat";

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

const MIGRATION = readFileSync(new URL("../migrations/2026-10-01-free-videos.sql", import.meta.url), "utf8");
const VIEWS = readFileSync(new URL("../migrations/2026-10-01-freevid-views.sql", import.meta.url), "utf8");
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const good = { title: "Evening satsang", description: "Live from the ashram", category: "satsang", youtube_url: YT };

let raw: any; let db: D1Database;
beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec(MIGRATION); raw.exec(VIEWS);
  db = d1(raw);
});

function must(b: Record<string, unknown>, partial = false) {
  const r = validateFreeVideoInput(b, partial);
  if (!r.ok) throw new Error("expected valid: " + JSON.stringify(r.invalid));
  return r.value;
}

describe("validation", () => {
  it("accepts a good body and parses the youtube id", () => {
    const v = must(good);
    expect(v.youtube_video_id).toBe("dQw4w9WgXcQ");
    expect(v.title).toBe("Evening satsang");
  });
  it("rejects a bad category", () => {
    const r = validateFreeVideoInput({ ...good, category: "cricket" }, false);
    expect(r).toMatchObject({ ok: false, invalid: { error: "bad_category", field: "category" } });
  });
  it("rejects a bad crop (400 bad_crop) and keeps absent/null semantics", () => {
    for (const crop of [{ x: 0.8, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.01, h: 0.5 }, "x", {}]) {
      expect(validateFreeVideoInput({ ...good, crop }, false)).toMatchObject({ ok: false, invalid: { error: "bad_crop" } });
    }
    expect("crop" in must(good)).toBe(false);                      // absent = keep
    expect(must({ ...good, crop: null }).crop).toBeNull();          // null = clear
    expect(must({ ...good, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }).crop).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  });
  it("rejects a bad url (not YouTube / empty)", () => {
    for (const youtube_url of ["https://vimeo.com/123", "not a url", "", undefined]) {
      expect(validateFreeVideoInput({ ...good, youtube_url }, false)).toMatchObject({ ok: false, invalid: { error: "invalid_youtube_url" } });
    }
  });
  it("title 3-120 and description <= 600", () => {
    expect(validateFreeVideoInput({ ...good, title: "ab" }, false)).toMatchObject({ ok: false, invalid: { error: "invalid_title" } });
    expect(validateFreeVideoInput({ ...good, title: "x".repeat(121) }, false)).toMatchObject({ ok: false });
    expect(validateFreeVideoInput({ ...good, description: "x".repeat(601) }, false)).toMatchObject({ ok: false, invalid: { error: "invalid_description" } });
    expect(validateFreeVideoInput({ ...good, description: "x".repeat(600) }, false).ok).toBe(true);
  });
  it("create cannot start archived; PUT is partial", () => {
    expect(validateFreeVideoInput({ ...good, status: "archived" }, false)).toMatchObject({ ok: false, invalid: { error: "bad_status" } });
    expect(must({ status: "archived" }, true).status).toBe("archived");
    expect(must({ title: "Renamed video" }, true)).toEqual({ title: "Renamed video" });
  });
  it("cover must be https or empty", () => {
    expect(validateFreeVideoInput({ ...good, cover_url: "javascript:alert(1)" }, false)).toMatchObject({ ok: false });
    expect(must({ ...good, cover_url: "" }).cover_url).toBeNull();
    expect(must({ ...good, cover_url: "https://cdn.example/a.jpg" }).cover_url).toBe("https://cdn.example/a.jpg");
  });
});

describe("public card", () => {
  it("never contains youtube_video_id or source_url, anywhere in the JSON", async () => {
    const row = await createFreeVideo(db, must({ ...good, status: "published" }), "admin1", 1000);
    const card = toCard(row);
    expect(Object.keys(card).sort()).toEqual(["category", "category_label", "cover_url", "description", "id", "is_live", "published_at", "title"]);
    const json = JSON.stringify(await listPublicCards(db, { limit: 12 }));
    expect(json).not.toContain("youtube_video_id");
    expect(json).not.toContain("source_url");
    expect(json).not.toContain("watch?v=");
    expect(card.cover_url).toBe(ytThumbnail("dQw4w9WgXcQ"));
    expect(card.category_label).toBe("Satsang");
  });
  it("uses the uploaded cover when there is one", async () => {
    const row = await createFreeVideo(db, must({ ...good, cover_url: "https://cdn.example/c.jpg", status: "published" }), "a", 1);
    expect(toCard(row).cover_url).toBe("https://cdn.example/c.jpg");
  });
});

describe("list ordering + visibility", () => {
  it("is_live first, then sort_order ASC, then newest published", async () => {
    const mk = async (title: string, extra: Record<string, unknown>, at: number) =>
      createFreeVideo(db, must({ ...good, title, status: "published", ...extra }), "a", at);
    const a = await mk("Alpha video", { sort_order: 5 }, 100);
    const b = await mk("Bravo video", { sort_order: 1 }, 200);
    const c = await mk("Charlie video", { sort_order: 1 }, 300);   // same sort_order, newer -> before Bravo
    const d = await mk("Delta video", { sort_order: 9 }, 400);
    raw.prepare("UPDATE free_videos SET is_live=1 WHERE id=?").run(d.id);
    const ids = (await listPublicCards(db, { limit: 12 })).map((x) => x.id);
    expect(ids).toEqual([d.id, c.id, b.id, a.id]);
    expect((await listPublicCards(db, { limit: 2 })).length).toBe(2);
  });
  it("filters by category", async () => {
    await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    await createFreeVideo(db, must({ ...good, title: "Morning bhajan", category: "bhajan", status: "published" }), "a", 2);
    expect((await listPublicCards(db, { limit: 12, category: "bhajan" })).map((x) => x.title)).toEqual(["Morning bhajan"]);
  });
  it("drafts are not public", async () => {
    await createFreeVideo(db, must(good), "a", 1);
    expect(await listPublicCards(db, { limit: 12 })).toEqual([]);
  });
});

describe("admin create -> publish -> public; archive hides", () => {
  it("full lifecycle", async () => {
    const row = await createFreeVideo(db, must(good), "admin1", 1000);
    expect(row.status).toBe("draft");
    expect(row.id.startsWith("fv_")).toBe(true);
    expect(await listPublicCards(db, { limit: 12 })).toEqual([]);

    const pub = await updateFreeVideo(db, row.id, must({ status: "published" }, true), "admin1", 2000);
    expect(pub?.status).toBe("published");
    expect(pub?.published_at).toBe(2000);
    expect((await listPublicCards(db, { limit: 12 })).map((c) => c.id)).toEqual([row.id]);

    // crop: set, keep (absent), clear (null)
    let r = await updateFreeVideo(db, row.id, must({ crop: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } }, true), "admin1", 3000);
    expect(r?.crop_w).toBe(0.6);
    r = await updateFreeVideo(db, row.id, must({ title: "Still cropped" }, true), "admin1", 3100);
    expect(r?.crop_w).toBe(0.6);
    r = await updateFreeVideo(db, row.id, must({ crop: null }, true), "admin1", 3200);
    expect(r?.crop_w).toBeNull();

    expect(await archiveFreeVideo(db, row.id, "admin1", 4000)).toBe(true);
    expect((await getRow(db, row.id))?.status).toBe("archived");
    expect(await listPublicCards(db, { limit: 12 })).toEqual([]);
    expect(await archiveFreeVideo(db, "fv_missing", "admin1", 4000)).toBe(false);
    expect(await updateFreeVideo(db, "fv_missing", must({ title: "Nope nope" }, true), "a", 1)).toBeNull();
  });
  it("changing the video id resets is_live; admin list includes drafts, urls and view counts", async () => {
    const row = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    raw.prepare("UPDATE free_videos SET is_live=1 WHERE id=?").run(row.id);
    const r = await updateFreeVideo(db, row.id, must({ youtube_url: "https://youtu.be/abcdefghijk" }, true), "a", 2);
    expect(r?.is_live).toBe(0);
    expect(r?.youtube_video_id).toBe("abcdefghijk");
    await createFreeVideo(db, must({ ...good, title: "A draft one" }), "a", 3);
    await recordVideoView(db, row.id, "u1", 10_000_000);
    const all = await listAdmin(db);
    expect(all.length).toBe(2);
    const mine = all.find((x) => x.id === row.id)!;
    expect(mine.youtube_url).toBe("https://youtu.be/abcdefghijk");
    expect(mine.viewers).toBe(1);
  });
});

describe("routing + missing table", () => {
  const env = (extra: Record<string, unknown> = {}) => ({ DB_META: db, ...extra }) as any;
  it("public list answers { items: [] } (not 500) when the table is missing", async () => {
    raw.exec("DROP TABLE free_videos");
    const res = await freeVideosRoute(new Request("https://x/api/free-videos?limit=3"), env(), "/api/free-videos");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ items: [] });
  });
  it("public list is cacheable 60s and unknown category is 400", async () => {
    const res = await freeVideosRoute(new Request("https://x/api/free-videos"), env(), "/api/free-videos");
    expect(res?.headers.get("cache-control")).toBe("public, max-age=60");
    const bad = await freeVideosRoute(new Request("https://x/api/free-videos?category=zzz"), env(), "/api/free-videos");
    expect(bad?.status).toBe(400);
  });
  it("card route: published 200 (no video id), draft/archived 404", async () => {
    const pub = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    const draft = await createFreeVideo(db, must(good), "a", 2);
    const ok = await freeVideosRoute(new Request("https://x/"), env(), `/api/free-videos/${pub.id}`);
    expect(ok?.status).toBe(200);
    const body = JSON.stringify(await ok!.json());
    expect(body).not.toContain("youtube_video_id");
    expect(body).not.toContain("watch?v=");
    const no = await freeVideosRoute(new Request("https://x/"), env(), `/api/free-videos/${draft.id}`);
    expect(no?.status).toBe(404);
    await archiveFreeVideo(db, pub.id, "a", 3);
    expect((await freeVideosRoute(new Request("https://x/"), env(), `/api/free-videos/${pub.id}`))?.status).toBe(404);
  });
  it("watch/view without a valid session are refused (never 200, no video id)", async () => {
    const pub = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    const w = await freeVideosRoute(new Request("https://x/"), env(), `/api/free-videos/${pub.id}/watch`);
    expect(w && w.status !== 200).toBe(true);
    expect(await w!.text()).not.toContain("youtube_video_id");
    const v = await freeVideosRoute(new Request("https://x/", { method: "POST" }), env(), `/api/free-videos/${pub.id}/view`);
    expect(v && v.status !== 200).toBe(true);
  });
  it("other paths / methods are not ours", async () => {
    expect(await freeVideosRoute(new Request("https://x/", { method: "POST" }), env(), "/api/free-videos")).toBeNull();
    expect(await freeVideosRoute(new Request("https://x/"), env(), "/api/free-videos/a/b/c")).toBeNull();
  });
});

describe("live refresh (cron)", () => {
  const fakeFetch = (liveIds: string[], seen: string[] = []) => (async (url: string) => {
    seen.push(String(url));
    const ids = new URL(String(url)).searchParams.get("id")!.split(",");
    return new Response(JSON.stringify({ items: ids.map((id) => ({ id, snippet: { liveBroadcastContent: liveIds.includes(id) ? "live" : "none" } })) }));
  }) as unknown as typeof fetch;

  it("no key -> skipped, is_live untouched", async () => {
    await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    const r = await refreshFreeVideoLive({ DB_META: db } as any, fakeFetch(["dQw4w9WgXcQ"]));
    expect(r.api).toBe("skipped");
    expect((await listPublicCards(db, { limit: 5 }))[0].is_live).toBe(false);
  });
  it("sets is_live for live videos, clears it for ended ones, ignores drafts", async () => {
    const a = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    const b = await createFreeVideo(db, must({ ...good, title: "Second video", youtube_url: "https://youtu.be/abcdefghijk", status: "published" }), "a", 2);
    const draft = await createFreeVideo(db, must({ ...good, title: "Draft video", youtube_url: "https://youtu.be/zzzzzzzzzzz" }), "a", 3);
    raw.prepare("UPDATE free_videos SET is_live=1 WHERE id=?").run(b.id);
    const seen: string[] = [];
    const r = await refreshFreeVideoLive({ DB_META: db, YOUTUBE_API_KEY: "k" } as any, fakeFetch(["dQw4w9WgXcQ"], seen));
    expect(r).toMatchObject({ checked: 2, live: 1, api: "ok" });
    expect((await getRow(db, a.id))?.is_live).toBe(1);
    expect((await getRow(db, b.id))?.is_live).toBe(0);
    expect((await getRow(db, draft.id))?.live_checked_at).toBeNull();
    expect(seen.length).toBe(1);
  });
  it("batches 50 ids per API call", async () => {
    for (let i = 0; i < 120; i++) {
      const id = "vid" + String(i).padStart(8, "0");
      await createFreeVideo(db, must({ ...good, title: "Video " + i, youtube_url: id, status: "published" }), "a", i);
    }
    const seen: string[] = [];
    const r = await refreshFreeVideoLive({ DB_META: db, YOUTUBE_API_KEY: "k" } as any, fakeFetch([], seen));
    expect(seen.length).toBe(3);
    expect(r.checked).toBe(120);
  });
  it("a failed API batch leaves rows alone", async () => {
    const a = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    raw.prepare("UPDATE free_videos SET is_live=1 WHERE id=?").run(a.id);
    const r = await refreshFreeVideoLive({ DB_META: db, YOUTUBE_API_KEY: "k" } as any, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    expect(r.api).toBe("error");
    expect((await getRow(db, a.id))?.is_live).toBe(1);
  });
});

describe("analytics: titles + kind for free videos", () => {
  it("by_event titles fv_ ids from free_videos and tags kind", async () => {
    raw.exec("CREATE TABLE listings (id TEXT PRIMARY KEY, title TEXT, free_watch INTEGER)");
    raw.prepare("INSERT INTO listings VALUES ('l1','An event',1)").run();
    const fv = await createFreeVideo(db, must({ ...good, status: "published" }), "a", 1);
    await recordVideoView(db, fv.id, "u1", 5000);
    await recordVideoView(db, fv.id, "u2", 5000);
    await recordVideoView(db, "l1", "u1", 5000);
    const rows = raw.prepare(videoViewsByEventSql(true, true)).all(0, 10_000);
    const by = shapeVideoViews(null, rows).by_event;
    expect(by[0]).toMatchObject({ listing_id: fv.id, title: "Evening satsang", kind: "free_video", viewers: 2 });
    expect(by[1]).toMatchObject({ listing_id: "l1", title: "An event", kind: "event", free: true });
    // without the free_videos join the kind is still right (id prefix), title is null
    const plain = shapeVideoViews(null, raw.prepare(videoViewsByEventSql(true)).all(0, 10_000)).by_event;
    expect(plain.find((e) => e.listing_id === fv.id)).toMatchObject({ kind: "free_video", title: null });
  });
});
