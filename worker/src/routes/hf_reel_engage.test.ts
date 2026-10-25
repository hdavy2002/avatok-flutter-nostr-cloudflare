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
import { prefetchFeedComments, recheckYoutubeComments, refreshExtComments, videoIdOf, refreshRecentReelComments, seedCount, SEED_MAX, SEED_MIN } from "../lib/hf_reel_engage";
import { purgeHfUser } from "../lib/hf_purge";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, kv: Map<string, string>, waits: Promise<unknown>[];
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', avatar_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    women_lane INTEGER, lgbtq_lane INTEGER, lgbtq_public INTEGER);
    CREATE TABLE hf_kyc (uid TEXT, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_selfie (id TEXT, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
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
function host(uid: string, providerRef: string | null = "youtube-oauth") {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, price_per_min, presence) VALUES (?,?,?,?,?,?)").run(uid, "slug-" + uid, "approved", "Name " + uid, 12, "online");
  db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at, provider_ref) VALUES (?,?,?,?,?,?,?,?,?)").run("hfch_" + uid, uid, "youtube", "@" + uid, 100, "approved", 1, 1, providerRef);
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

  it("[ONCE] seedCount is a random 18-30", () => {
    expect(seedCount(() => 0)).toBe(SEED_MIN);
    expect(seedCount(() => 0.9999999)).toBe(SEED_MAX);
    for (let i = 0; i < 200; i++) { const n = seedCount(); expect(n).toBeGreaterThanOrEqual(18); expect(n).toBeLessThanOrEqual(30); }
  });
  it("[ONCE] the first open imports a random 18-30 and waits for it; later opens never call YouTube again", async () => {
    env.YOUTUBE_API_KEY = "k";
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => thread("Ugx" + String(10000000 + i), "c" + i, i)) }), { status: 200 }); }) as any;
    try {
      const j = await body(await route(`/api/hf/reels/${R1}/comments`));
      const n = db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id=?").get(R1).c;
      expect(n).toBeGreaterThanOrEqual(18);
      expect(n).toBeLessThanOrEqual(30);
      expect(urls[0]).toMatch(/maxResults=(1[89]|2\d|30)(&|$)/);
      expect(j.items.filter((i: any) => i.source === "youtube").length).toBe(Math.min(n, 20)); // first page of 20
      expect(waits).toHaveLength(0);
      await route(`/api/hf/reels/${R1}/comments`);
      kv.delete(`hfx:done:${R1}`); // even with the marker gone, stored rows count as done
      await route(`/api/hf/reels/${R1}/comments`);
      expect(urls).toHaveLength(1);
      expect(events.filter((e) => e.event === "hf_reel_ext_comments_fetch").pop().props).toMatchObject({ reel_id: R1, platform: "youtube", ok: true, count: n });
    } finally { globalThis.fetch = orig; }
  });
  it("[ONCE] comments turned off: nothing stored, marked done, never asked again", async () => {
    env.YOUTUBE_API_KEY = "k";
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify({ error: { errors: [{ reason: "commentsDisabled" }] } }), { status: 403 }); }) as any;
    try {
      await route(`/api/hf/reels/${R1}/comments`);
      await route(`/api/hf/reels/${R1}/comments`);
      expect(calls).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments").get().c).toBe(0);
    } finally { globalThis.fetch = orig; }
  });
  it("[ONCE] a failure blocks retries for 10 minutes only", async () => {
    env.YOUTUBE_API_KEY = "k";
    const r = await refreshExtComments(env, R1, "vidabcdef12", async () => new Response("{}", { status: 500 }));
    expect(r.ok).toBe(false);
    expect(kv.get(`hfx:done:${R1}`)).toBeTruthy();
  });
  it("[ONCE] cron imports new reels once, skips reels already imported; YouTube re-check (free) updates text and drops deleted ones unless replied to", async () => {
    env.YOUTUBE_API_KEY = "k";
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      if (url.includes("/comments?")) return new Response(JSON.stringify({ items: [{ id: "Ugx11111111", snippet: { textDisplay: "edited", likeCount: 5 } }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [thread("Ugx11111111", "a"), thread("Ugx22222222", "b"), thread("Ugx33333333", "c")] }), { status: 200 });
    };
    let out = await refreshRecentReelComments(env, cfg, f);
    expect(out).toMatchObject({ scanned: 1, fetched: 1 });
    expect(calls.filter((u) => u.includes("commentThreads"))).toHaveLength(1);
    calls.length = 0;
    out = await refreshRecentReelComments(env, cfg, f);
    expect(out.scanned).toBe(0);
    expect(calls).toHaveLength(0);
    await comment("reply", "u1", { parentId: "youtube:Ugx33333333" });
    db.prepare("UPDATE hf_reel_ext_comments SET fetched_at=?").run(Date.now() - 26 * 86400000);
    const dropped = await recheckYoutubeComments(env, f as any);
    expect(dropped).toBe(2);
    expect(db.prepare("SELECT id, body FROM hf_reel_ext_comments ORDER BY id").all()).toEqual([{ id: "youtube:Ugx11111111", body: "edited" }, { id: "youtube:Ugx33333333", body: "c" }]);
    expect(calls.some((u) => u.includes("commentThreads"))).toBe(false); // never pulls new ones
  });
  it("[PREFETCH] video ids come from the stored links", () => {
    expect(videoIdOf("youtube", "https://www.youtube.com/watch?v=abcDEF12345")).toBe("abcDEF12345");
    expect(videoIdOf("youtube", "https://youtu.be/abcDEF12345")).toBe("abcDEF12345");
    expect(videoIdOf("instagram", "https://www.instagram.com/reel/DeOSl-6tI3Y/")).toBe("DeOSl-6tI3Y");
    expect(videoIdOf("instagram", "not a url")).toBeNull();
  });
  it("[PREFETCH] serving the feed imports comments in the background for reels not done yet, once", async () => {
    env.YOUTUBE_API_KEY = "k";
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify({ items: [thread("Ugx77777777", "pre")] }), { status: 200 }); }) as any;
    try {
      const items = [{ id: R1, platform: "youtube", url: "https://www.youtube.com/watch?v=vidabcdef12" }];
      expect(await prefetchFeedComments(env, cfg, items)).toBe(1);
      expect(await prefetchFeedComments(env, cfg, items)).toBe(0);
      expect(calls).toBe(1);
      expect(db.prepare("SELECT body FROM hf_reel_ext_comments WHERE reel_id=?").all(R1).map((x: any) => x.body)).toEqual(["pre"]);
    } finally { globalThis.fetch = orig; }
  });
  it("a provider failure keeps the old set and reports ok=false", async () => {
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx11111111", "keep me")]));
    const r = await refreshExtComments(env, R1, "vidabcdef12", async () => new Response("{}", { status: 500 }));
    expect(r.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments").get().c).toBe(1);
  });
  it("[LOGIN-P1] Instagram comments are never imported through treg, not even for a login channel", async () => {
    env.TREG_API_KEY = "t"; env.YOUTUBE_API_KEY = "k";
    db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, likes, comments, visible, is_demo, published_at, imported_at) VALUES ('hfrl_igreel0001','h1','hfch_h1','instagram','DOq6eV6iIgD','https://e/ig','c',1,1,1,0,?,1)").run(Date.now() - 1000);
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); }) as any;
    try {
      await route("/api/hf/reels/hfrl_igreel0001/comments");
      expect(await prefetchFeedComments(env, cfg, [{ id: "hfrl_igreel0001", platform: "instagram", url: "https://www.instagram.com/reel/DOq6eV6iIgD/" }])).toBe(0);
      await refreshRecentReelComments(env, cfg);
      expect(urls.some((u) => u.includes("treg.to") || u.includes("instagram"))).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id='hfrl_igreel0001'").get().c).toBe(0);
    } finally { globalThis.fetch = orig; }
  });
  it("[LOGIN-P1] a bio-code channel's reel gets no import; a login (-oauth) channel's reel does", async () => {
    env.YOUTUBE_API_KEY = "k";
    host("h2", "bio-code"); reel("hfrl_biocode001", "h2");
    host("h3", null); reel("hfrl_nullref0001", "h3");
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify({ items: [thread("Ugx55555555", "hi")] }), { status: 200 }); }) as any;
    try {
      await route("/api/hf/reels/hfrl_biocode001/comments");
      await route("/api/hf/reels/hfrl_nullref0001/comments");
      expect(urls).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id IN ('hfrl_biocode001','hfrl_nullref0001')").get().c).toBe(0);
      await route(`/api/hf/reels/${R1}/comments`);
      expect(urls).toHaveLength(1);
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id=?").get(R1).c).toBe(1);
    } finally { globalThis.fetch = orig; }
  });
  it("[LOGIN-P1] demo reels (no channel, is_demo=1) still import", async () => {
    env.YOUTUBE_API_KEY = "k";
    db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, likes, comments, visible, is_demo, published_at, imported_at) VALUES ('hfrl_demoreel001','h1',NULL,'youtube','demovid1234','https://e/d','c',1,1,1,1,?,1)").run(Date.now() - 1000);
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [thread("Ugx66666666", "demo")] }), { status: 200 })) as any;
    try {
      await route("/api/hf/reels/hfrl_demoreel001/comments");
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id='hfrl_demoreel001'").get().c).toBe(1);
    } finally { globalThis.fetch = orig; }
  });
  it("[LOGIN-P1] invite reels: YouTube imports with hfInviteYoutubeComments on (default), none with it off; Instagram never; prefetch follows the same gate", async () => {
    env.YOUTUBE_API_KEY = "k"; env.TREG_API_KEY = "t";
    db.prepare("INSERT INTO hf_invite_creators (platform, handle, display_name, followers, hidden, last_lookup_at, created_at) VALUES ('youtube','zed','Zed',10,0,1,1), ('instagram','ina','Ina',10,0,1,1)").run();
    const ins = (id: string, plat: string, vid: string) => db.prepare("INSERT INTO hf_invite_reels (id, platform, handle, platform_video_id, embed_url, likes, comments, views, published_at, fetched_at) VALUES (?,?,?,?,?,1,1,0,?,?)").run(id, plat, plat === "youtube" ? "zed" : "ina", vid, "https://e/" + id, Date.now() - 1000, Date.now() - 1000);
    ins("hfiv_ytinvite001", "youtube", "zvid1234567"); ins("hfiv_ytinvite002", "youtube", "zvid7654321"); ins("hfiv_iginvite001", "instagram", "DOq6eV6iIgD");
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify({ items: [thread("Ugx" + (10000000 + urls.length), "inv")] }), { status: 200 }); }) as any;
    try {
      await route("/api/hf/reels/hfiv_ytinvite001/comments");
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id='hfiv_ytinvite001'").get().c).toBe(1);
      await route("/api/hf/reels/hfiv_iginvite001/comments");
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id='hfiv_iginvite001'").get().c).toBe(0);
      expect(urls.some((u) => u.includes("treg.to"))).toBe(false);
      cfg.hfInviteYoutubeComments = false;
      await route("/api/hf/reels/hfiv_ytinvite002/comments");
      expect(await prefetchFeedComments(env, cfg, [{ id: "hfiv_ytinvite002", platform: "youtube", url: "https://www.youtube.com/watch?v=zvid7654321" }])).toBe(0);
      await refreshRecentReelComments(env, cfg);
      expect(db.prepare("SELECT COUNT(*) AS c FROM hf_reel_ext_comments WHERE reel_id='hfiv_ytinvite002'").get().c).toBe(0);
      cfg.hfInviteYoutubeComments = true;
      expect(await prefetchFeedComments(env, cfg, [{ id: "hfiv_ytinvite002", platform: "youtube", url: "https://www.youtube.com/watch?v=zvid7654321" }])).toBe(1);
    } finally { globalThis.fetch = orig; }
  });
  it("an imported comment reported by enough users is hidden; replying to one stays ours", async () => {
    env.YOUTUBE_API_KEY = "k";
    await refreshExtComments(env, R1, "vidabcdef12", fakeFetch([thread("Ugx11111111", "spammy")]));
    const rep = await comment("good point", "u1", { parentId: "youtube:Ugx11111111" });
    expect(rep.item.parentId).toBe("youtube:Ugx11111111");
    kv.set(`hfx:done:${R1}`, "1");
    let j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items[0].replies.map((r: any) => r.body)).toEqual(["good point"]);
    for (const u of ["r1", "r2", "r3"]) await post(`/api/hf/reels/comments/youtube:Ugx11111111/report`, { reason: "spam" }, u);
    j = await body(await route(`/api/hf/reels/${R1}/comments`));
    expect(j.items.filter((i: any) => i.source === "youtube")).toHaveLength(0);
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
