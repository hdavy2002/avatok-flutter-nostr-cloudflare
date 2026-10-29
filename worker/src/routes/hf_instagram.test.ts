// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-IG-LOGIN-1] Log in with Instagram: state signing, start, callback (happy path, personal account, cancel, bio-code upgrade, below minimum), token encrypted at rest,
// reels import (official API), comments import gated by provider_ref, token refresh / needs_reconnect, Meta deauthorize + data deletion, Remove channel, purge.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
const events: { event: string; props: any; uid: string }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _a: string, props: any) => { events.push({ event, props, uid }); },
  trackUser: async (_e: any, uid: string, email: string | null, event: string, _a: string, props: any) => { events.push({ event, props: { ...props, email }, uid }); },
  trackException: async () => {},
}));
vi.mock("../lib/identity", () => ({ emailFor: async () => "maya@example.com" }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));

import { hfInstagramRoute } from "./hf_instagram";
import { hfChannelsRoute, recheckAllChannels } from "./hf_channels";
import { signState, verifyState, decryptToken, refreshTokenIfDue, parseSignedRequest, IG_REFRESH_AFTER_MS } from "../lib/hf_instagram";
import { importAllowed, refreshExtComments, canPullComments } from "../lib/hf_reel_engage";
import { importChannelReels } from "../lib/hf_reels_import";
import { purgeHfUser } from "../lib/hf_purge";
import { BRAND } from "../lib/brand";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");
const SECRET = "app-secret-xyz";
const KEY = Buffer.alloc(32, 7).toString("base64");
const SCHEME = BRAND.domain.split(".")[0];
let db: any, env: any, kv: Map<string, string>;

// What the fake Instagram answers.
let me: any, media: any, comments: any, refresh: { status: number; body: any }, seen: string[];
const profile = (over: any = {}) => ({ id: "17841400000000001", user_id: "17841400000000099", username: "maya.reels", account_type: "MEDIA_CREATOR", followers_count: 500, media_count: 12, profile_picture_url: "https://cdn.x/p.jpg", ...over });
const mediaPage = () => ({
  data: [
    { id: "17900000000000001", shortcode: "Cabc123", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/Cabc123/", thumbnail_url: "https://cdn.x/t1.jpg", caption: "Hi", like_count: 9, comments_count: 3, timestamp: "2026-10-20T10:00:00+0000" },
    { id: "17900000000000002", shortcode: "Cimg999", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://www.instagram.com/p/Cimg999/", like_count: 1, comments_count: 0, timestamp: "2026-10-19T10:00:00+0000" },
    { id: "17900000000000003", shortcode: "Cdef456", media_type: "VIDEO", media_product_type: "FEED", permalink: "https://www.instagram.com/p/Cdef456/", thumbnail_url: "https://cdn.x/t3.jpg", caption: "Old video", like_count: 2, comments_count: 1, timestamp: "2026-10-18T10:00:00+0000" },
  ],
});

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, slug TEXT, price_per_min INTEGER NOT NULL DEFAULT 20, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, women_lane INTEGER NOT NULL DEFAULT 0, lgbtq_lane INTEGER NOT NULL DEFAULT 0, lgbtq_public INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_hf_hosts_slug ON hf_hosts(slug);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER); CREATE TABLE hf_selfie (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
    CREATE TABLE hf_lane_access (uid TEXT, lane TEXT, verified_at INTEGER, declared_at INTEGER, PRIMARY KEY (uid, lane)); CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT, taken_by_uid TEXT); CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);`);
  for (const f of ["2026-10-19-hf-channels.sql", "hf_creator_spaces.sql", "hf_creator_badges.sql", "2026-10-19-hf-reels.sql", "2026-10-24-hf-reel-engage.sql", "2026-10-24-hf-instagram-login.sql"]) db.exec(mig(f));
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
    INSTAGRAM_APP_SECRET: SECRET, HF_TOKEN_ENC_KEY: KEY, YOUTUBE_API_KEY: "",
  };
}

beforeEach(() => {
  makeEnv();
  events.length = 0;
  authFail = null;
  cfg = { hfChannelsEnabled: true, hfInstagramLoginEnabled: true, hfReelsEnabled: true, hfInfluencerMinFollowers: 10, hfInfluencerMinViews: 0 };
  me = { status: 200, body: profile() };
  media = { status: 200, body: mediaPage() };
  comments = { status: 200, body: { data: Array.from({ length: 40 }, (_, i) => ({ id: `1800000000${String(i).padStart(4, "0")}`, text: `nice ${i}`, username: `fan${i}`, like_count: i, timestamp: "2026-10-21T10:00:00+0000" })) } };
  refresh = { status: 200, body: { access_token: "REFRESHED", token_type: "bearer", expires_in: 5184000 } };
  seen = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    seen.push(`${init.method ?? "GET"} ${u.split("?")[0]}`);
    if (u.startsWith("https://api.instagram.com/oauth/access_token")) return new Response(JSON.stringify({ access_token: "SHORT", user_id: 17841400000000001, permissions: "instagram_business_basic,instagram_business_manage_comments" }), { status: 200 });
    if (u.startsWith("https://graph.instagram.com/access_token")) return new Response(JSON.stringify({ access_token: "LONGTOKEN", token_type: "bearer", expires_in: 5184000 }), { status: 200 });
    if (u.startsWith("https://graph.instagram.com/refresh_access_token")) return new Response(JSON.stringify(refresh.body), { status: refresh.status });
    if (u.startsWith("https://graph.instagram.com/me")) return new Response(JSON.stringify(me.body), { status: me.status });
    if (/^https:\/\/graph\.instagram\.com\/\d+\/media\?/.test(u)) return new Response(JSON.stringify(media.body), { status: media.status });
    if (/^https:\/\/graph\.instagram\.com\/\d+\/comments\?/.test(u)) return new Response(JSON.stringify(comments.body), { status: comments.status });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, method = "GET", uid = "u1", body?: BodyInit, headers: Record<string, string> = {}) =>
  hfInstagramRoute(new Request("https://x" + path, { method, headers: { "x-test-uid": uid, ...headers }, body }), env, path.split("?")[0]);
async function start(uid = "u1", client = "app") {
  const r = await call(`/api/hf/channels/instagram/start?client=${client}`, "GET", uid);
  const j = await r.json();
  return { r, j, state: j.url ? new URL(j.url).searchParams.get("state") : null };
}
const callback = (state: string | null, extra = "code=AUTHCODE") => call(`/api/hf/channels/instagram/callback?${extra}&state=${encodeURIComponent(state ?? "")}`);
const loc = (r: Response) => new URL(r.headers.get("location")!.replace(`${SCHEME}://`, "app://"));
const flush = () => new Promise((r) => setTimeout(r, 5)); // fire-and-forget telemetry settles
const row = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a);
const count = (sql: string, ...a: unknown[]) => Number(db.prepare(sql).get(...a).c);

async function connect(uid = "u1") {
  const { state } = await start(uid);
  const r = await callback(state);
  expect(r.status).toBe(302);
  return { r, ch: row("SELECT * FROM hf_channels WHERE host_uid=? AND platform='instagram'", uid) };
}
const signedRequest = (payload: any, secret = SECRET) => {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return createHmac("sha256", secret).update(p).digest("base64url") + "." + p;
};
const form = (sr: string) => ({ body: new URLSearchParams({ signed_request: sr }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("state", () => {
  it("signs, verifies, and rejects tampering, expiry and a different secret", async () => {
    const exp = Date.now() + 600_000;
    const s = await signState(env, { uid: "u1", client: "app", nonce: "n1", exp });
    expect(await verifyState(env, s)).toEqual({ uid: "u1", client: "app", nonce: "n1", exp, ret: "become" }); // [HF-VERIFY-WEB-FLOW] default return
    const [b, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "hfig", uid: "u2", client: "app", nonce: "n1", exp })).toString("base64url");
    expect(await verifyState(env, `${forged}.${sig}`)).toBeNull();
    expect(await verifyState(env, `${b}.AAAA`)).toBeNull();
    expect(await verifyState(env, "garbage")).toBeNull();
    expect(await verifyState(env, s, exp + 1)).toBeNull();
    expect(await verifyState({ ...env, INSTAGRAM_APP_SECRET: "other" }, s)).toBeNull();
  });
});

describe("GET /start", () => {
  it("is 404 with the flag off (before auth), 401 signed out, 503 without the secrets", async () => {
    cfg.hfInstagramLoginEnabled = false;
    authFail = { status: 401, error: "auth" };
    expect((await call("/api/hf/channels/instagram/start")).status).toBe(404);
    cfg.hfInstagramLoginEnabled = true;
    expect((await call("/api/hf/channels/instagram/start")).status).toBe(401);
    authFail = null;
    delete env.INSTAGRAM_APP_SECRET;
    const r = await call("/api/hf/channels/instagram/start");
    expect(r.status).toBe(503);
    await flush();
    expect(events.some((e) => e.event === "hf_channel_oauth_fail" && e.props.reason === "not_configured")).toBe(true);
  });

  it("returns the Instagram authorize URL with the brand callback, both scopes and a verifiable state", async () => {
    const { r, j, state } = await start("u1", "web");
    expect(r.status).toBe(200);
    const u = new URL(j.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("1116106647810644");
    expect(u.searchParams.get("redirect_uri")).toBe(`${BRAND.apiOrigin}/api/hf/channels/instagram/callback`);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_comments");
    const st = await verifyState(env, state);
    expect(st).toMatchObject({ uid: "u1", client: "web" });
    expect(kv.get(`hfig:n:${st.nonce}`)).toBe("u1");
    await flush();
    expect(events.find((e) => e.event === "hf_channel_oauth_start")).toMatchObject({ uid: "u1", props: { platform: "instagram", client: "web", email: "maya@example.com" } });
  });

  it("[HF-VERIFY-WEB-FLOW] return=verifications is carried in the signed state and the web comes back to My verifications; anything else is become", async () => {
    const r1 = await call("/api/hf/channels/instagram/start?client=web&return=verifications");
    const s1 = new URL((await r1.json()).url).searchParams.get("state");
    expect(await verifyState(env, s1!)).toMatchObject({ client: "web", ret: "verifications" });
    expect((await callback(s1, "error=access_denied&error_reason=user_denied")).headers.get("location")).toBe(`${BRAND.webOrigin}/dashboard/verifications?ig=error&reason=cancelled`);
    for (const bad of ["https%3A%2F%2Fevil.example", "%2F%2Fevil.example", "dashboard"]) {
      const r = await call(`/api/hf/channels/instagram/start?client=web&return=${bad}`);
      const s = new URL((await r.json()).url).searchParams.get("state");
      expect((await verifyState(env, s!))?.ret).toBe("become");
      expect((await callback(s, "error=access_denied")).headers.get("location")).toBe(`${BRAND.webOrigin}/dashboard/become?ig=error&reason=cancelled`);
    }
    const [b, sig] = (await signState(env, { uid: "u1", client: "web", nonce: "n9", exp: Date.now() + 60000 })).split(".");
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    expect(await verifyState(env, `${Buffer.from(JSON.stringify({ ...p, ret: "verifications" })).toString("base64url")}.${sig}`)).toBeNull();
  });
});

describe("GET /callback", () => {
  it("happy path: approves the channel, stores the token ENCRYPTED, imports reels only, redirects to the app", async () => {
    const { r, ch } = await connect();
    const l = loc(r);
    expect(r.headers.get("location")!.startsWith(`${SCHEME}://channels?`)).toBe(true);
    expect(l.searchParams.get("ig")).toBe("connected");
    expect(l.searchParams.get("result")).toBe("approved");
    expect(ch).toMatchObject({ handle: "maya.reels", platform_user_id: "17841400000000099", followers: 500, status: "approved", provider_ref: "instagram-oauth" });
    expect(ch.verified_at).toBeGreaterThan(0);
    expect(row("SELECT status FROM hf_hosts WHERE uid='u1'").status).toBe("approved");
    const t = row("SELECT * FROM hf_channel_tokens WHERE channel_id=?", ch.id);
    expect(t.enc_token.startsWith("v1.")).toBe(true);
    expect(t.enc_token).not.toContain("LONGTOKEN");
    expect(JSON.stringify(t)).not.toContain("LONGTOKEN");
    expect(await decryptToken(env, t.enc_token, ch.id)).toBe("LONGTOKEN");
    await expect(decryptToken(env, t.enc_token, "hfch_other")).rejects.toBeTruthy(); // bound to its channel
    expect(t).toMatchObject({ host_uid: "u1", ig_user_id: "17841400000000099", ig_scoped_id: "17841400000000001", status: "active" });
    expect(t.expires_at).toBeGreaterThan(Date.now() + 59 * 86400_000);
    // media: reels / videos only (the IMAGE post is skipped), media ids remembered
    const reels = db.prepare("SELECT * FROM hf_reels WHERE channel_id=? ORDER BY platform_video_id").all(ch.id);
    expect(reels.map((x: any) => x.platform_video_id)).toEqual(["Cabc123", "Cdef456"]);
    expect(reels[0]).toMatchObject({ platform: "instagram", url: "https://www.instagram.com/reel/Cabc123/", embed_url: "https://www.instagram.com/reel/Cabc123/embed", likes: 9, comments: 3, visible: 1 });
    expect(db.prepare("SELECT ig_media_id FROM hf_reel_ig_media WHERE channel_id=? ORDER BY ig_media_id").all(ch.id).map((x: any) => x.ig_media_id)).toEqual(["17900000000000001", "17900000000000003"]);
    expect(seen).toContain("POST https://api.instagram.com/oauth/access_token");
    expect(seen.some((s) => s.startsWith("GET https://graph.instagram.com/access_token"))).toBe(true);
    expect(seen.some((s) => s.includes("treg.to"))).toBe(false);
    await flush();
    expect(events.find((e) => e.event === "hf_channel_oauth_done")).toMatchObject({ props: { platform: "instagram", account_type: "media_creator", result: "approved", email: "maya@example.com" } });
    expect(JSON.stringify(events)).not.toMatch(/LONGTOKEN|SHORT|AUTHCODE|app-secret/);
  });

  it("a nonce works once; a bad or expired state goes to the web with bad_state", async () => {
    const { state } = await start();
    expect((await callback(state)).status).toBe(302);
    const again = await callback(state);
    expect(loc(again).searchParams.get("reason")).toBe("bad_state");
    expect(again.headers.get("location")!.startsWith(`${SCHEME}://`)).toBe(true); // a valid signature still says which client to go back to
    const junk = await callback("junk");
    expect(junk.headers.get("location")!.startsWith(BRAND.webOrigin)).toBe(true);
    expect(new URL(junk.headers.get("location")!).searchParams.get("reason")).toBe("bad_state");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels")).toBe(1);
  });

  it("a personal account (or one Instagram refuses) -> error redirect with a reason, nothing saved", async () => {
    me.body = profile({ account_type: "PERSONAL" });
    const { state } = await start();
    const l = loc(await callback(state));
    expect(l.searchParams.get("ig")).toBe("error");
    expect(l.searchParams.get("reason")).toBe("not_professional");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hf_channel_tokens")).toBe(0);
    await flush();
    expect(events.find((e) => e.event === "hf_channel_oauth_fail")).toMatchObject({ props: { reason: "not_professional", account_type: "personal" } });

    const s2 = (await start()).state;
    expect(loc(await callback(s2, "error=access_denied&error_reason=user_denied&error_description=Permissions+error")).searchParams.get("reason")).toBe("cancelled");
    const s3 = (await start()).state;
    expect(loc(await callback(s3, "error=invalid_request&error_description=Only+professional+accounts+can+log+in")).searchParams.get("reason")).toBe("not_professional");
  });

  it("client=web redirects to the website; Instagram being down is provider_error", async () => {
    const { state } = await start("u1", "web");
    me.status = 500; me.body = { error: { code: 2 } };
    const r = await callback(state);
    expect(r.headers.get("location")!.startsWith(`${BRAND.webOrigin}/`)).toBe(true);
    expect(new URL(r.headers.get("location")!).searchParams.get("reason")).toBe("provider_error");
  });

  it("an Instagram already connected by someone else is refused (claimed)", async () => {
    await connect("u1");
    const { state } = await start("u2");
    expect(loc(await callback(state)).searchParams.get("reason")).toBe("claimed");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid='u2'")).toBe(0);
  });

  it("below the follower minimum: saved as rejected, redirect says needs_followers", async () => {
    me.body = profile({ followers_count: 3 });
    const { r, ch } = await connect();
    expect(loc(r).searchParams.get("result")).toBe("needs_followers");
    expect(ch.status).toBe("rejected");
    expect(count("SELECT COUNT(*) AS c FROM hf_reels")).toBe(0);
  });

  it("a bio-code Instagram channel of the same person is upgraded in place (same row, provider_ref now instagram-oauth, reels kept)", async () => {
    db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, platform_user_id, followers, status, verified_at, provider_ref, created_at) VALUES ('hfch_old000000000001','u1','instagram','maya.reels','999',500,'approved',1,'treg',1)").run();
    db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, visible, imported_at) VALUES ('hfrl_old1','u1','hfch_old000000000001','instagram','Cabc123',0,1)").run();
    const { ch } = await connect();
    expect(ch.id).toBe("hfch_old000000000001");
    expect(ch.provider_ref).toBe("instagram-oauth");
    expect(count("SELECT COUNT(*) AS c FROM hf_channels WHERE host_uid='u1'")).toBe(1);
    expect(db.prepare("SELECT ig_media_id FROM hf_reel_ig_media WHERE reel_id='hfrl_old1'").get().ig_media_id).toBe("17900000000000001"); // the existing reel got its media id
  });

  it("the channels list shows viaLogin, and needsReconnect once the token is dead", async () => {
    const { ch } = await connect();
    const list = async () => (await (await hfChannelsRoute(new Request("https://x/api/hf/channels", { headers: { "x-test-uid": "u1" } }), env, "/api/hf/channels")).json()).channels[0];
    expect(await list()).toMatchObject({ viaLogin: true, state: "approved" });
    expect((await list()).needsReconnect).toBeUndefined();
    db.prepare("UPDATE hf_channel_tokens SET status='needs_reconnect' WHERE channel_id=?").run(ch.id);
    expect(await list()).toMatchObject({ needsReconnect: true, state: "approved" });
  });
});

describe("comments import (official API, gated by provider_ref)", () => {
  async function reelOf(ch: any, code = "Cabc123") { return row("SELECT id FROM hf_reels WHERE channel_id=? AND platform_video_id=?", ch.id, code).id; }

  it("importAllowed: only an instagram-oauth channel's network reel, with the flag on; bio-code, invite and flag-off are refused", async () => {
    const { ch } = await connect();
    const id = await reelOf(ch);
    expect(await importAllowed(env, cfg, id, "instagram")).toBe(true);
    expect(await importAllowed(env, { ...cfg, hfInstagramLoginEnabled: false }, id, "instagram")).toBe(false);
    expect(await importAllowed(env, cfg, "hfiv_abcdefghij", "instagram")).toBe(false);
    db.prepare("UPDATE hf_channels SET provider_ref='treg' WHERE id=?").run(ch.id);
    expect(await importAllowed(env, cfg, id, "instagram")).toBe(false);
    expect(canPullComments(env, "instagram")).toBe(true);
    expect(canPullComments({ ...env, HF_TOKEN_ENC_KEY: "" }, "instagram")).toBe(false);
  });

  it("refreshExtComments reads her media comments once: random seed size, ids instagram:<id>, author @username, no treg", async () => {
    const { ch } = await connect();
    const id = await reelOf(ch);
    const r = await refreshExtComments(env, id, "Cabc123", fetch, "instagram", 20);
    expect(r).toMatchObject({ ok: true, count: 20 });
    const rows = db.prepare("SELECT * FROM hf_reel_ext_comments WHERE reel_id=? ORDER BY id").all(id);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ platform: "instagram", author_name: "@fan0", body: "nice 0" });
    expect(rows[0].id.startsWith("instagram:")).toBe(true);
    expect(seen.some((s) => s.includes("graph.instagram.com/17900000000000001/comments"))).toBe(true);
    expect(seen.some((s) => s.includes("treg.to"))).toBe(false);
    expect(kv.get(`hfx:done:${id}`)).toBe("1");
  });

  it("a dead token fails the pull (retry in 10 minutes), a reel without a media id too", async () => {
    const { ch } = await connect();
    const id = await reelOf(ch);
    comments.status = 400; comments.body = { error: { code: 190, message: "expired" } };
    const r = await refreshExtComments(env, id, "Cabc123", fetch, "instagram", 20);
    expect(r.ok).toBe(false);
    expect(row("SELECT status FROM hf_channel_tokens WHERE channel_id=?", ch.id).status).toBe("needs_reconnect");
    expect(row("SELECT status FROM hf_channels WHERE id=?", ch.id).status).toBe("approved"); // approval stays
    db.prepare("DELETE FROM hf_reel_ig_media").run();
    expect((await refreshExtComments(env, id, "Cabc123", fetch, "instagram", 20)).ok).toBe(false);
  });
});

describe("token refresh", () => {
  const ago = (ms: number) => Date.now() - ms;
  it("refreshes only tokens older than 50 days, stores the new one encrypted, emits hf_ig_token_refresh", async () => {
    const { ch } = await connect();
    expect(await refreshTokenIfDue(env, ch)).toBe("skipped");
    expect(seen.some((s) => s.includes("refresh_access_token"))).toBe(false);
    db.prepare("UPDATE hf_channel_tokens SET updated_at=? WHERE channel_id=?").run(ago(IG_REFRESH_AFTER_MS + 1000), ch.id);
    expect(await refreshTokenIfDue(env, ch)).toBe("refreshed");
    const t = row("SELECT * FROM hf_channel_tokens WHERE channel_id=?", ch.id);
    expect(await decryptToken(env, t.enc_token, ch.id)).toBe("REFRESHED");
    expect(Date.now() - t.updated_at).toBeLessThan(5000);
    await flush();
    expect(events.find((e) => e.event === "hf_ig_token_refresh")).toMatchObject({ props: { ok: true, email: "maya@example.com" } });
  });

  it("code 190 / expired -> needs_reconnect (channel kept and still approved), telemetry ok:false, the daily sync does not hammer it", async () => {
    const { ch } = await connect();
    db.prepare("UPDATE hf_channel_tokens SET updated_at=? WHERE channel_id=?").run(ago(IG_REFRESH_AFTER_MS + 1000), ch.id);
    refresh = { status: 400, body: { error: { code: 190, message: "Error validating access token" } } };
    expect(await refreshTokenIfDue(env, ch)).toBe("failed");
    expect(row("SELECT status FROM hf_channel_tokens WHERE channel_id=?", ch.id).status).toBe("needs_reconnect");
    expect(row("SELECT status FROM hf_channels WHERE id=?", ch.id).status).toBe("approved");
    await flush();
    expect(events.filter((e) => e.event === "hf_ig_token_refresh").pop()).toMatchObject({ props: { ok: false } });
    // the daily sync: the channel is due again after 20 h, finds the dead token, does not call Instagram, and stamps last_sync_at
    db.prepare("UPDATE hf_channels SET last_sync_at=1 WHERE id=?").run(ch.id);
    const before = seen.length;
    const out = await recheckAllChannels(env);
    expect(out.scanned).toBe(1);
    expect(seen.slice(before).some((s) => s.includes("graph.instagram.com"))).toBe(false);
    expect(row("SELECT last_sync_at FROM hf_channels WHERE id=?", ch.id).last_sync_at).toBeGreaterThan(1000);
    expect(row("SELECT status FROM hf_hosts WHERE uid='u1'").status).toBe("approved");
  });

  it("the daily sync refreshes follower counts of a logged-in channel through /me (not treg)", async () => {
    const { ch } = await connect();
    me.body = profile({ followers_count: 777 });
    db.prepare("UPDATE hf_channels SET last_sync_at=1 WHERE id=?").run(ch.id);
    await recheckAllChannels(env);
    expect(row("SELECT followers FROM hf_channels WHERE id=?", ch.id).followers).toBe(777);
    expect(seen.some((s) => s.includes("treg.to"))).toBe(false);
  });
});

describe("deauthorize, data deletion and Remove", () => {
  async function seeded() {
    const { ch } = await connect();
    const r1 = row("SELECT id FROM hf_reels WHERE channel_id=? AND platform_video_id='Cabc123'", ch.id).id;
    await refreshExtComments(env, r1, "Cabc123", fetch, "instagram", 5);
    const ext = db.prepare("SELECT id FROM hf_reel_ext_comments WHERE reel_id=? ORDER BY id").all(r1).map((x: any) => x.id);
    db.prepare("INSERT INTO hf_reel_comments (id, reel_id, uid, parent_id, body, status, created_at) VALUES ('hfrc_r1',?,'fan1',?,'thanks!','visible',1)").run(r1, ext[0]);
    return { ch, r1, ext };
  }
  function expectWiped(ch: any, r1: string, ext: string[]) {
    expect(count("SELECT COUNT(*) AS c FROM hf_channel_tokens WHERE channel_id=?", ch.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hf_reel_ig_media WHERE channel_id=?", ch.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hf_reels WHERE channel_id=? AND visible=1", ch.id)).toBe(0);
    const left = db.prepare("SELECT id, body, author_name FROM hf_reel_ext_comments WHERE reel_id=?").all(r1);
    expect(left).toEqual([{ id: ext[0], body: "Comment removed", author_name: "Someone" }]); // only the one our users replied to stays, blanked
    expect(count("SELECT COUNT(*) AS c FROM hf_reel_comments WHERE id='hfrc_r1'")).toBe(1); // our reply is untouched
  }

  it("rejects a bad signed_request", async () => {
    await connect();
    for (const p of ["deauthorize", "data-deletion"]) {
      const bad = form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "17841400000000001" }, "wrong"));
      expect((await call(`/api/hf/channels/instagram/${p}`, "POST", "", bad.body, bad.headers)).status).toBe(400);
    }
    const noAlg = form(signedRequest({ algorithm: "none", user_id: "1" }));
    expect((await call("/api/hf/channels/instagram/deauthorize", "POST", "", noAlg.body, noAlg.headers)).status).toBe(400);
    expect(await parseSignedRequest(env, signedRequest({ algorithm: "HMAC-SHA256", user_id: 5 }))).toMatchObject({ user_id: "5" });
    expect(count("SELECT COUNT(*) AS c FROM hf_channel_tokens")).toBe(1);
  });

  it("deauthorize (app-scoped id): token + comments + reels handled, channel disconnected, no sign-in needed even with the flag off", async () => {
    const { ch, r1, ext } = await seeded();
    cfg.hfInstagramLoginEnabled = false;
    const f = form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "17841400000000001", issued_at: 1 }));
    authFail = { status: 401, error: "auth" };
    const r = await call("/api/hf/channels/instagram/deauthorize", "POST", "", f.body, f.headers);
    expect(r.status).toBe(200);
    expect(row("SELECT status FROM hf_channels WHERE id=?", ch.id).status).toBe("disconnected");
    expectWiped(ch, r1, ext);
    expect(row("SELECT status FROM hf_hosts WHERE uid='u1'").status).toBe("pending_check");
  });

  it("data-deletion (professional account id) answers { url, confirmation_code } and the status page says complete", async () => {
    const { ch, r1, ext } = await seeded();
    const f = form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "17841400000000099" }));
    const r = await call("/api/hf/channels/instagram/data-deletion", "POST", "", f.body, f.headers);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.confirmation_code).toMatch(/^hfigdel_[a-f0-9]{24}$/);
    expect(j.url).toBe(`${BRAND.webOrigin}/data-deletion?code=${j.confirmation_code}`);
    expectWiped(ch, r1, ext);
    const s = await call(`/api/hf/channels/instagram/data-deletion-status?code=${j.confirmation_code}`);
    expect(await s.json()).toMatchObject({ ok: true, status: "complete" });
    expect((await call("/api/hf/channels/instagram/data-deletion-status?code=hfigdel_000000000000000000000000")).status).toBe(404);
  });

  it("the Remove channel button does the same wipe", async () => {
    const { ch, r1, ext } = await seeded();
    const res = await hfChannelsRoute(new Request(`https://x/api/hf/channels/${ch.id}`, { method: "DELETE", headers: { "x-test-uid": "u1" } }), env, `/api/hf/channels/${ch.id}`);
    expect(res.status).toBe(200);
    expectWiped(ch, r1, ext);
  });
});

describe("account deletion", () => {
  it("purgeHfUser removes the tokens and media map", async () => {
    await connect("gone");
    expect(count("SELECT COUNT(*) AS c FROM hf_channel_tokens WHERE host_uid='gone'")).toBe(1);
    const res = await purgeHfUser({ DB_META: env.DB_META }, "gone");
    expect(res.errors).toEqual([]);
    expect(count("SELECT COUNT(*) AS c FROM hf_channel_tokens")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hf_reel_ig_media")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM hf_channels")).toBe(0);
  });
});

describe("reels import", () => {
  it("importChannelReels uses the official API for instagram-oauth channels and treg for bio-code ones", async () => {
    const { ch } = await connect();
    const treg = vi.fn(async () => []);
    await importChannelReels(env, ch, 50, { instagram: treg });
    expect(treg).not.toHaveBeenCalled();
    const bio = { ...ch, provider_ref: "treg" };
    await importChannelReels(env, bio, 50, { instagram: treg });
    expect(treg).toHaveBeenCalledTimes(1);
  });

  it("pages through paging.next and stops at the requested count", async () => {
    const { ch } = await connect();
    db.prepare("DELETE FROM hf_reels").run();
    const p1 = { data: [{ id: "a1", shortcode: "Caaaa11", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-20T10:00:00+0000" }], paging: { next: "https://graph.instagram.com/17841400000000099/media?after=XYZ&access_token=T" } };
    const p2 = { data: [{ id: "a2", shortcode: "Caaaa22", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-19T10:00:00+0000" }, { id: "a3", shortcode: "Caaaa33", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-18T10:00:00+0000" }] };
    let n = 0;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(n++ === 0 ? p1 : p2), { status: 200 }));
    const out = await importChannelReels(env, ch, 2);
    expect(out).toMatchObject({ fetched: 2, inserted: 2 });
  });
});
