// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-4] Reels feed: flag, online-only, hidden/unapproved/disconnected excluded, demo switch, owner-only PATCH, paging, idempotent import.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));

import { hfReelsRoute, profileReels } from "./hf_reels";
import { importChannelReels, youtubeRecent, instagramRecent, isoSeconds } from "../lib/hf_reels_import";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', avatar_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);`);
  db.exec(mig("2026-10-19-hf-channels.sql"));
  db.exec(mig("2026-10-19-hf-reels.sql"));
  db.exec(mig("2026-10-19-hf-demo-hosts.sql"));
  const kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) }, BLOSSOM_BASE_URL: "https://media.test",
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
  };
}

let n = 0;
function host(uid: string, o: any = {}) {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, price_per_min, presence) VALUES (?,?,?,?,?,?)")
    .run(uid, o.slug === undefined ? "slug-" + uid : o.slug, o.status ?? "approved", o.name ?? "Name " + uid, o.rate ?? 12, o.presence ?? "online");
  if (o.channel !== false) db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("hfch_" + uid, uid, "instagram", "@" + uid, o.followers ?? 100, o.chStatus ?? "approved", 1, 1);
}
function reel(id: string, uid: string, o: any = {}) {
  db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, visible, is_demo, published_at, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, uid, o.demo ? null : "hfch_" + uid, "instagram", "v" + (++n), "https://e/" + id, "cap " + id, o.visible ?? 1, o.demo ? 1 : 0, o.at ?? 1000 + n, 1);
}
const call = (path: string, init: any = {}) => hfReelsRoute(new Request("https://x" + path, init), env, path.split("?")[0]);
const body = async (r: Response) => ({ status: r.status, ...(await r.json()) });
const ids = (j: any) => j.items.map((i: any) => i.id);

beforeEach(() => { makeEnv(); cfg = { hfReelsEnabled: true, hfDemoInfluencersVisible: true }; authFail = null; n = 0; });

describe("flag + auth", () => {
  it("flag off -> 404 on every route", async () => {
    cfg = { hfReelsEnabled: false };
    expect((await call("/api/hf/reels")).status).toBe(404);
    expect((await call("/api/hf/hosts/me/reels")).status).toBe(404);
    expect((await call("/api/hf/reels/hfrl_abcdefgh12", { method: "PATCH", body: "{}" })).status).toBe(404);
  });
  it("own reels need sign-in", async () => {
    authFail = { status: 401, error: "unauthorized" };
    expect((await call("/api/hf/hosts/me/reels")).status).toBe(401);
  });
});

describe("feed", () => {
  it("only visible reels of online, approved hosts with a connected channel", async () => {
    host("a"); reel("hfrl_aaaaaaaa01", "a");
    host("b", { presence: "offline" }); reel("hfrl_bbbbbbbb01", "b");
    host("c", { presence: "busy" }); reel("hfrl_cccccccc01", "c");
    host("d", { status: "pending_check" }); reel("hfrl_dddddddd01", "d");
    host("e"); reel("hfrl_eeeeeeee01", "e", { visible: 0 });
    host("f", { chStatus: "disconnected" }); reel("hfrl_ffffffff01", "f");
    host("g", { slug: null }); reel("hfrl_gggggggg01", "g");
    host("h", { status: "live", followers: 5 }); reel("hfrl_hhhhhhhh01", "h");
    const j = await body(await call("/api/hf/reels"));
    expect(j.ok).toBe(true);
    expect(ids(j).sort()).toEqual(["hfrl_aaaaaaaa01", "hfrl_hhhhhhhh01"]);
    const it = j.items.find((i: any) => i.id === "hfrl_aaaaaaaa01");
    expect(it.host).toMatchObject({ slug: "slug-a", name: "Name a", handle: "@a", ratePaise: 1200, followers: 100, presence: "online" });
    expect(JSON.stringify(j)).not.toMatch(/"uid"|host_uid/);
    expect(j.nextCursor).toBeNull();
  });
  it("demo hosts only while hfDemoInfluencersVisible", async () => {
    host("real"); reel("hfrl_realrealreal1", "real");
    host("demo", { channel: false }); reel("hfrl_demodemodemo1", "demo", { demo: true });
    db.prepare("INSERT INTO hf_demo_hosts (host_uid, handle, followers, created_at) VALUES ('demo','priya.demo',1234,1)").run();
    let j = await body(await call("/api/hf/reels"));
    expect(ids(j)).toContain("hfrl_demodemodemo1");
    expect(j.items.find((i: any) => i.id === "hfrl_demodemodemo1").host).toMatchObject({ handle: "@priya.demo", followers: 1234 });
    cfg = { hfReelsEnabled: true, hfDemoInfluencersVisible: false };
    j = await body(await call("/api/hf/reels"));
    expect(ids(j)).toEqual(["hfrl_realrealreal1"]);
    expect((await call("/api/hf/reels/hfrl_demodemodemo1")).status).toBe(404);
  });
  it("pages newest first with a cursor", async () => {
    host("a");
    for (let i = 1; i <= 5; i++) reel("hfrl_page000" + i + "aa", "a", { at: 5000 + i });
    const p1 = await body(await call("/api/hf/reels?limit=2"));
    expect(ids(p1)).toEqual(["hfrl_page0005aa", "hfrl_page0004aa"]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await body(await call("/api/hf/reels?limit=2&cursor=" + p1.nextCursor));
    expect(ids(p2)).toEqual(["hfrl_page0003aa", "hfrl_page0002aa"]);
    const p3 = await body(await call("/api/hf/reels?limit=2&cursor=" + p2.nextCursor));
    expect(ids(p3)).toEqual(["hfrl_page0001aa"]);
    expect(p3.nextCursor).toBeNull();
    expect((await call("/api/hf/reels?cursor=junk")).status).toBe(400);
  });
  it("one reel by id works for an offline host (deep link); hidden ones 404", async () => {
    host("b", { presence: "offline" }); reel("hfrl_bbbbbbbb01", "b"); reel("hfrl_bbbbbbbb02", "b", { visible: 0 });
    const j = await body(await call("/api/hf/reels/hfrl_bbbbbbbb01"));
    expect(j.item.host.presence).toBe("offline");
    expect((await call("/api/hf/reels/hfrl_bbbbbbbb02")).status).toBe(404);
  });
});

describe("own reels + PATCH", () => {
  it("lists all of mine (hidden too), not other people's, not a disconnected channel's", async () => {
    host("me"); reel("hfrl_mine00001", "me"); reel("hfrl_mine00002", "me", { visible: 0 });
    host("other"); reel("hfrl_other0001", "other");
    host("gone", { chStatus: "disconnected" }); reel("hfrl_gone00001", "gone");
    const j = await body(await call("/api/hf/hosts/me/reels", { headers: { "x-test-uid": "me" } }));
    expect(j.reels.map((r: any) => r.id).sort()).toEqual(["hfrl_mine00001", "hfrl_mine00002"]);
    expect(j.onFeed).toBe(1);
    const g = await body(await call("/api/hf/hosts/me/reels", { headers: { "x-test-uid": "gone" } }));
    expect(g.reels).toEqual([]);
  });
  it("only the owner can show / hide; validates the body", async () => {
    host("me"); reel("hfrl_mine00002", "me", { visible: 0 });
    const patch = (uid: string, b: any) => call("/api/hf/reels/hfrl_mine00002", { method: "PATCH", headers: { "x-test-uid": uid }, body: JSON.stringify(b) });
    expect((await patch("intruder", { visible: true })).status).toBe(404);
    expect(db.prepare("SELECT visible FROM hf_reels WHERE id='hfrl_mine00002'").get().visible).toBe(0);
    expect((await patch("me", { visible: "yes" })).status).toBe(400);
    const j = await body(await patch("me", { visible: true }));
    expect(j.reel.visible).toBe(true);
    expect(ids(await body(await call("/api/hf/reels")))).toContain("hfrl_mine00002");
    await patch("me", { visible: false });
    expect(ids(await body(await call("/api/hf/reels")))).not.toContain("hfrl_mine00002");
  });
  it("view counter only counts visible reels and is rate limited", async () => {
    host("a"); reel("hfrl_viewview01", "a"); reel("hfrl_viewview02", "a", { visible: 0 });
    const v = (id: string) => call(`/api/hf/reels/${id}/view`, { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" } });
    for (let i = 0; i < 3; i++) expect((await v("hfrl_viewview01")).status).toBe(200);
    expect((await v("hfrl_viewview01")).status).toBe(429);
    await v("hfrl_viewview02");
    expect(db.prepare("SELECT views FROM hf_reels WHERE id='hfrl_viewview01'").get().views).toBe(3);
    expect(db.prepare("SELECT views FROM hf_reels WHERE id='hfrl_viewview02'").get().views).toBe(0);
  });
});

describe("profile reels", () => {
  it("visible only + followers; null while flag is off", async () => {
    host("a", { followers: 70 }); reel("hfrl_prof00001", "a"); reel("hfrl_prof00002", "a", { visible: 0 });
    const pr = await profileReels(env, "a", cfg);
    expect(pr.reels.map((r: any) => r.id)).toEqual(["hfrl_prof00001"]);
    expect(pr.followers).toBe(70);
    expect(await profileReels(env, "a", { hfReelsEnabled: false })).toBeNull();
  });
});

describe("importer", () => {
  const ch = { id: "hfch_x1", host_uid: "x", platform: "instagram", handle: "@x", platform_user_id: "9" };
  const fake = (likes: number) => ({
    instagram: async () => [
      { platformVideoId: "AAAAAA", url: "u1", embedUrl: "e1", thumbUrl: "t1", caption: "c1", likes, comments: 1, views: 10, publishedAt: 5 },
      { platformVideoId: "BBBBBB", url: "u2", embedUrl: "e2", thumbUrl: null, caption: "c2", likes, comments: 0, views: 3, publishedAt: null },
    ],
  });
  it("is idempotent, starts visible (HF-REEL-33), stores no video file and never flips visible back", async () => {
    host("x", { channel: false });
    db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at) VALUES ('hfch_x1','x','instagram','@x',50,'approved',1,1)").run();
    expect(await importChannelReels(env, ch, 20, fake(1))).toMatchObject({ fetched: 2, inserted: 2, updated: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels WHERE visible=1").get().c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels WHERE video_url IS NOT NULL").get().c).toBe(0);
    db.prepare("UPDATE hf_reels SET visible=0 WHERE platform_video_id='BBBBBB'").run();
    expect(await importChannelReels(env, ch, 20, fake(7))).toMatchObject({ inserted: 0, updated: 2 });
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels").get().c).toBe(2);
    const a = db.prepare("SELECT visible, likes FROM hf_reels WHERE platform_video_id='AAAAAA'").get();
    expect(a).toMatchObject({ visible: 1, likes: 7 });
    expect(db.prepare("SELECT visible FROM hf_reels WHERE platform_video_id='BBBBBB'").get().visible).toBe(0); // she hid it: re-import keeps it hidden
  });
  it("YouTube: imports all public videos (not only Shorts), embed urls, title and description", async () => {
    const f = async (url: string) => {
      if (url.includes("/playlistItems")) return new Response(JSON.stringify({ items: [{ contentDetails: { videoId: "longvideo01" } }, { contentDetails: { videoId: "shortvideo1" } }] }));
      return new Response(JSON.stringify({ items: [
        { id: "longvideo01", snippet: { title: "Long", description: "about it", publishedAt: "2026-10-01T00:00:00Z" }, contentDetails: { duration: "PT12M3S" }, statistics: { viewCount: "9" } },
        { id: "shortvideo1", snippet: { title: "Short", publishedAt: "2026-10-02T00:00:00Z", thumbnails: { high: { url: "https://i/h.jpg" } } }, contentDetails: { duration: "PT45S" }, statistics: { viewCount: "5", likeCount: "2" } },
      ] }));
    };
    const out = await youtubeRecent({ YOUTUBE_API_KEY: "k" }, "UC1234567890123456789012", 5, f);
    expect(out.map((r) => r.platformVideoId)).toEqual(["longvideo01", "shortvideo1"]);
    expect(out[0]).toMatchObject({ caption: "Long", description: "about it" });
    expect(out[1]).toMatchObject({ embedUrl: "https://www.youtube.com/embed/shortvideo1", thumbUrl: "https://i/h.jpg", likes: 2, views: 5 });
    expect(out.some((r: any) => "videoUrl" in r)).toBe(false);
    expect(isoSeconds("PT1M5S")).toBe(65);
  });
  it("Instagram: maps the ScrapeCreators shape; provider outage is a ProviderError", async () => {
    const f = async () => new Response(JSON.stringify({ items: [{ media: { code: "CxYz123", caption: { text: "hi" }, like_count: 4, play_count: 99, taken_at: 1700000000,
      video_versions: [{ url: "https://cdn/v.mp4" }], image_versions2: { candidates: [{ url: "https://cdn/t.jpg" }] } } }] }));
    const out = await instagramRecent({ TREG_API_KEY: "t" }, "@maya", 5, f);
    expect(out[0]).toMatchObject({ platformVideoId: "CxYz123", embedUrl: "https://www.instagram.com/reel/CxYz123/embed", views: 99, publishedAt: 1700000000000 });
    await expect(instagramRecent({ TREG_API_KEY: "t" }, "maya", 5, async () => new Response("x", { status: 500 }))).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(instagramRecent({}, "maya", 5, f)).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});
