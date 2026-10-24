// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-22] Invite reels (HF-REEL-40) + search platform filter (HF-REEL-41).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }), isFail: (u: any) => !!u?.error }));

import { hfSearchRoute } from "./hf_search";
import { hfReelsRoute } from "./hf_reels";
import { hfInviteAdminRoute } from "./hf_invite_admin";
import { refreshInviteCreators, storeInviteReels, hasJoined, youtubeInviteReels } from "../lib/hf_invite_reels";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>;
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', avatar_id TEXT, topics_json TEXT NOT NULL DEFAULT '[]', phone TEXT,
    women_lane INTEGER NOT NULL DEFAULT 0, lgbtq_lane INTEGER NOT NULL DEFAULT 0, lgbtq_public INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_selfie (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);`);
  for (const f of ["2026-10-19-hf-channels.sql", "2026-10-19-hf-demo-hosts.sql", "2026-10-19-hf-invite-votes.sql", "2026-10-19-hf-reels.sql", "2026-10-20-hf-invite-creators.sql", "hf_creator_spaces.sql"]) db.exec(mig(f));
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) }, BLOSSOM_BASE_URL: "https://media.test", ADMIN_UIDS: "admin1",
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
    YOUTUBE_API_KEY: "yt-key", TREG_API_KEY: "tk",
  };
}

const CH_ID = "UCabcdefghijklmnopqrstuv";
/** Fake network: YouTube channels / playlistItems / videos, treg Instagram profile + reels. */
function fakeFetch(calls: string[] = [], opts: { igReels?: any[] } = {}) {
  return async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const ok = (b: any) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname.endsWith("/channels")) {
      return ok({ items: [{ id: CH_ID, snippet: { customUrl: "@newstar", title: "New Star", thumbnails: { default: { url: "https://yt3.test/a.jpg" } } }, statistics: { subscriberCount: "4200" } }] });
    }
    if (u.pathname.endsWith("/playlistItems")) return ok({ items: ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((v) => ({ contentDetails: { videoId: v } })) });
    if (u.pathname.endsWith("/videos")) {
      const mk = (id: string, dur: string) => ({ id, snippet: { title: "T " + id, publishedAt: "2026-10-01T00:00:00Z" }, statistics: { likeCount: "5", viewCount: "99", commentCount: "1" }, contentDetails: { duration: dur } });
      return ok({ items: [mk("aaaaaaaaaaa", "PT12M"), mk("bbbbbbbbbbb", "PT30S"), mk("ccccccccccc", "PT59S")] });
    }
    if (u.pathname.includes("instagram.user.profile")) return ok({ data: { user: { id: "777", username: "iggirl", full_name: "IG Girl", edge_followed_by: { count: 900 } } } });
    if (u.pathname.includes("instagram-user-reels")) return ok({ items: opts.igReels ?? [{ code: "CODE12345", caption: "hi", like_count: 3, play_count: 50, video_url: "https://cdn/v.mp4", taken_at: 1760000000 }] });
    return new Response("{}", { status: 404 });
  };
}

const host = (uid: string, o: any = {}) => {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, presence) VALUES (?,?,?,?,?)").run(uid, "slug-" + uid, "approved", o.name ?? "Name " + uid, o.presence ?? "online");
  if (o.handle) db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at, platform_user_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("hfch_" + uid, uid, o.platform ?? "instagram", o.handle, 500, "approved", 1, 1, o.pid ?? null);
};
const search = async (path: string, f?: any, ctx?: any) => (await hfSearchRoute(new Request("https://x" + path, { headers: { "x-test-uid": "u1" } }), env, path.split("?")[0], f ?? fakeFetch(), ctx)).json();
const vote = (platform: string, handle: string, f?: any, uid = "u1") => hfSearchRoute(new Request(`https://x/api/hf/invites/${platform}/${handle}`, { method: "POST", headers: { "x-test-uid": uid } }), env, `/api/hf/invites/${platform}/${handle}`, f ?? fakeFetch());
const feed = async (qs = "") => (await hfReelsRoute(new Request("https://x/api/hf/reels" + qs), env, "/api/hf/reels")).json();
const admin = (method: string, path: string, body?: any, prov: any = { f: fakeFetch() }, uid = "admin1") =>
  hfInviteAdminRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid }, body: body === undefined ? undefined : JSON.stringify(body) }), env, path, prov);
const cnt = (t: string) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

beforeEach(() => { makeEnv(); cfg = { hfReelsEnabled: true, hfInvitesEnabled: true, hfDemoInfluencersVisible: true }; });

describe("invite creators from an exact-handle search", () => {
  it("stores the creator and up to 6 embed-only reels (Shorts first), never a video file", async () => {
    const j = await search("/api/hf/search?q=@newstar&platform=youtube");
    expect(j.notOnNetwork).toEqual([expect.objectContaining({ handle: "@newstar", platform: "youtube", followers: 4200 })]);
    expect(db.prepare("SELECT platform_user_id, display_name, avatar_url, source FROM hf_invite_creators").get()).toMatchObject({ platform_user_id: CH_ID, display_name: "New Star", avatar_url: "https://yt3.test/a.jpg", source: "search" });
    const reels = db.prepare("SELECT * FROM hf_invite_reels ORDER BY published_at, platform_video_id").all();
    expect(reels.map((r: any) => r.platform_video_id).sort()).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
    expect(reels[0].embed_url).toMatch(/youtube\.com\/embed\//);
    expect(Object.keys(reels[0])).not.toContain("video_url"); // no video file column at all
    expect(JSON.stringify(reels)).not.toMatch(/\.mp4/);
  });
  it("prefers Shorts (<= 60 s) when there are more videos than slots", async () => {
    const f = fakeFetch();
    const r = await youtubeInviteReels(env, CH_ID, 2, f);
    expect(r.map((x) => x.platformVideoId)).toEqual(["bbbbbbbbbbb", "ccccccccccc"]);
  });
  it("de-dupes: searching again or voting re-uses the creator and the 6 h rate limit skips a second fetch", async () => {
    const calls: string[] = [];
    const f = fakeFetch(calls);
    await search("/api/hf/search?q=@newstar&platform=youtube", f);
    const n1 = calls.filter((u) => u.includes("/playlistItems")).length;
    await search("/api/hf/search?q=@newstar&platform=youtube", f);
    expect((await vote("youtube", "newstar", f)).status).toBe(200);
    expect(calls.filter((u) => u.includes("/playlistItems")).length).toBe(n1);
    expect(cnt("hf_invite_creators")).toBe(1);
    expect(cnt("hf_invite_reels")).toBe(3);
    expect(db.prepare("SELECT source FROM hf_invite_creators").get().source).toBe("vote");
  });
  it("uses ctx.waitUntil for the background fetch when it is available", async () => {
    const jobs: Promise<unknown>[] = [];
    await search("/api/hf/search?q=@newstar&platform=youtube", undefined, { waitUntil: (p: Promise<unknown>) => jobs.push(p) });
    expect(jobs.length).toBe(1);
    await Promise.all(jobs);
    expect(cnt("hf_invite_reels")).toBe(3);
  });
  it("flag hfInviteReelsEnabled=false: nothing is stored and the feed shows no invite reels", async () => {
    cfg.hfInviteReelsEnabled = false;
    await search("/api/hf/search?q=@newstar&platform=youtube");
    expect(cnt("hf_invite_creators")).toBe(0);
    cfg.hfInviteReelsEnabled = true;
    await search("/api/hf/search?q=@newstar&platform=youtube");
    expect(cnt("hf_invite_reels")).toBe(3);
    cfg.hfInviteReelsEnabled = false;
    expect((await feed()).items).toEqual([]);
  });
  it("Instagram reels come from treg and keep details only", async () => {
    await search("/api/hf/search?q=@iggirl&platform=instagram");
    const r = db.prepare("SELECT * FROM hf_invite_reels").get();
    expect(r).toMatchObject({ platform: "instagram", platform_video_id: "CODE12345", embed_url: "https://www.instagram.com/reel/CODE12345/embed", views: 50 });
    expect(JSON.stringify(r)).not.toContain("mp4");
  });
});

describe("feed", () => {
  const seed = async () => { await search("/api/hf/search?q=@newstar&platform=youtube"); await vote("youtube", "newstar"); };
  it("is not empty when only invite reels exist, shape has kind:'invite' and creator block", async () => {
    await seed();
    const j = await feed();
    expect(j.items.length).toBe(3);
    expect(j.nextCursor).toBeNull();
    expect(j.items[0]).toMatchObject({ kind: "invite", platform: "youtube", creator: { platform: "youtube", handle: "@newstar", name: "New Star", followers: 4200, votes: 1 } });
    expect(j.items[0].embedUrl).toMatch(/embed/);
    expect(j.items[0].videoUrl).toBeUndefined();
    expect(j.items[0].host).toBeUndefined();
  });
  it("network reels first, then invite reels; the cursor pages across both", async () => {
    await seed();
    host("h1", { handle: "@star", platform: "instagram" });
    for (const [i, id] of ["hfrl_aaaaaaaa01", "hfrl_aaaaaaaa02"].entries())
      db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, url, embed_url, caption, visible, is_demo, imported_at, published_at) VALUES (?,?,?,?,?,?,?,?,1,0,?,?)")
        .run(id, "h1", "hfch_h1", "instagram", "V" + i + "xxxxx", "u", "https://www.instagram.com/reel/V" + i + "xxxxx/embed", "c", 10 + i, 10 + i);
    const p1 = await feed("?limit=3");
    expect(p1.items.map((x: any) => x.kind ?? "network")).toEqual(["network", "network", "invite"]);
    expect(p1.nextCursor).toMatch(/^i:1$/);
    const p2 = await feed("?limit=3&cursor=" + p1.nextCursor);
    expect(p2.items.map((x: any) => x.kind)).toEqual(["invite", "invite"]);
    expect(p2.nextCursor).toBeNull();
    // exactly-full network page still hands over to the invite part
    const q1 = await feed("?limit=2");
    expect(q1.items.length).toBe(2);
    expect(q1.nextCursor).toBe("i:0");
    expect((await feed("?limit=2&cursor=i:0")).items.length).toBe(2);
    expect((await hfReelsRoute(new Request("https://x/api/hf/reels?cursor=junk"), env, "/api/hf/reels")).status).toBe(400);
  });
  it("round-robins across creators so one creator does not fill the page", async () => {
    await seed();
    await search("/api/hf/search?q=@iggirl&platform=instagram");
    const j = await feed("?limit=2");
    expect(new Set(j.items.map((x: any) => x.creator.handle)).size).toBe(2);
  });
  it("a creator who joined disappears from the feed and from the table on the next refresh", async () => {
    await seed();
    expect((await feed()).items.length).toBe(3);
    host("h2", { handle: "@NewStar", platform: "youtube", pid: CH_ID });
    expect((await feed()).items).toEqual([]); // hidden at once, no cron needed
    expect(await hasJoined(env, "youtube", "newstar", null)).toBe(true);
    db.prepare("UPDATE hf_invite_creators SET reels_fetched_at=1").run();
    expect(await refreshInviteCreators(env, 15, { f: fakeFetch() })).toMatchObject({ joined: 1 });
    expect(cnt("hf_invite_creators")).toBe(0);
    expect(cnt("hf_invite_reels")).toBe(0);
  });
  it("joined creators are matched by platform user id even if the handle changed", async () => {
    await seed();
    host("h3", { handle: "@renamed", platform: "youtube", pid: CH_ID });
    expect((await feed()).items).toEqual([]);
  });
  it("a joined creator is not re-added by a later search", async () => {
    host("h2", { handle: "@newstar", platform: "youtube", pid: CH_ID });
    const j = await search("/api/hf/search?q=@newstar&platform=youtube");
    expect(j.notOnNetwork).toEqual([]);
    expect(cnt("hf_invite_creators")).toBe(0);
  });
});

describe("cron refresh and prune", () => {
  it("prunes creators with no votes and no searches for 30 days; keeps voted, admin and fresh ones", async () => {
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    const ins = (h: string, src: string, at: number) => db.prepare("INSERT INTO hf_invite_creators (platform, handle, last_lookup_at, source, created_at) VALUES ('youtube',?,?,?,?)").run(h, at, src, at);
    ins("stale", "search", old); ins("voted", "vote", old); ins("pinned", "admin", old); ins("fresh", "search", Date.now());
    db.prepare("INSERT INTO hf_invite_votes (handle, platform, uid, at) VALUES ('voted','youtube','u9',1)").run();
    const r = await refreshInviteCreators(env, 15, { f: fakeFetch() });
    expect(r.pruned).toBe(1);
    expect(db.prepare("SELECT handle FROM hf_invite_creators ORDER BY handle").all().map((x: any) => x.handle)).toEqual(["fresh", "pinned", "voted"]);
  });
  it("refresh updates followers and stores reels", async () => {
    db.prepare("INSERT INTO hf_invite_creators (platform, handle, last_lookup_at, source, created_at, followers) VALUES ('youtube','newstar',?,'search',?,5)").run(Date.now(), Date.now());
    expect(await refreshInviteCreators(env, 15, { f: fakeFetch() })).toMatchObject({ scanned: 1, refreshed: 1 });
    expect(db.prepare("SELECT followers FROM hf_invite_creators").get().followers).toBe(4200);
    expect(cnt("hf_invite_reels")).toBe(3);
  });
  it("storeInviteReels replaces older reels of the creator and upserts stats", async () => {
    const r = (id: string, views: number) => ({ platformVideoId: id, url: "u", embedUrl: "https://www.youtube.com/embed/" + id, thumbUrl: null, caption: "c", likes: 1, comments: 1, views, publishedAt: 1 });
    await storeInviteReels(env, "youtube", "x", [r("aaaaaaaaaaa", 1), r("bbbbbbbbbbb", 1)]);
    await storeInviteReels(env, "youtube", "x", [r("bbbbbbbbbbb", 77)]);
    expect(db.prepare("SELECT platform_video_id, views FROM hf_invite_reels").all()).toEqual([{ platform_video_id: "bbbbbbbbbbb", views: 77 }]);
  });
});

describe("admin invite creators", () => {
  it("admins only; adds by platform + handle (fetching reels), lists, hides and unhides", async () => {
    expect((await admin("GET", "/api/admin/hf/invite-creators", undefined, undefined, "u1")).status).toBe(403);
    const r = await admin("POST", "/api/admin/hf/invite-creators", { platform: "youtube", handle: "https://www.youtube.com/@NewStar" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, reels: 3, creator: { handle: "@newstar", followers: 4200 } });
    const list = await (await admin("GET", "/api/admin/hf/invite-creators")).json();
    expect(list.items[0]).toMatchObject({ handle: "@newstar", platform: "youtube", source: "admin", hidden: false, reels: 3, votes: 0 });
    expect((await feed()).items.length).toBe(3);
    expect((await admin("PATCH", "/api/admin/hf/invite-creators/youtube/newstar", { hidden: true })).status).toBe(200);
    expect((await feed()).items).toEqual([]);
    // a later search does not un-hide it
    await search("/api/hf/search?q=@newstar&platform=youtube");
    expect((await feed()).items).toEqual([]);
    expect((await admin("PATCH", "/api/admin/hf/invite-creators/youtube/newstar", { hidden: false })).status).toBe(200);
    expect((await feed()).items.length).toBe(3);
    expect((await admin("PATCH", "/api/admin/hf/invite-creators/youtube/nobody", { hidden: true })).status).toBe(404);
  });
  it("rejects bad input, creators already on the network and unknown accounts", async () => {
    expect((await admin("POST", "/api/admin/hf/invite-creators", { platform: "tiktok", handle: "x" })).status).toBe(400);
    host("h2", { handle: "@newstar", platform: "youtube", pid: CH_ID });
    expect((await admin("POST", "/api/admin/hf/invite-creators", { platform: "youtube", handle: "@newstar" })).status).toBe(409);
    const none = async () => new Response(JSON.stringify({ items: [] }), { status: 200 });
    expect((await admin("POST", "/api/admin/hf/invite-creators", { platform: "youtube", handle: "@ghostxx" }, { f: none })).status).toBe(404);
    env.YOUTUBE_API_KEY = "";
    expect((await admin("POST", "/api/admin/hf/invite-creators", { platform: "youtube", handle: "@someone" })).status).toBe(503);
    expect(await hfInviteAdminRoute(new Request("https://x/api/other"), env, "/api/other")).toBeNull();
  });
});

describe("search platform filter", () => {
  beforeEach(() => {
    host("y1", { name: "Yt Maya", handle: "@maya", platform: "youtube" });
    host("i1", { name: "Ig Maya", handle: "@maya_ig", platform: "instagram" });
    host("b1", { name: "Both Maya", handle: "@maya_b", platform: "youtube" });
    db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at) VALUES ('hfch_b1i','b1','instagram','@maya_b',10,'approved',1,1)").run();
    db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, presence) VALUES ('d1','slug-d1','approved','Demo Maya','online')").run();
    db.prepare("INSERT INTO hf_demo_hosts (host_uid, handle, followers, created_at) VALUES ('d1','@demo',1,1)").run();
  });
  const names = (j: any) => [...j.online, ...j.offline].map((h: any) => h.name).sort();
  it("all (default and explicit) returns everyone; youtube / instagram filter our hosts", async () => {
    expect(names(await search("/api/hf/search?q=maya"))).toEqual(["Both Maya", "Demo Maya", "Ig Maya", "Yt Maya"]);
    expect(names(await search("/api/hf/search?q=maya&platform=all"))).toEqual(["Both Maya", "Demo Maya", "Ig Maya", "Yt Maya"]);
    expect(names(await search("/api/hf/search?q=maya&platform=youtube"))).toEqual(["Both Maya", "Demo Maya", "Yt Maya"]);
    expect(names(await search("/api/hf/search?q=maya&platform=instagram"))).toEqual(["Both Maya", "Ig Maya"]);
    expect(names(await search("/api/hf/search?q=maya&platform=bogus"))).toHaveLength(4);
  });
  it("hosts list their platforms (demo hosts are youtube)", async () => {
    const j = await search("/api/hf/search?q=maya");
    const by = Object.fromEntries([...j.online, ...j.offline].map((h: any) => [h.name, h.platforms]));
    expect(by).toEqual({ "Yt Maya": ["youtube"], "Ig Maya": ["instagram"], "Both Maya": ["instagram", "youtube"], "Demo Maya": ["youtube"] });
  });
  it("limits the not-on-network look-up to the chosen platform", async () => {
    const calls: string[] = [];
    const j = await search("/api/hf/search?q=@iggirl&platform=instagram", fakeFetch(calls));
    expect(j.notOnNetwork.map((n: any) => n.platform)).toEqual(["instagram"]);
    expect(calls.some((u) => u.includes("googleapis.com"))).toBe(false);
    const both = await search("/api/hf/search?q=@newstar", fakeFetch());
    expect(both.notOnNetwork.map((n: any) => n.platform).sort()).toEqual(["instagram", "youtube"]);
    const yt = await search("/api/hf/search?q=@newstar&platform=youtube", fakeFetch());
    expect(yt.notOnNetwork.map((n: any) => n.platform)).toEqual(["youtube"]);
  });
});
