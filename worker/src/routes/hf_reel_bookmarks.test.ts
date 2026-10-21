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

import { hfReelBookmarksRoute } from "./hf_reel_bookmarks";


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
  db.exec(mig("20261021_hf_reel_bookmarks.sql"));
  db.exec(mig("2026-10-20-hf-invite-creators.sql"));
  db.exec(mig("2026-10-19-hf-invite-votes.sql"));
  db.exec("CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT)");
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
const call = (method = "GET", id = "", uid = "u1") => {
  const path = "/api/hf/reel-bookmarks" + (id ? "/" + id : "");
  return hfReelBookmarksRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid } }), env, path);
};
const body = async (r: Response) => ({ status: r.status, ...(await r.json()) });
beforeEach(() => { makeEnv(); cfg = { hfReelsEnabled: true, hfFavouritesEnabled: true, hfInviteReelsEnabled: true, hfDemoInfluencersVisible: true }; authFail = null; n = 0; });

describe("reel bookmarks", () => {
  it("requires authentication and enabled flags", async () => {
    authFail = { status: 401, error: "unauthorized" };
    expect((await call()).status).toBe(401);
    authFail = null; cfg.hfFavouritesEnabled = false;
    expect((await call()).status).toBe(404);
  });
  it("persists idempotently and isolates accounts; hidden reels stop being listed", async () => {
    host("a"); reel("hfrl_aaaaaaaa01", "a");
    expect((await call("PUT", "hfrl_aaaaaaaa01")).status).toBe(200);
    expect((await call("PUT", "hfrl_aaaaaaaa01")).status).toBe(200);
    expect((await body(await call())).items).toHaveLength(1);
    expect((await body(await call("GET", "", "u2"))).items).toEqual([]);
    await call("DELETE", "hfrl_aaaaaaaa01", "u2");
    expect((await body(await call())).items).toHaveLength(1);
    db.exec("UPDATE hf_reels SET visible=0");
    expect((await body(await call())).items).toEqual([]);
    expect((await call("PUT", "hfrl_aaaaaaaa01")).status).toBe(404);
    expect((await call("DELETE", "hfrl_aaaaaaaa01")).status).toBe(200);
    expect((await call("DELETE", "hfrl_aaaaaaaa01")).status).toBe(200);
  });
  it("saves invite reels and excludes a hidden creator from reads and writes", async () => {
    db.exec("INSERT INTO hf_invite_creators (platform,handle,last_lookup_at,created_at) VALUES ('youtube','artist',1,1)");
    db.exec("INSERT INTO hf_invite_reels (id,platform,handle,platform_video_id,embed_url,fetched_at) VALUES ('hfiv_abcdefgh1234','youtube','artist','v1','https://www.youtube.com/embed/v1',1)");
    expect((await call("PUT", "hfiv_abcdefgh1234")).status).toBe(200);
    const item = (await body(await call())).items[0];
    expect(item.kind).toBe("invite");
    expect(item.id).toBe("hfiv_abcdefgh1234");
    db.exec("UPDATE hf_invite_creators SET hidden=1");
    expect((await body(await call())).items).toEqual([]);
    expect((await call("PUT", "hfiv_abcdefgh1234")).status).toBe(404);
    expect((await call("DELETE", "hfiv_abcdefgh1234")).status).toBe(200);
  });
  it("enforces the atomic 500 limit while keeping repeated saves idempotent", async () => {
    host("a"); reel("hfrl_aaaaaaaa01", "a");
    for (let i = 0; i < 500; i++) db.prepare("INSERT INTO hf_reel_bookmarks VALUES (?,?,?)").run("u1", "hfrl_" + String(i).padStart(12,"0"), i);
    expect((await call("PUT", "hfrl_aaaaaaaa01")).status).toBe(409);
    db.prepare("UPDATE hf_reel_bookmarks SET reel_id=? WHERE reel_id=?").run("hfrl_aaaaaaaa01", "hfrl_000000000000");
    expect((await call("PUT", "hfrl_aaaaaaaa01")).status).toBe(200);
  });
});
