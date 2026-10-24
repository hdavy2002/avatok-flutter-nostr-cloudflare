// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-WIRE-9] Search + Invite votes: flags, 401, one vote per user, online/offline split, no phone numbers, provider look-up cache, admin ranking.
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

import { hfSearchRoute, exactHandle, normHandle } from "./hf_search";

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
  db.exec(mig("2026-10-19-hf-channels.sql"));
  db.exec(mig("hf_creator_spaces.sql")); // [HF-CREATOR-SPACES-1]
  db.exec(mig("2026-10-19-hf-demo-hosts.sql"));
  db.exec(mig("2026-10-19-hf-invite-votes.sql"));
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
    YOUTUBE_API_KEY: "yt-key", TREG_API_KEY: "",
  };
}

function host(uid: string, o: any = {}) {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, presence, topics_json, phone, women_lane) VALUES (?,?,?,?,?,?,?,?)")
    .run(uid, "slug-" + uid, o.status ?? "approved", o.name ?? "Name " + uid, o.presence ?? "online", JSON.stringify(o.topics ?? []), "+919876543210", o.women ?? 0);
  if (o.handle) db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("hfch_" + uid, uid, o.platform ?? "instagram", o.handle, 500, "approved", 1, 1);
}
const call = (method: string, path: string, uid = "u1", f?: any) =>
  hfSearchRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid } }), env, path.split("?")[0], f);
const body = async (r: Response) => ({ status: r.status, ...(await r.json()) });
const ytFetch = (counter: { n: number }, exists = true) => async () => {
  counter.n++;
  return new Response(JSON.stringify(exists ? { items: [{ id: "UCabcdefghijklmnopqrstuv", snippet: { customUrl: "@newstar", title: "New" }, statistics: { subscriberCount: "4200" } }] } : { items: [] }), { status: 200 });
};

beforeEach(() => { makeEnv(); cfg = { hfReelsEnabled: true, hfInvitesEnabled: true, hfDemoInfluencersVisible: true }; authFail = null; });

describe("handle helpers", () => {
  it("normalises and detects exact handles", () => {
    expect(normHandle("@Some.Name")).toBe("some.name");
    expect(normHandle("a")).toBeNull();
    expect(exactHandle("@newstar")).toBe("newstar");
    expect(exactHandle("newstar")).toBeNull();
  });
});

describe("GET /api/hf/search", () => {
  it("is 404 when hfReelsEnabled is off", async () => {
    cfg = { hfReelsEnabled: false };
    expect((await body(await call("GET", "/api/hf/search?q=a"))).status).toBe(404);
  });
  it("matches name, handle and topic and splits online / offline; protected lane and unapproved hosts are hidden", async () => {
    host("a", { name: "Maya Rao", presence: "online", handle: "@maya_r", topics: ["travel-and-food"] });
    host("b", { name: "Mayank", presence: "offline" });
    host("c", { name: "Maya Secret", presence: "online", women: 1 });
    host("d", { name: "Maya Draft", status: "draft" });
    host("e", { name: "Zed", presence: "busy", topics: ["travel-and-food"] });
    const j = await body(await call("GET", "/api/hf/search?q=maya"));
    expect(j.online.map((h: any) => h.slug)).toEqual(["slug-a", "slug-c"]); // [HF-CREATOR-SPACES-1] space hosts are no longer excluded
    expect(j.offline.map((h: any) => h.slug)).toEqual(["slug-b"]);
    expect(j.online[0].handle).toBe("@maya_r");
    const byHandle = await body(await call("GET", "/api/hf/search?q=maya_r"));
    expect(byHandle.online.map((h: any) => h.slug)).toEqual(["slug-a"]);
    const byTopicLabel = await body(await call("GET", "/api/hf/search?q=travel"));
    expect(byTopicLabel.online.map((h: any) => h.slug).sort()).toEqual(["slug-a", "slug-e"]);
    const byTopicChip = await body(await call("GET", "/api/hf/search?topic=travel-and-food"));
    expect(byTopicChip.online.length).toBe(2);
  });
  it("[HF-CREATOR-SPACES-1] space=women|lgbtq filters, carries space + videoKycVerified, and rejects junk", async () => {
    host("a", { name: "Maya Rao", presence: "online" });
    host("w", { name: "Maya Women", presence: "online", women: 1 });
    host("l", { name: "Maya Pride", presence: "online" });
    db.prepare("UPDATE hf_hosts SET lgbtq_lane=1, lgbtq_public=1 WHERE uid='l'").run();
    host("p", { name: "Maya Private", presence: "online" });
    db.prepare("UPDATE hf_hosts SET lgbtq_lane=1, lgbtq_public=0 WHERE uid='p'").run();
    db.prepare("INSERT INTO hf_kyc VALUES ('w','F',1)").run();
    db.prepare("INSERT INTO hf_selfie VALUES ('s1','w',1,'approved',NULL)").run();
    db.prepare("INSERT INTO hf_kyc VALUES ('l','T',1)").run();
    db.prepare("INSERT INTO hf_selfie VALUES ('s2','l',1,'pending',NULL)").run();
    const all = await body(await call("GET", "/api/hf/search?q=maya"));
    const by = Object.fromEntries(all.online.map((h: any) => [h.slug, h]));
    expect(by["slug-a"]).toMatchObject({ space: null, videoKycVerified: false });
    expect(by["slug-w"]).toMatchObject({ space: "women", videoKycVerified: true });
    expect(by["slug-l"]).toMatchObject({ space: "lgbtq", videoKycVerified: false }); // selfie still pending
    expect(by["slug-p"]).toMatchObject({ space: null }); // the public tag was not consented to
    const w = await body(await call("GET", "/api/hf/search?q=maya&space=women"));
    expect(w.online.map((h: any) => h.slug)).toEqual(["slug-w"]);
    const l = await body(await call("GET", "/api/hf/search?space=lgbtq"));
    expect(l.online.map((h: any) => h.slug)).toEqual(["slug-l"]);
    expect((await call("GET", "/api/hf/search?space=men")).status).toBe(400);
  });
  it("never returns phone numbers, uids or emails", async () => {
    host("a", { name: "Maya", handle: "@maya_r" });
    const txt = await (await call("GET", "/api/hf/search?q=maya")).text();
    expect(txt).not.toMatch(/9876543210|"uid"|phone|email/i);
  });
  it("adds notOnNetwork for an exact @handle (provider look-up) with vote count, and caches the look-up for 24 h", async () => {
    const c = { n: 0 };
    db.prepare("INSERT INTO hf_invite_votes (handle, platform, uid, at) VALUES ('newstar','youtube','x1',1)").run();
    const j1 = await body(await call("GET", "/api/hf/search?q=%40newstar", "u1", ytFetch(c)));
    expect(j1.notOnNetwork).toEqual([{ handle: "@newstar", platform: "youtube", followers: 4200, votes: 1 }]);
    expect(c.n).toBe(1);
    await call("GET", "/api/hf/search?q=%40newstar", "u1", ytFetch(c));
    expect(c.n).toBe(1); // second search served from the KV cache
    expect([...kv.keys()].some((k) => k.startsWith("hfinv:lk:youtube:newstar"))).toBe(true);
  });
  it("does not offer Invite for a handle that is already on the network, or when the provider is not configured", async () => {
    host("a", { name: "Maya", handle: "@newstar", platform: "youtube" });
    const c = { n: 0 };
    const j = await body(await call("GET", "/api/hf/search?q=%40newstar", "u1", ytFetch(c)));
    expect(j.notOnNetwork).toEqual([]);
    expect(j.online.length).toBe(1);
    env.YOUTUBE_API_KEY = "";
    const j2 = await body(await call("GET", "/api/hf/search?q=%40nobody"));
    expect(j2.status).toBe(200);
    expect(j2.notOnNetwork).toEqual([]);
  });
  it("shows nothing for a handle the provider says does not exist", async () => {
    const j = await body(await call("GET", "/api/hf/search?q=%40ghost", "u1", ytFetch({ n: 0 }, false)));
    expect(j.notOnNetwork).toEqual([]);
  });
});

describe("invite votes", () => {
  it("401 when signed out", async () => {
    authFail = { status: 401, error: "unauthorized" };
    expect((await body(await call("POST", "/api/hf/invites/youtube/newstar"))).status).toBe(401);
  });
  it("404 when hfInvitesEnabled is off", async () => {
    cfg = { hfReelsEnabled: true, hfInvitesEnabled: false };
    expect((await body(await call("POST", "/api/hf/invites/youtube/newstar"))).status).toBe(404);
    expect((await body(await call("GET", "/api/hf/invites/top"))).status).toBe(404);
  });
  it("one vote per user per creator, idempotent; a second user raises the count", async () => {
    const a = await body(await call("POST", "/api/hf/invites/instagram/NewStar", "u1"));
    expect(a).toMatchObject({ status: 200, ok: true, votes: 1, voted: true });
    expect((await body(await call("POST", "/api/hf/invites/instagram/newstar", "u1"))).votes).toBe(1);
    expect((await body(await call("POST", "/api/hf/invites/instagram/newstar", "u2"))).votes).toBe(2);
    expect((await body(await call("POST", "/api/hf/invites/youtube/newstar", "u1"))).votes).toBe(1); // other platform = other creator
  });
  it("rejects a bad handle and a creator already on the network", async () => {
    expect((await body(await call("POST", "/api/hf/invites/instagram/a%20b!"))).status).toBe(400);
    host("a", { handle: "@onnet" });
    expect((await body(await call("POST", "/api/hf/invites/instagram/onnet"))).status).toBe(409);
  });
  it("top lists most-wanted first, without uids, and drops creators who have since joined", async () => {
    for (const u of ["u1", "u2", "u3"]) await call("POST", "/api/hf/invites/instagram/big", u);
    await call("POST", "/api/hf/invites/youtube/small", "u1");
    await call("POST", "/api/hf/invites/instagram/joined", "u1");
    host("a", { handle: "@joined" });
    const r = await call("GET", "/api/hf/invites/top", "");
    const j = await body(r);
    expect(j.items.map((i: any) => [i.handle, i.platform, i.votes])).toEqual([["@big", "instagram", 3], ["@small", "youtube", 1]]);
    expect(JSON.stringify(j)).not.toMatch(/u1|uid/);
  });
  it("admin ranking is admin-only", async () => {
    await call("POST", "/api/hf/invites/instagram/big", "u1");
    expect((await body(await call("GET", "/api/admin/hf/invites", "u1"))).status).toBe(403);
    authFail = { status: 401, error: "unauthorized" };
    expect((await body(await call("GET", "/api/admin/hf/invites", "admin1"))).status).toBe(401);
    authFail = null;
    const j = await body(await call("GET", "/api/admin/hf/invites", "admin1"));
    expect(j.items[0]).toMatchObject({ handle: "@big", platform: "instagram", votes: 1, onNetwork: false });
  });
});
