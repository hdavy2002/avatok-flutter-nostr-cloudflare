// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-REEL-ENGAGE-API-1] Likes + comments on reels: flag, guest/unverified, idempotent likes, comment rules, report-hide, delete, visibility, YouTube pull (replace-set, commentsDisabled), feed totals, purge, cron.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
let verified = true;
const events: { event: string; props: any; uid: string }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _app: string, props: any) => { events.push({ event, props, uid }); },
  trackUser: async () => {}, trackException: async () => {},
}));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../lib/whatsapp_notify", async (orig) => ({ ...(await orig()), verifiedWhatsAppNumber: async () => (verified ? "+919999999999" : null) }));

import { hfReelEngageRoute } from "./hf_reel_engage";
import { hfReelsRoute } from "./hf_reels";
import { refreshExtComments, refreshRecentReelComments } from "../lib/hf_reel_engage";
import { purgeHfUser } from "../lib/hf_purge";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>, waits: Promise<unknown>[];
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', avatar_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT, taken_by_uid TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT);`);
  for (const f of ["2026-10-19-hf-channels.sql", "2026-10-19-hf-reels.sql", "2026-10-19-hf-demo-hosts.sql", "2026-10-19-hf-invite-votes.sql", "2026-10-20-hf-invite-creators.sql", "2026-10-24-hf-reel-engage.sql"]) db.exec(mig(f));
  kv = new Map();
  const stmt = (q: string, args: unknown[] = []) => ({
    q, args,
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = {
    DB_META: {
      prepare: (q: string) => stmt(q),
      batch: async (list: any[]) => { db.exec("BEGIN"); try { for (const s of list) db.prepare(s.q).run(...s.args); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return list.map(() => ({ meta: {} })); },
    },
    BLOSSOM_BASE_URL: "https://media.test", ADMIN_UIDS: "admin1", YOUTUBE_API_KEY: "",
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
  };
}

let n = 0;
function host(uid: string) {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, price_per_min, presence) VALUES (?,?,?,?,?,?)").run(uid, "slug-" + uid, "approved", "Name " + uid, 12, "online");
  db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?)").run("hfch_" + uid, uid, "youtube", "@" + uid, 100, "approved", 1, 1);
}
function reel(id: string, uid: string, o: any = {}) {
  db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, likes, comments, visible, is_demo, published_at, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, uid, "hfch_" + uid, o.platform ?? "youtube", o.vid ?? "vid" + (++n) + "abcdef", "https://e/" + id, "cap", o.likes ?? 1500, o.comments ?? 40, o.visible ?? 1, 0, o.at ?? Date.now() - 1000, 1);
}
const R1 = "hfrl_aaaaaaaa01";
const route = (path: string, init: any = {}) => hfReelEngageRoute(new Request("https://x" + path, init.method === "GET" || init.method === "HEAD" ? { ...init, body: undefined } : init), env, path.split("?")[0], { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as any);
const body = async (r: Response | null) => ({ status: r!.status, ...(await r!.json()) });
const post = (path: string, b: any, uid = "u1") => route(path, { method: "POST", body: JSON.stringify(b), headers: { "x-test-uid": uid } });
const del = (path: string, uid = "u1") => route(path, { method: "DELETE", headers: { "x-test-uid": uid } });
const comment = async (text: string, uid = "u1", extra: any = {}) => body(await post(`/api/hf/reels/${R1}/comments`, { body: text, ...extra }, uid));
const feed = async (headers: any = {}) => body(await hfReelsRoute(new Request("https://x/api/hf/reels", { headers }), env, "/api/hf/reels"));

beforeEach(() => {
  makeEnv(); waits = []; events.length = 0; n = 0; authFail = null; verified = true;
  cfg = { hfReelsEnabled: true, hfReelEngageEnabled: true, hfDemoInfluencersVisible: true, hfReelCommentHideAt: 3, hfReelCommentMaxLen: 500 };
  host("h1"); reel(R1, "h1");
});

describe("flag + auth", () => {
  it("flag off -> 404 not_enabled on every route, and the feed carries no new keys", async () => {
    cfg = { hfReelsEnabled: true, hfReelEngageEnabled: false };
    for (const [m, p] of [["POST", `/api/hf/reels/${R1}/like`], ["DELETE", `/api/hf/reels/${R1}/like`], ["GET", `/api/hf/reels/${R1}/comments`], ["POST", `/api/hf/reels/${R1}/comments`], ["DELETE", "/api/hf/reels/comments/hfrc_" + "a".repeat(20)], ["POST", "/api/hf/reels/comments/hfrc_" + "a".repeat(20) + "/report"]]) {
      const j = await body(await route(p, { method: m, body: "{}" }));
      expect([m, p, j.status, j.error]).toEqual([m, p, 404, "not_enabled"]);
    }
    const f = await feed();
    expect(f.items[0].likeCounts).toBeUndefined();
    expect(f.items[0].likes).toBe(1500);
  });
  it("guest gets 401 on like, comment, delete and report; reads stay public", async () => {
    authFail = { status: 401, error: "unauthorized" };
    expect((await post(`/api/hf/reels/${R1}/like`, {})).status).toBe(401);
    expect((await post(`/api/hf/reels/${R1}/comments`, { body: "hi" })).status).toBe(401);
    expect((await del("/api/hf/reels/comments/hfrc_" + "a".repeat(20))).status).toBe(401);
    expect((await post("/api/hf/reels/comments/hfrc_" + "a".repeat(20) + "/report", {})).status).toBe(401);
    expect((await route(`/api/hf/reels/${R1}/comments`)).status).toBe(200);
  });
  it("an account without a verified WhatsApp number cannot like or comment", async () => {
    verified = false;
    expect((await body(await post(`/api/hf/reels/${R1}/like`, {}))).error).toBe("not_verified");
    expect((await body(await post(`/api/hf/reels/${R1}/comments`, { body: "hi" }))).error).toBe("not_verified");
  });
});

describe("likes", () => {
  it("like is idempotent and counts platform + ours", async () => {
    let j = await body(await post(`/api/hf/reels/${R1}/like`, {}));
    expect(j).toMatchObject({ ok: true, liked: true, likes: { platform: 1500, ours: 1, total: 1501 } });
    j = await body(await post(`/api/hf/reels/${R1}/like`, {}));
    expect(j.likes).toEqual({ platform: 1500, ours: 1, total: 1501 });
    j = await body(await post(`/api/hf/reels/${R1}/like`, {}, "u2"));
    expect(j.likes).toEqual({ platform: 1500, ours: 2, total: 1502 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_likes").get().c).toBe(2);
  });
  it("unlike is idempotent", async () => {
    await post(`/api/hf/reels/${R1}/like`, {});
    let j = await body(await del(`/api/hf/reels/${R1}/like`));
    expect(j).toMatchObject({ ok: true, liked: false, likes: { platform: 1500, ours: 0, total: 1500 } });
    j = await body(await del(`/api/hf/reels/${R1}/like`));
    expect(j.likes.ours).toBe(0);
  });
  it("hidden or unknown reels 404; an invite reel can be liked", async () => {
    reel("hfrl_hidden0001", "h1", { visible: 0 });
    expect((await post(`/api/hf/reels/hfrl_hidden0001/like`, {})).status).toBe(404);
    expect((await post(`/api/hf/reels/hfrl_nothere0001/like`, {})).status).toBe(404);
    db.prepare("INSERT INTO hf_invite_creators (platform, handle, display_name, followers, hidden, last_lookup_at, created_at) VALUES ('youtube','zed','Zed',10,0,1,1)").run();
    db.prepare("INSERT INTO hf_invite_reels (id, platform, handle, platform_video_id, embed_url, likes, comments, views, published_at, fetched_at) VALUES ('hfiv_invite00001','youtube','zed','zvid123456','https://e/z',200,5,0,1,1)").run();
    const j = await body(await post(`/api/hf/reels/hfiv_invite00001/like`, {}));
    expect(j.likes).toEqual({ platform: 200, ours: 1, total: 201 });
    expect(events.find((e) => e.event === "hf_reel_like")?.props).toMatchObject({ reel_id: "hfiv_invite00001", on: true, platform: "youtube" });
  });
});

describe("comments", () => {
  it("creates, lists (ours newest first), never leaks uid, counts add up", async () => {
    db.prepare("INSERT INTO users (uid, display_name) VALUES ('u1','Asha'), ('u2','9876543210')").run();
    const a = await comment("first one");
    expect(a).toMatchObject({ status: 200, ok: true, item: { source: "ours", body: "first one", mine: true, author: { name: "Asha" } }, counts: { comments: { platform: 40, ours: 1, total: 41 } } });
    await new Promise((r) => setTimeout(r, 3));
    await comment("second one", "u2");
    const j = await body(await route(`/api/hf/reels/${R1}/comments`, { headers: { "x-test-uid": "u1", authorization: "Bearer t" } }));
    expect(j.items.map((i: any) => i.body)).toEqual(["second one", "first one"]);
    expect(j.items.map((i: any) => i.mine)).toEqual([false, true]);
    expect(j.items[0].author.name).toBe("A fan"); // a phone-number-looking name is never shown
    expect(j.counts).toEqual({ likes: { platform: 1500, ours: 0, total: 1500 }, comments: { platform: 40, ours: 2, total: 42 } });
    expect(j.likedByMe).toBe(false);
    expect(JSON.stringify(j)).not.toMatch(/"uid"|u1|u2|9876543210/);
    expect(events.find((e) => e.event === "hf_reel_comment_sent")?.props).toMatchObject({ reel_id: R1, len: 9, is_reply: false });
  });
  it("rules: empty, too long, links, sexual words, bad parent", async () => {
    expect((await comment("   ")).error).toBe("empty");
    const long = await comment("x".repeat(501));
    expect([long.status, long.error]).toEqual([422, "too_long"]);
    expect((await comment("x".repeat(500))).ok).toBe(true);
    expect((await comment("see https://spam.example")).error).toBe("no_links");
    expect((await comment("visit www.spam.example")).error).toBe("no_links");
    const bad = await comment("send nude pictures");
    expect([bad.status, bad.error]).toEqual([422, "not_allowed"]);
    expect((await comment("hello", "u1", { parentId: "hfrc_" + "b".repeat(20) })).error).toBe("bad_parent");
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_comments").get().c).toBe(1);
  });
  it("hfReelCommentMaxLen is honoured", async () => {
    cfg.hfReelCommentMaxLen = 5;
    expect((await comment("123456")).error).toBe("too_long");
    expect((await comment("12345")).ok).toBe(true);
  });
  it("rate limit: 10 comments per 10 minutes", async () => {
    for (let i = 0; i < 10; i++) expect((await comment("c" + i)).ok).toBe(true);
    expect((await body(await post(`/api/hf/reels/${R1}/comments`, { body: "one too many" }))).status).toBe(429);
  });
  it("replies sit one level deep under their parent; a reply to a reply is refused", async () => {
    const top = await comment("top");
    const rep = await comment("reply", "u2", { parentId: top.item.id });
    expect(rep.item.parentId).toBe(top.item.id);
    expect((await comment("deeper", "u1", { parentId: rep.item.id })).error).toBe("bad_parent");
    const j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items).toHaveLength(1);
    expect(j.items[0].replies.map((r: any) => r.body)).toEqual(["reply"]);
    expect(j.counts.comments.ours).toBe(2);
  });
  it("author can delete, a stranger cannot, an admin can; count drops", async () => {
    const a = await comment("mine");
    expect((await del(`/api/hf/reels/comments/${a.item.id}`, "u2")).status).toBe(404);
    expect((await del(`/api/hf/reels/comments/${a.item.id}`, "u1")).status).toBe(200);
    expect((await del(`/api/hf/reels/comments/${a.item.id}`, "u1")).status).toBe(200); // idempotent
    expect((await body(await route(`/api/hf/reels/${R1}/comments`))).items).toHaveLength(0);
    const b = await comment("by someone");
    expect((await del(`/api/hf/reels/comments/${b.item.id}`, "admin1")).status).toBe(200);
    expect(db.prepare("SELECT comments FROM hf_reel_counts WHERE reel_id=?").get(R1).comments).toBe(0);
  });
  it("reports: one per user, hidden at hfReelCommentHideAt", async () => {
    const a = await comment("rude");
    const rp = (uid: string) => post(`/api/hf/reels/comments/${a.item.id}/report`, { reason: "abuse" }, uid);
    expect((await body(await rp("r1"))).hidden).toBe(false);
    expect((await body(await rp("r1"))).hidden).toBe(false); // same user twice still counts once
    expect((await body(await rp("r2"))).hidden).toBe(false);
    expect(db.prepare("SELECT reports FROM hf_reel_comments WHERE id=?").get(a.item.id).reports).toBe(2);
    expect((await body(await rp("r3"))).hidden).toBe(true);
    expect((await body(await route(`/api/hf/reels/${R1}/comments`))).items).toHaveLength(0);
    expect(db.prepare("SELECT comments FROM hf_reel_counts WHERE reel_id=?").get(R1).comments).toBe(0);
    expect((await rp("r4")).status).toBe(200);
    expect(events.filter((e) => e.event === "hf_reel_comment_report").length).toBeGreaterThan(0);
  });
});

describe("YouTube comments (read only)", () => {
  const thread = (id: string, text: string, likes = 0) => ({ id, snippet: { topLevelComment: { snippet: { authorDisplayName: "Viewer " + id, authorProfileImageUrl: "https://yt/a.png", authorChannelUrl: "https://yt/c/" + id, textDisplay: text, likeCount: likes, publishedAt: "2026-10-20T10:00:00Z" } } } });
  const fakeFetch = (items: any[]) => async (url: string) => { expect(url).toContain("commentThreads"); return new Response(JSON.stringify({ items }), { status: 200 }); };

  it("a refresh REPLACES the stored set and the list shows ours first, then YouTube by likes", async () => {
    env.YOUTUBE_API_KEY = "k";
    const vid = db.prepare("SELECT platform_video_id AS v FROM hf_reels WHERE id=?").get(R1).v;
    let r = await refreshExtComments(env, R1, vid, fakeFetch([thread("Ugx11111111", "old A", 1), thread("Ugx22222222", "old B", 9)]));
    expect(r).toEqual({ ok: true, count: 2, reason: "" });
    r = await refreshExtComments(env, R1, vid, fakeFetch([thread("Ugx22222222", "old B", 12), thread("Ugx33333333", "new C", 3)]));
    expect(r.count).toBe(2);
    expect(db.prepare("SELECT id FROM hf_reel_ext_comments ORDER BY id").all().map((x: any) => x.id)).toEqual(["youtube:Ugx22222222", "youtube:Ugx33333333"]);
    await comment("ours");
    kv.set(`hfx:fresh:${R1}`, "1"); // fresh: the GET must not refetch
    waits.length = 0;
    const j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items.map((i: any) => [i.source, i.body])).toEqual([["ours", "ours"], ["youtube", "old B"], ["youtube", "new C"]]);
    expect(j.items[1]).toMatchObject({ likeCount: 12, mine: false, author: { name: "Viewer Ugx22222222", url: "https://yt/c/Ugx22222222" } });
    expect(waits).toHaveLength(0);
    const ev = events.filter((e) => e.event === "hf_reel_ext_comments_fetch");
    expect(ev[0].props).toMatchObject({ reel_id: R1, platform: "youtube", count: 2, ok: true });
  });
  it("commentsDisabled stores none (and clears an older set)", async () => {
    const vid = db.prepare("SELECT platform_video_id AS v FROM hf_reels WHERE id=?").get(R1).v;
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, vid, fakeFetch([thread("Ugx11111111", "hello")]));
    const off = async () => new Response(JSON.stringify({ error: { errors: [{ reason: "commentsDisabled" }] } }), { status: 403 });
    const r = await refreshExtComments(env, R1, vid, off);
    expect(r).toEqual({ ok: true, count: 0, reason: "comments_disabled" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments").get().c).toBe(0);
    expect(events.filter((e) => e.event === "hf_reel_ext_comments_fetch").pop().props).toMatchObject({ ok: true, count: 0 });
  });
  it("a provider failure keeps the old set and reports ok=false", async () => {
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx11111111", "keep me")]));
    const r = await refreshExtComments(env, R1, "vidabcdef12", async () => new Response("{}", { status: 500 }));
    expect(r.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments").get().c).toBe(1);
  });
  it("first open waits for the pull (sheet opens with comments); a later stale open refreshes in the background", async () => {
    env.YOUTUBE_API_KEY = "k";
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [thread("Ugx44444444", "fresh from yt")] }), { status: 200 })) as any;
    try {
      const j = await body(await route(`/api/hf/reels/${R1}/comments`));
      expect(j.items.map((i: any) => i.body)).toEqual(["fresh from yt"]); // [HF-REEL-IG-COMMENTS-1] awaited on the first pull
      expect(waits).toHaveLength(0);
      kv.delete(`hfx:fresh:${R1}`); // stale again, rows exist now
      await route(`/api/hf/reels/${R1}/comments`);
      expect(waits).toHaveLength(1);
      await Promise.all(waits);
      waits.length = 0;
      await route(`/api/hf/reels/${R1}/comments`);
      expect(waits).toHaveLength(0); // marker is fresh now
    } finally { globalThis.fetch = orig; }
  });
  it("a refresh keeps an imported comment one of our users replied to, even when the platform dropped it", async () => {
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx11111111", "keep me"), thread("Ugx22222222", "drop me")]));
    await comment("nice", "u1", { parentId: "youtube:Ugx11111111" });
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx33333333", "new")]));
    expect(db.prepare("SELECT id FROM hf_reel_ext_comments ORDER BY id").all().map((x: any) => x.id)).toEqual(["youtube:Ugx11111111", "youtube:Ugx33333333"]);
  });
  it("Instagram: comments come through treg (2 pages), tagged instagram, and can be replied to", async () => {
    env.TREG_API_KEY = "t";
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const page2 = url.includes("cursor=");
      const comments = page2 ? [{ id: "1000000002", text: "second page", comment_like_count: 1, created_at: "2026-10-21T10:00:00Z", user: { username: "b.user" } }]
        : [{ id: "1000000001", text: "so cute", comment_like_count: 7, created_at: "2026-10-20T10:00:00Z", user: { username: "a_user" } }];
      return new Response(JSON.stringify({ success: true, comments, cursor: page2 ? null : "abc" }), { status: 200 });
    };
    const r = await refreshExtComments(env, R1, "DOq6eV6iIgD", f as any, "instagram");
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(urls[0]).toContain("scrapecreators.instagram.post.comments");
    expect(urls[0]).toContain(encodeURIComponent("https://www.instagram.com/reel/DOq6eV6iIgD/"));
    kv.set(`hfx:fresh:${R1}`, "1");
    const j = await body(await route(`/api/hf/reels/${R1}/comments`));
    const ig = j.items.filter((i: any) => i.source === "instagram");
    expect(ig.map((i: any) => i.author.name)).toEqual(["@a_user", "@b.user"]);
    const rep = await comment("agreed", "u1", { parentId: "instagram:1000000001" });
    expect(rep.item.parentId).toBe("instagram:1000000001");
    expect((await post(`/api/hf/reels/comments/instagram:1000000002/report`, { reason: "spam" }, "r1")).status).toBe(200);
  });
  it("an imported comment reported by enough users is hidden; replying to one stays ours", async () => {
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx11111111", "spammy")]));
    const rep = await comment("good point", "u1", { parentId: "youtube:Ugx11111111" });
    expect(rep.item.parentId).toBe("youtube:Ugx11111111");
    kv.set(`hfx:fresh:${R1}`, "1");
    let j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items[0].replies.map((r: any) => r.body)).toEqual(["good point"]);
    for (const u of ["r1", "r2", "r3"]) await post(`/api/hf/reels/comments/youtube:Ugx11111111/report`, { reason: "spam" }, u);
    j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items.filter((i: any) => i.source === "youtube")).toHaveLength(0);
  });
  it("cron: purges imported comments older than 30 days and refreshes reels of the last 7 days", async () => {
    env.YOUTUBE_API_KEY = "k";
    reel("hfrl_oldoldold01", "h1", { at: Date.now() - 20 * 86400000 });
    db.prepare("INSERT INTO hf_reel_ext_comments (id, reel_id, platform, body, like_count, fetched_at) VALUES ('youtube:oldoldold1', ?, 'youtube', 'ancient', 0, ?)").run("hfrl_oldoldold01", Date.now() - 31 * 86400000);
    const calls: string[] = [];
    const f = async (url: string) => { calls.push(url); return new Response(JSON.stringify({ items: [thread("Ugx55555555", "daily")] }), { status: 200 }); };
    const out = await refreshRecentReelComments(env, cfg, f);
    expect(out).toMatchObject({ purged: 1, scanned: 1, fetched: 1 });
    expect(calls).toHaveLength(1);
    expect(db.prepare("SELECT reel_id FROM hf_reel_ext_comments").all().map((x: any) => x.reel_id)).toEqual([R1]);
    cfg.hfReelEngageEnabled = false;
    calls.length = 0;
    await refreshRecentReelComments(env, cfg, f);
    expect(calls).toHaveLength(0);
  });
});

describe("feed items", () => {
  it("flag on: likeCounts / commentCounts / likedByMe, and the flat numbers become the totals", async () => {
    await post(`/api/hf/reels/${R1}/like`, {});
    await post(`/api/hf/reels/${R1}/like`, {}, "u2");
    await comment("c1");
    const f = await feed({ authorization: "Bearer t", "x-test-uid": "u1" });
    const it = f.items[0];
    expect(it.likeCounts).toEqual({ platform: 1500, ours: 2, total: 1502 });
    expect(it.commentCounts).toEqual({ platform: 40, ours: 1, total: 41 });
    expect(it.likes).toBe(1502);
    expect(it.comments).toBe(41);
    expect(it.likedByMe).toBe(true);
    const guest = await feed();
    expect(guest.items[0].likedByMe).toBeUndefined();
    expect(guest.items[0].likeCounts.total).toBe(1502);
    const one = await body(await hfReelsRoute(new Request(`https://x/api/hf/reels/${R1}`), env, `/api/hf/reels/${R1}`));
    expect(one.item.likes).toBe(1502);
  });
});

describe("account deletion", () => {
  it("purgeHfUser removes the account's likes, comments and reports and re-counts the reel", async () => {
    await post(`/api/hf/reels/${R1}/like`, {}, "gone");
    await post(`/api/hf/reels/${R1}/like`, {}, "stay");
    const a = await comment("bye", "gone");
    await comment("stay", "stay");
    await post(`/api/hf/reels/comments/${a.item.id}/report`, {}, "gone");
    const res = await purgeHfUser({ DB_META: env.DB_META }, "gone");
    expect(res.errors).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_likes WHERE uid='gone'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_comments WHERE uid='gone'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_comment_reports WHERE uid='gone'").get().c).toBe(0);
    expect(db.prepare("SELECT likes, comments FROM hf_reel_counts WHERE reel_id=?").get(R1)).toMatchObject({ likes: 1, comments: 1 });
  });
});
