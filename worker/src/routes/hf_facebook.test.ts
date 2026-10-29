// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-FB-LOGIN-1] Log in with Facebook: flag off = coming soon, start, callback (happy path, no Page, cancel, below minimum, claimed, replay, bad state),
// Meta deauthorize / data deletion, Remove channel, daily sync skips it, verifiedSocials builder.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

let cfg: Record<string, unknown> = {};
const events: { event: string; props: any; uid: string }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _a: string, props: any) => { events.push({ event, props, uid }); },
  trackUser: async (_e: any, uid: string, email: string | null, event: string, _a: string, props: any) => { events.push({ event, props: { ...props, email }, uid }); },
  trackException: async () => {},
}));
vi.mock("../lib/identity", () => ({ emailFor: async () => "maya@example.com" }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (u: any) => !!u?.error,
}));

import { hfFacebookRoute } from "./hf_facebook";
import { hfChannelsRoute, recheckAllChannels } from "./hf_channels";
import { signFbState, verifyFbState, FB_SCOPES } from "../lib/hf_facebook";
import { verifiedSocialsFor, verifiedSocialsForMany, shapeVerifiedSocials } from "../lib/hf_public_channels";
import { purgeHfUser } from "../lib/hf_purge";
import { BRAND } from "../lib/brand";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");
const SECRET = "fb-secret-xyz";
const SCHEME = BRAND.domain.split(".")[0];
let db: any, env: any, kv: Map<string, string>, pages: any[], seen: string[], me: any;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, slug TEXT, price_per_min INTEGER NOT NULL DEFAULT 20, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, women_lane INTEGER NOT NULL DEFAULT 0, lgbtq_lane INTEGER NOT NULL DEFAULT 0, lgbtq_public INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_hf_hosts_slug ON hf_hosts(slug);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER); CREATE TABLE hf_selfie (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
    CREATE TABLE hf_lane_access (uid TEXT, lane TEXT, verified_at INTEGER, declared_at INTEGER, PRIMARY KEY (uid, lane)); CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT, taken_by_uid TEXT); CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);`);
  for (const f of ["2026-10-19-hf-channels.sql", "hf_creator_spaces.sql", "hf_creator_badges.sql", "2026-10-19-hf-reels.sql", "2026-10-24-hf-reel-engage.sql", "2026-10-24-hf-instagram-login.sql", "2026-10-28-hf-facebook-login.sql"]) db.exec(mig(f));
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
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
    FACEBOOK_APP_SECRET: SECRET, YOUTUBE_API_KEY: "",
  };
}
const page = (over: any = {}) => ({ id: "1000000000001", name: "Maya Reels", link: "https://www.facebook.com/mayareels", username: "mayareels", followers_count: 500, fan_count: 480, ...over });

beforeEach(() => {
  makeEnv();
  events.length = 0;
  seen = [];
  pages = [page()];
  me = { id: "7000000000001", name: "Maya" };
  cfg = { hfChannelsEnabled: true, hfFacebookLoginEnabled: true, hfFacebookAppId: "1234567890", hfInfluencerMinFollowers: 10, hfInfluencerMinViews: 0 };
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    seen.push(u.split("?")[0]);
    if (u.startsWith("https://graph.facebook.com/v21.0/oauth/access_token")) return new Response(JSON.stringify({ access_token: "USERTOKEN", token_type: "bearer" }), { status: 200 });
    if (u.startsWith("https://graph.facebook.com/v21.0/me/accounts")) return new Response(JSON.stringify({ data: pages }), { status: 200 });
    if (u.startsWith("https://graph.facebook.com/v21.0/me?")) return new Response(JSON.stringify(me), { status: 200 });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, method = "GET", uid = "u1", body?: BodyInit, headers: Record<string, string> = {}) =>
  hfFacebookRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid, ...headers }, body }), env, path.split("?")[0]);
async function start(uid = "u1", client = "app") {
  const r = await call(`/api/hf/channels/facebook/start?client=${client}`, "GET", uid);
  const j = await r.json();
  return { r, j, state: j.url ? new URL(j.url).searchParams.get("state") : null };
}
const callback = (state: string | null, extra = "code=AUTHCODE") => call(`/api/hf/channels/facebook/callback?${extra}&state=${encodeURIComponent(state ?? "")}`);
const loc = (r: Response) => new URL(r.headers.get("location")!.replace(`${SCHEME}://`, "app://"));
const flush = () => new Promise((r) => setTimeout(r, 5));
const row = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a);
const count = (sql: string, ...a: unknown[]) => Number(db.prepare(sql).get(...a).c);
const signedRequest = (payload: any, secret = SECRET) => {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return createHmac("sha256", secret).update(p).digest("base64url") + "." + p;
};
const form = (sr: string) => ({ body: new URLSearchParams({ signed_request: sr }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
async function connect(uid = "u1") {
  const { state } = await start(uid);
  const r = await callback(state);
  expect(r.status).toBe(302);
  return { r, ch: row("SELECT * FROM hf_channels WHERE host_uid=? AND platform='facebook'", uid) };
}

describe("flag off keeps 'coming soon'", () => {
  it("POST /api/hf/channels platform facebook says coming soon; the start route is 404", async () => {
    cfg.hfFacebookLoginEnabled = false;
    const r = await hfChannelsRoute(new Request("https://x/api/hf/channels", { method: "POST", headers: { "x-test-uid": "u1" }, body: JSON.stringify({ platform: "facebook", handleOrUrl: "x" }) }), env, "/api/hf/channels");
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/coming soon/i);
    expect((await call("/api/hf/channels/facebook/start")).status).toBe(404);
  });
  it("flag on: the manual route points to Log in with Facebook", async () => {
    const r = await hfChannelsRoute(new Request("https://x/api/hf/channels", { method: "POST", headers: { "x-test-uid": "u1" }, body: JSON.stringify({ platform: "facebook", handleOrUrl: "x" }) }), env, "/api/hf/channels");
    expect((await r.json()).message).toMatch(/Log in with Facebook/);
  });
});

describe("start", () => {
  it("returns the Facebook dialog URL with the right app id, scopes and redirect", async () => {
    const { r, j } = await start();
    expect(r.status).toBe(200);
    const u = new URL(j.url);
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v21.0/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("1234567890");
    expect(u.searchParams.get("scope")).toBe(FB_SCOPES);
    expect(u.searchParams.get("redirect_uri")).toBe(`${BRAND.apiOrigin}/api/hf/channels/facebook/callback`);
    expect(await verifyFbState(env, u.searchParams.get("state"))).toMatchObject({ uid: "u1", client: "app" });
  });
  it("[HF-FB-CONFIG-ID] uses config_id instead of scope when a Login for Business configuration is set", async () => {
    cfg.hfFacebookConfigId = "2164704090752250";
    const u = new URL((await start()).j.url);
    expect(u.searchParams.get("config_id")).toBe("2164704090752250");
    expect(u.searchParams.get("scope")).toBeNull();
    cfg.hfFacebookConfigId = "";
  });
  it("503 when the secret or app id is missing", async () => {
    delete env.FACEBOOK_APP_SECRET;
    expect((await start()).r.status).toBe(503);
    env.FACEBOOK_APP_SECRET = SECRET; cfg.hfFacebookAppId = "";
    expect((await start()).r.status).toBe(503);
  });
  it("state rejects tampering and a different secret", async () => {
    const s = await signFbState(env, { uid: "u1", client: "app", nonce: "n", exp: Date.now() + 60000 });
    expect(await verifyFbState({ ...env, FACEBOOK_APP_SECRET: "other" }, s)).toBeNull();
    expect(await verifyFbState(env, s + "x")).toBeNull();
    expect(await verifyFbState(env, await signFbState(env, { uid: "u1", client: "app", nonce: "n", exp: Date.now() - 1 }))).toBeNull();
  });
});

describe("callback", () => {
  it("saves a verified, approved facebook channel (provider_ref facebook-oauth) and sends the app back", async () => {
    const { r, ch } = await connect();
    expect(loc(r).searchParams.get("fb")).toBe("connected");
    expect(loc(r).searchParams.get("result")).toBe("approved");
    expect(ch).toMatchObject({ platform: "facebook", handle: "mayareels", url: "https://www.facebook.com/mayareels", platform_user_id: "1000000000001", followers: 500, status: "approved", provider_ref: "facebook-oauth" });
    expect(ch.verified_at).toBeGreaterThan(0);
    expect(row("SELECT fb_user_id FROM hf_fb_logins WHERE channel_id=?", ch.id).fb_user_id).toBe("7000000000001");
    expect(row("SELECT status FROM hf_hosts WHERE uid='u1'").status).toBe("approved");
    await flush();
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["hf_channel_oauth_start", "hf_channel_oauth_done", "hf_channel_added"]));
    expect(events.find((e) => e.event === "hf_channel_oauth_done").props.platform).toBe("facebook");
  });
  it("the token is never stored", async () => {
    await connect();
    expect(JSON.stringify(db.prepare("SELECT * FROM hf_fb_logins").all())).not.toContain("USERTOKEN");
  });
  it("web client redirects to the web origin", async () => {
    const { state } = await start("u1", "web");
    const r = await callback(state);
    expect(r.headers.get("location")).toBe(`${BRAND.webOrigin}/dashboard/become?fb=connected&result=approved`);
  });
  it("picks the Page with the most followers", async () => {
    pages = [page({ id: "1000000000002", username: "small", link: "https://www.facebook.com/small", followers_count: 20 }), page()];
    const { ch } = await connect();
    expect(ch.platform_user_id).toBe("1000000000001");
  });
  it("no Page -> reason no_page and nothing saved", async () => {
    pages = [];
    const { r } = await connect();
    expect(loc(r).searchParams.get("reason")).toBe("no_page");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels")).toBe(0);
  });
  it("below the minimum is saved but not approved", async () => {
    pages = [page({ followers_count: 3, fan_count: 3 })];
    const { r, ch } = await connect();
    expect(loc(r).searchParams.get("result")).toBe("needs_followers");
    expect(ch.status).toBe("rejected");
  });
  it("[HF-SOCIAL-STATES] a Page with no username is saved by its NAME and public link, never the numeric id", async () => {
    pages = [page({ id: "1378608792005431", username: undefined, name: "  Priya   Vlogs ", link: "https://www.facebook.com/profile.php?id=1378608792005431", followers_count: 0, fan_count: 0 })];
    const { r, ch } = await connect();
    expect(loc(r).searchParams.get("result")).toBe("needs_followers");
    expect(ch).toMatchObject({ handle: "Priya Vlogs", url: "https://www.facebook.com/profile.php?id=1378608792005431", followers: 0, status: "rejected" });
  });
  it("[HF-SOCIAL-STATES] no username, no name, no link -> 'Facebook Page' and the id link", async () => {
    pages = [page({ id: "1378608792005431", username: "", name: "", link: undefined })];
    const { ch } = await connect();
    expect(ch.handle).toBe("Facebook Page");
    expect(ch.url).toBe("https://www.facebook.com/1378608792005431");
  });
  it("[HF-SOCIAL-STATES] a reconnect replaces an old numeric handle with the Page name", async () => {
    pages = [page({ id: "1378608792005431", username: undefined, name: "Priya Vlogs", followers_count: 0, fan_count: 0 })];
    await connect();
    db.prepare("UPDATE hf_channels SET handle='1378608792005431' WHERE platform='facebook'").run();
    const { ch } = await connect();
    expect(ch.handle).toBe("Priya Vlogs");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels WHERE platform='facebook'")).toBe(1);
  });
  it("[HF-SOCIAL-STATES] GET /api/hf/channels shows a below-minimum Page with need=followers and no numeric displayHandle", async () => {
    pages = [page({ id: "1378608792005431", username: undefined, name: "Priya Vlogs", followers_count: 0, fan_count: 0 })];
    await connect();
    db.prepare("UPDATE hf_channels SET handle='1378608792005431' WHERE platform='facebook'").run(); // the production row from 2026-10-29
    const j = await (await hfChannelsRoute(new Request("https://x/api/hf/channels", { headers: { "x-test-uid": "u1" } }), env, "/api/hf/channels"))!.json();
    expect(j.qualified).toBe(false);
    expect(j.channels[0]).toMatchObject({ platform: "facebook", state: "needs_followers", verified: true, viaLogin: true, need: "followers", displayHandle: null, followers: 0 });
  });
  it("cancelled in the dialog", async () => {
    const { state } = await start();
    const r = await call(`/api/hf/channels/facebook/callback?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(state)}`);
    expect(loc(r).searchParams.get("reason")).toBe("cancelled");
  });
  it("a Page already verified by someone else is claimed", async () => {
    await connect("u1");
    const { r } = await connect("u2");
    expect(loc(r).searchParams.get("reason")).toBe("claimed");
  });
  it("replaying a state is bad_state; a forged state goes to the web with bad_state", async () => {
    const { state } = await start();
    await callback(state);
    expect(loc(await callback(state)).searchParams.get("reason")).toBe("bad_state");
    expect((await callback("garbage")).headers.get("location")).toContain("reason=bad_state");
  });
  it("flag turned off mid-flight is not_enabled", async () => {
    const { state } = await start();
    cfg.hfFacebookLoginEnabled = false;
    expect(loc(await callback(state)).searchParams.get("reason")).toBe("not_enabled");
  });
  it("a Facebook outage is provider_error", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const { r } = await connect();
    expect(loc(r).searchParams.get("reason")).toBe("provider_error");
  });
});

describe("Meta callbacks, Remove and the daily sync", () => {
  it("deauthorize disconnects the channel and forgets the mapping", async () => {
    const { ch } = await connect();
    const r = await call("/api/hf/channels/facebook/deauthorize", "POST", "u1", ...Object.values(form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "7000000000001" }))));
    expect(r.status).toBe(200);
    expect(row("SELECT status FROM hf_channels WHERE id=?", ch.id).status).toBe("disconnected");
    expect(count("SELECT COUNT(*) AS c FROM hf_fb_logins")).toBe(0);
  });
  it("data deletion answers url + confirmation_code and the status page finds it; a bad signature is 400", async () => {
    await connect();
    const f = form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "7000000000001" }));
    const r = await call("/api/hf/channels/facebook/data-deletion", "POST", "u1", f.body, f.headers);
    const j = await r.json();
    expect(j.url).toBe(`${BRAND.webOrigin}/data-deletion?code=${j.confirmation_code}`);
    expect((await call(`/api/hf/channels/facebook/data-deletion-status?code=${j.confirmation_code}`)).status).toBe(200);
    const bad = form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "7000000000001" }, "wrong"));
    expect((await call("/api/hf/channels/facebook/data-deletion", "POST", "u1", bad.body, bad.headers)).status).toBe(400);
  });
  it("Remove channel clears the mapping", async () => {
    const { ch } = await connect();
    const r = await hfChannelsRoute(new Request(`https://x/api/hf/channels/${ch.id}`, { method: "DELETE", headers: { "x-test-uid": "u1" } }), env, `/api/hf/channels/${ch.id}`);
    expect(r.status).toBe(200);
    expect(count("SELECT COUNT(*) AS c FROM hf_fb_logins")).toBe(0);
  });
  it("the daily sync leaves a facebook-login channel alone and never calls Facebook", async () => {
    const { ch } = await connect();
    db.prepare("UPDATE hf_channels SET last_sync_at=1 WHERE id=?").run(ch.id);
    seen = [];
    const out = await recheckAllChannels(env);
    expect(out.scanned).toBe(0);
    expect(seen).toEqual([]);
    expect(row("SELECT status FROM hf_channels WHERE id=?", ch.id).status).toBe("approved");
  });
  it("purgeHfUser removes the mapping", async () => {
    await connect("gone");
    const res = await purgeHfUser({ DB_META: env.DB_META }, "gone");
    expect(res.errors).toEqual([]);
    expect(count("SELECT COUNT(*) AS c FROM hf_fb_logins")).toBe(0);
  });
});

describe("verifiedSocials", () => {
  const add = (id: string, uid: string, platform: string, handle: string, ref: string | null, followers = 100, status = "approved", verified = 1, url: string | null = null) =>
    db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, url, platform_user_id, followers, views, verify_code, verified_at, status, consent_version, consent_at, provider_ref, last_sync_at, created_at) VALUES (?,?,?,?,?,?,?,0,NULL,?,?,'v',1,?,1,1)")
      .run(id, uid, platform, handle, url, id + "p", followers, verified ? 1 : null, status, ref);
  it("lists only accounts proven by login, in YouTube / Instagram / Facebook order, with followers when known", async () => {
    add("hfch_a", "h1", "facebook", "mayareels", "facebook-oauth", 500, "approved", 1, "https://www.facebook.com/mayareels");
    add("hfch_b", "h1", "instagram", "maya.reels", "instagram-oauth", 900);
    add("hfch_c", "h1", "youtube", "mayatv", "youtube-oauth", 0);
    add("hfch_d", "h1", "instagram", "bio.code", "treg", 5000);            // bio-code: not proven by login
    add("hfch_e", "h1", "youtube", "viaapi", "youtube-data-api-v3", 5000); // bio-code
    add("hfch_f", "h1", "facebook", "pending", "facebook-oauth", 5000, "rejected"); // not approved
    add("hfch_g", "h1", "instagram", "gone", "instagram-oauth", 5000, "disconnected");
    expect(await verifiedSocialsFor(env, "h1")).toEqual([
      { platform: "youtube", handle: "mayatv", url: "https://www.youtube.com/@mayatv" },
      { platform: "instagram", handle: "maya.reels", url: "https://www.instagram.com/maya.reels/", followers: 900 },
      { platform: "facebook", handle: "mayareels", url: "https://www.facebook.com/mayareels", followers: 500 },
    ]);
  });
  it("many hosts in one go; a host with none gets an empty list; empty input is fine", async () => {
    add("hfch_h", "h2", "facebook", "pg", "facebook-oauth", 50, "approved", 1, "https://www.facebook.com/pg");
    const m = await verifiedSocialsForMany(env, ["h2", "h3", ""]);
    expect(m.get("h2")).toHaveLength(1);
    expect(m.get("h3")).toBeUndefined();
    expect((await verifiedSocialsForMany(env, [])).size).toBe(0);
    expect(await verifiedSocialsFor(env, "nobody")).toEqual([]);
  });
  it("shape drops duplicates and non-https urls fall back to the profile url", () => {
    const out = shapeVerifiedSocials([
      { platform: "facebook", handle: "pg", url: "http://evil", followers: 1, provider_ref: "facebook-oauth" },
      { platform: "facebook", handle: "pg", url: null, followers: 1, provider_ref: "facebook-oauth" },
      { platform: "tiktok", handle: "x", url: null, followers: 1, provider_ref: "tiktok-oauth" },
    ]);
    expect(out).toEqual([{ platform: "facebook", handle: "pg", url: "https://www.facebook.com/pg", followers: 1 }]);
  });
});
