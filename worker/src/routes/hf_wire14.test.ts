// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-14] Embeds only, YouTube sign-in connect, demo influencers from pasted links, demo hosts take no calls/bookings.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin" }));

import { hfChannelsRoute, recheckAllChannels } from "./hf_channels";
import { hfDemoAdminRoute } from "./hf_demo_admin";
import { hfReelsRoute } from "./hf_reels";
import { parseYoutubeVideoId, parseYoutubeLines, isDemoHost } from "../lib/hf_demo";
import { refreshDemoReels } from "../lib/hf_reels_import";
import { youtubeOwnChannel } from "../lib/hf_channel_providers";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");
const CH = "UC1234567890123456789012";

let ytMine: any, videos: Record<string, any>, calls: { url: string; auth: string | null }[];
function fakeFetch() {
  return async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: init.headers?.authorization ?? null });
    if (u.includes("/channels?")) {
      if (ytMine === "401") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ items: ytMine ? [ytMine] : [] }));
    }
    if (u.includes("/playlistItems")) return new Response(JSON.stringify({ items: Object.keys(videos).map((id) => ({ contentDetails: { videoId: id } })) }));
    if (u.includes("/videos?")) {
      const ids = new URL(u).searchParams.get("id").split(",");
      return new Response(JSON.stringify({ items: ids.filter((i) => videos[i]).map((i) => videos[i]) }));
    }
    return new Response("{}", { status: 404 });
  };
}
const vid = (id: string, title = "T " + id, views = "100") => ({ id, snippet: { title, description: "D " + id, publishedAt: "2026-10-01T00:00:00Z" }, statistics: { viewCount: views, likeCount: "5", commentCount: "2" } });

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', avatar_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);`);
  for (const f of ["2026-10-19-hf-channels.sql", "2026-10-19-hf-reels.sql", "2026-10-19-hf-demo-hosts.sql", "2026-10-20-hf-reel-details.sql"]) db.exec(mig(f));
  const kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: { prepare: (q: string) => stmt(q) }, YOUTUBE_API_KEY: "yt-key", BLOSSOM_BASE_URL: "https://media.test",
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
  };
}

beforeEach(() => {
  makeEnv();
  cfg = { hfChannelsEnabled: true, hfReelsEnabled: true, hfInfluencerMinFollowers: 10, hfReelsImportCount: 50, hfDemoInfluencersVisible: true };
  authFail = null; calls = [];
  ytMine = { id: CH, snippet: { customUrl: "@maya", title: "Maya", description: "hello" }, statistics: { subscriberCount: "500", hiddenSubscriberCount: false } };
  videos = { aaaaaaaaaaa: vid("aaaaaaaaaaa"), bbbbbbbbbbb: vid("bbbbbbbbbbb") };
  vi.stubGlobal("fetch", fakeFetch());
});

const connect = (body: any, uid = "u1") =>
  hfChannelsRoute(new Request("https://x/api/hf/channels/youtube/connect", { method: "POST", headers: { "x-test-uid": uid, "content-type": "application/json" }, body: JSON.stringify(body) }), env, "/api/hf/channels/youtube/connect");
const TOKEN = "ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("YouTube sign-in connect", () => {
  it("proves ownership from the token, approves, imports every public video visible, never stores the token", async () => {
    const r = await connect({ accessToken: TOKEN });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j).toMatchObject({ ok: true, result: "approved", qualified: true, hostStatus: "approved", imported: { fetched: 2, inserted: 2 } });
    expect(j.channel).toMatchObject({ platform: "youtube", state: "approved", verified: true, needsCode: false, followers: 500, handle: "@maya" });
    expect(j.channel.verifyCode).toBeUndefined();
    const own = calls.find((c) => c.url.includes("mine=true"));
    expect(own.auth).toBe("Bearer " + TOKEN);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels WHERE visible=1 AND video_url IS NULL AND host_uid='u1'").get().c).toBe(2);
    expect(db.prepare("SELECT description FROM hf_reel_details LIMIT 1").get().description).toMatch(/^D /);
    expect(JSON.stringify(db.prepare("SELECT * FROM hf_channels").all())).not.toContain("ya29");
    expect(db.prepare("SELECT slug FROM hf_hosts WHERE uid='u1'").get().slug).toBeTruthy();
  });
  it("below the follower minimum is verified but not approved, and imports nothing", async () => {
    ytMine.statistics.subscriberCount = "3";
    const j = await (await connect({ accessToken: TOKEN })).json();
    expect(j).toMatchObject({ result: "needs_followers", qualified: false });
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels").get().c).toBe(0);
  });
  it("hidden subscriber count -> hidden_count", async () => {
    ytMine.statistics.hiddenSubscriberCount = true;
    expect((await (await connect({ accessToken: TOKEN })).json()).result).toBe("hidden_count");
  });
  it("rejects a bad or expired token, a Google account without a channel, and another person's channel", async () => {
    expect((await connect({})).status).toBe(400);
    expect((await connect({ accessToken: "short" })).status).toBe(400);
    ytMine = "401";
    const r = await connect({ accessToken: TOKEN });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("token_invalid");
    ytMine = null;
    const r2 = await connect({ accessToken: TOKEN });
    expect(r2.status).toBe(404);
    expect((await r2.json()).error).toBe("no_youtube_channel");
    ytMine = { id: CH, snippet: { title: "Maya" }, statistics: { subscriberCount: "500" } };
    expect((await connect({ accessToken: TOKEN }, "u1")).status).toBe(200);
    const r3 = await connect({ accessToken: TOKEN }, "u2");
    expect(r3.status).toBe(409);
    expect((await r3.json()).error).toBe("channel_claimed");
  });
  it("connecting twice keeps one channel and keeps a video she hid hidden", async () => {
    await connect({ accessToken: TOKEN });
    db.prepare("UPDATE hf_reels SET visible=0 WHERE platform_video_id='aaaaaaaaaaa'").run();
    await connect({ accessToken: TOKEN });
    expect(db.prepare("SELECT COUNT(*) c FROM hf_channels").get().c).toBe(1);
    expect(db.prepare("SELECT visible FROM hf_reels WHERE platform_video_id='aaaaaaaaaaa'").get().visible).toBe(0);
  });
  it("is gated by the flag, auth and method", async () => {
    cfg = {};
    expect((await connect({ accessToken: TOKEN })).status).toBe(404);
    cfg = { hfChannelsEnabled: true };
    authFail = { status: 401, error: "auth" };
    expect((await connect({ accessToken: TOKEN })).status).toBe(401);
    authFail = null;
    const g = await hfChannelsRoute(new Request("https://x/api/hf/channels/youtube/connect"), env, "/api/hf/channels/youtube/connect");
    expect(g.status).toBe(405);
  });
  it("youtubeOwnChannel maps Google answers", async () => {
    expect((await youtubeOwnChannel(TOKEN, fakeFetch())).platformUserId).toBe(CH);
    await expect(youtubeOwnChannel("x", fakeFetch())).rejects.toMatchObject({ code: "token_invalid" });
  });
});

describe("daily cron", () => {
  it("refreshes cached stats of connected channels and demo reels", async () => {
    await connect({ accessToken: TOKEN });
    db.prepare("UPDATE hf_channels SET last_sync_at=1").run();
    videos.aaaaaaaaaaa = vid("aaaaaaaaaaa", "New title", "999");
    await recheckAllChannels(env);
    expect(db.prepare("SELECT caption, views FROM hf_reels WHERE platform_video_id='aaaaaaaaaaa'").get()).toMatchObject({ caption: "New title", views: 999 });
    db.prepare("INSERT INTO hf_reels (id, host_uid, platform, platform_video_id, caption, views, visible, is_demo, imported_at) VALUES ('hfrl_demo000001','d1','youtube','bbbbbbbbbbb','old',1,1,1,1)").run();
    videos.bbbbbbbbbbb = vid("bbbbbbbbbbb", "Fresh", "42");
    expect(await refreshDemoReels(env, 50, fakeFetch())).toMatchObject({ scanned: 1, updated: 1 });
    expect(db.prepare("SELECT caption, views FROM hf_reels WHERE id='hfrl_demo000001'").get()).toMatchObject({ caption: "Fresh", views: 42 });
  });
});

describe("link parsing", () => {
  it("accepts the common YouTube link shapes only", () => {
    const id = "dQw4w9WgXcQ";
    for (const u of [`https://www.youtube.com/watch?v=${id}&t=3`, `youtu.be/${id}?si=x`, `https://youtube.com/shorts/${id}`, `https://m.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}`, id])
      expect(parseYoutubeVideoId(u)).toBe(id);
    for (const u of ["https://example.com/watch?v=" + id, "https://www.youtube.com/@maya", "hello", "", "https://vimeo.com/123"]) expect(parseYoutubeVideoId(u)).toBeNull();
    expect(parseYoutubeLines([`youtu.be/${id}`, "", "junk", `https://youtube.com/watch?v=${id}`])).toEqual({ ids: [id], bad: ["junk"] });
  });
});

const admin = (method: string, path = "/api/admin/hf/demo-influencers", body?: any, uid = "admin") =>
  hfDemoAdminRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, path, fakeFetch());

describe("admin demo influencers", () => {
  it("admins only", async () => {
    expect((await admin("GET", undefined, undefined, "u1")).status).toBe(403);
    authFail = { status: 401, error: "auth" };
    expect((await admin("GET")).status).toBe(401);
    expect(await hfDemoAdminRoute(new Request("https://x/api/other"), env, "/api/other")).toBeNull();
  });
  it("creates a demo host + embed-only visible reels from pasted links, lists, adds more, deletes", async () => {
    const r = await admin("POST", undefined, { name: "Priya", ratePaise: 1200, youtubeUrls: ["https://youtu.be/aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb", "nope", "https://youtu.be/ccccccccccc"] });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.result).toMatchObject({ name: "Priya", added: 2, skipped: 0, missing: ["ccccccccccc"], bad: ["nope"] });
    const uid = j.result.uid;
    expect(uid).toMatch(/^demo_/);
    expect(db.prepare("SELECT status, presence, price_per_min FROM hf_hosts WHERE uid=?").get(uid)).toMatchObject({ status: "approved", presence: "online", price_per_min: 12 });
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels WHERE host_uid=? AND is_demo=1 AND visible=1 AND channel_id IS NULL AND video_url IS NULL").get(uid).c).toBe(2);
    expect(await isDemoHost(env, uid)).toBe(true);
    const list = await (await admin("GET")).json();
    expect(list.items[0]).toMatchObject({ uid, name: "Priya", ratePaise: 1200, videos: 2 });
    // fill the same host with more links; known videos are skipped
    videos.ddddddddddd = vid("ddddddddddd");
    const j2 = await (await admin("POST", undefined, { uid, name: "", ratePaise: 1500, youtubeUrls: ["aaaaaaaaaaa", "ddddddddddd"] })).json();
    expect(j2.result).toMatchObject({ added: 1, skipped: 1 });
    expect(db.prepare("SELECT price_per_min, display_name FROM hf_hosts WHERE uid=?").get(uid)).toMatchObject({ price_per_min: 15, display_name: "Priya" });
    // shows on the public feed
    const feed = await (await hfReelsRoute(new Request("https://x/api/hf/reels"), env, "/api/hf/reels")).json();
    expect(feed.items.length).toBe(3);
    expect(feed.items[0].videoUrl).toBeUndefined();
    expect(feed.items[0].embedUrl).toMatch(/youtube\.com\/embed\//);
    expect((await admin("DELETE", `/api/admin/hf/demo-influencers/${uid}`)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_reels").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_hosts").get().c).toBe(0);
    expect((await admin("DELETE", `/api/admin/hf/demo-influencers/${uid}`)).status).toBe(404);
  });
  it("never deletes a real host, validates input, reports a missing API key", async () => {
    db.prepare("INSERT INTO hf_hosts (uid, status) VALUES ('real1','live')").run();
    expect((await admin("DELETE", "/api/admin/hf/demo-influencers/real1")).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) c FROM hf_hosts").get().c).toBe(1);
    expect((await admin("POST", undefined, { name: "", ratePaise: 1200, youtubeUrls: ["youtu.be/aaaaaaaaaaa"] })).status).toBe(400);
    expect((await admin("POST", undefined, { name: "A", ratePaise: 5, youtubeUrls: ["youtu.be/aaaaaaaaaaa"] })).status).toBe(400);
    expect((await (await admin("POST", undefined, { name: "A", ratePaise: 1200, youtubeUrls: ["junk"] })).json()).error).toBe("no_videos");
    delete env.YOUTUBE_API_KEY;
    const r = await admin("POST", undefined, { name: "A", ratePaise: 1200, youtubeUrls: ["youtu.be/aaaaaaaaaaa"] });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("provider_not_configured");
    expect(db.prepare("SELECT COUNT(*) c FROM hf_hosts").get().c).toBe(1);
  });
  it("an unknown uid cannot be filled", async () => {
    expect((await admin("POST", undefined, { uid: "real1", name: "A", ratePaise: 1200, youtubeUrls: ["youtu.be/aaaaaaaaaaa"] })).status).toBe(404);
  });
});
