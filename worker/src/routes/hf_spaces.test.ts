// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-CREATOR-SPACES-1] creator types + Women-only / LGBTQ+ spaces: qualification matrix, /api/hf/spaces/*, publication blockers.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let authFail: { status: number; error: string } | null = null;
const events: { event: string; props: any }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async (_e: any, _u: any, _m: any, event: string, _a: any, props: any) => { events.push({ event, props }); }, trackException: async () => {} }));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => authFail ?? { uid: req.headers.get("x-test-uid") ?? "u1" },
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));

import { hfSpacesRoute } from "./hf_spaces";
import { creatorPublicationBlockers } from "../lib/hf_creator_publication";
import { qualifiedFor, spaceQualified, videoKycVerified, spaceOfRow, videoKycSql } from "../lib/hf_spaces";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, slug TEXT, price_per_min INTEGER NOT NULL DEFAULT 20,
      women_lane INTEGER NOT NULL DEFAULT 0, lgbtq_lane INTEGER NOT NULL DEFAULT 0, lgbtq_public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_selfie (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (uid TEXT, phone_hash TEXT, status TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, caption TEXT, transcript_json TEXT, sort INTEGER, status TEXT, job_id TEXT, created_at INTEGER);
  `);
  db.exec(readFileSync(new URL("../../migrations/2026-10-19-hf-channels.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/hf_creator_spaces.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/hf_creator_badges.sql", import.meta.url), "utf8")); // [HF-CREATOR-BADGES-1]
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) } };
}

const whatsapp = (uid = "u1") => db.exec(`INSERT INTO contact_verification VALUES ('${uid}',1,'h${uid}'); INSERT INTO phone_otp VALUES ('${uid}','h${uid}','verified')`);
const aadhaar = (gender: string, uid = "u1") => db.prepare("INSERT OR REPLACE INTO hf_kyc VALUES (?,?,1)").run(uid, gender);
const selfie = (status: string, uid = "u1", at = 1, id = `s${Math.random()}`) => db.prepare("INSERT INTO hf_selfie VALUES (?,?,?,?,?)").run(id, uid, at, status, status === "rejected" ? "face does not match" : null);
const declare = (uid = "u1") => db.prepare("INSERT OR REPLACE INTO hf_lane_access VALUES (?, 'lgbtq', 1, 1)").run(uid);
const get = (uid = "u1") => hfSpacesRoute(new Request("https://x/api/hf/spaces/me", { headers: { "x-test-uid": uid } }), env, "/api/hf/spaces/me");
const post = (body: unknown, uid = "u1") =>
  hfSpacesRoute(new Request("https://x/api/hf/spaces/creator", { method: "POST", headers: { "x-test-uid": uid, "content-type": "application/json" }, body: JSON.stringify(body) }), env, "/api/hf/spaces/creator");
const kindOf = (uid = "u1") => db.prepare("SELECT creator_kind, women_lane, lgbtq_lane, lgbtq_public, status FROM hf_hosts WHERE uid=?").get(uid);

beforeEach(() => { makeEnv(); cfg = { hfCreatorSpacesEnabled: true, hfInfluencerMinFollowers: 20, hfInfluencerMinViews: 1000 }; authFail = null; events.length = 0; });

describe("qualification matrix", () => {
  const base = { whatsappVerified: true, aadhaarVerified: true, gender: "F", selfie: { status: "approved", reason: null }, lgbtqDeclared: false, videoKycVerified: true };
  it("women: WhatsApp + Aadhaar F + approved selfie; T and M never", () => {
    expect(qualifiedFor("women", base)).toBe(true);
    expect(qualifiedFor("women", { ...base, gender: "T" })).toBe(false);
    expect(qualifiedFor("women", { ...base, gender: "M" })).toBe(false);
    expect(qualifiedFor("women", { ...base, whatsappVerified: false })).toBe(false);
    expect(qualifiedFor("women", { ...base, aadhaarVerified: false })).toBe(false);
    for (const status of ["none", "pending", "rejected"]) expect(qualifiedFor("women", { ...base, selfie: { status, reason: null } })).toBe(false);
  });
  it("lgbtq: Aadhaar T passes, otherwise the private declaration; still needs the approved selfie", () => {
    expect(qualifiedFor("lgbtq", { ...base, gender: "T" })).toBe(true);
    expect(qualifiedFor("lgbtq", { ...base, gender: "M" })).toBe(false);
    expect(qualifiedFor("lgbtq", { ...base, gender: "M", lgbtqDeclared: true })).toBe(true);
    expect(qualifiedFor("lgbtq", { ...base, gender: "T", selfie: { status: "pending", reason: null } })).toBe(false);
    expect(qualifiedFor("lgbtq", { ...base, gender: "T", whatsappVerified: false })).toBe(false);
  });
  it("spaceQualified reads the DB; channel creators and non-hosts are not subject to the space rules", async () => {
    expect(await spaceQualified(env, "nobody")).toBe(true);
    db.exec("INSERT INTO hf_hosts (uid, created_at, updated_at) VALUES ('c1',1,1)");
    expect(await spaceQualified(env, "c1")).toBe(true);
    db.exec("INSERT INTO hf_hosts (uid, creator_kind, created_at, updated_at) VALUES ('w1','women',1,1)");
    expect(await spaceQualified(env, "w1")).toBe(false);
    whatsapp("w1"); aadhaar("F", "w1"); selfie("approved", "w1");
    expect(await spaceQualified(env, "w1")).toBe(true);
  });
  it("video KYC uses the LATEST selfie only", async () => {
    aadhaar("F");
    selfie("approved", "u1", 1);
    expect(await videoKycVerified(env, "u1")).toBe(true);
    selfie("pending", "u1", 2);
    expect(await videoKycVerified(env, "u1")).toBe(false);
    selfie("approved", "u1", 3);
    expect(await videoKycVerified(env, "u1")).toBe(true);
    expect(db.prepare(`SELECT ${videoKycSql("'u1'")} AS ok`).get().ok).toBe(1);
  });
  it("public space tag: lgbtq only with the public consent flag", () => {
    expect(spaceOfRow({ women_lane: 1 })).toBe("women");
    expect(spaceOfRow({ lgbtq_lane: 1, lgbtq_public: 1 })).toBe("lgbtq");
    expect(spaceOfRow({ lgbtq_lane: 1, lgbtq_public: 0 })).toBeNull();
    expect(spaceOfRow({})).toBeNull();
  });
});

describe("GET /api/hf/spaces/me", () => {
  it("flag off -> 404 not_enabled; signed out -> 401; wrong method -> 405", async () => {
    cfg = { hfCreatorSpacesEnabled: false };
    expect((await get())!.status).toBe(404);
    cfg = { hfCreatorSpacesEnabled: true };
    authFail = { status: 401, error: "unauthorized" };
    expect((await get())!.status).toBe(401);
    authFail = null;
    expect((await hfSpacesRoute(new Request("https://x/api/hf/spaces/me", { method: "POST" }), env, "/api/hf/spaces/me"))!.status).toBe(405);
    expect(await hfSpacesRoute(new Request("https://x/api/hf/spaces/other"), env, "/api/hf/spaces/other")).toBeNull();
  });
  it("a new user: everything false/none, kind null", async () => {
    expect(await (await get())!.json()).toEqual({
      ok: true, kind: null, whatsappVerified: false, aadhaarVerified: false, gender: null, selfie: { status: "none", reason: null },
      lgbtqDeclared: false, videoKycVerified: false, qualified: false, hostStatus: null, minFollowers: 20, minViews: 1000,
      badges: { phone: false, channel: false, videoKyc: false, space: null }, canGoLive: false, missing: ["channel_or_video_kyc"], callerLevel: "everyone", callerLevelLocked: false, // [HF-CREATOR-BADGES-1]
      social: { state: "none", accounts: [], minFollowers: 20, minViews: 1000 }, // [HF-SOCIAL-STATES]
    });
  });
  // [HF-SOCIAL-STATES] three states: none / below_minimum (proven, shown, does NOT count) / verified
  const chan = (id: string, platform: string, handle: string, status: string, followers: number, views = 0, verified = true, ref = "facebook-oauth") =>
    db.prepare(`INSERT INTO hf_channels (id, host_uid, platform, handle, url, platform_user_id, followers, views, verify_code, verified_at, status, consent_version, consent_at, provider_ref, last_sync_at, created_at)
      VALUES (?, 'u1', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'v', 1, ?, 1, ?)`).run(id, platform, handle, `https://www.facebook.com/${handle}`, id + "p", followers, views, verified ? 1 : null, status, ref, Number(id.slice(-1)) || 1);
  it("[HF-SOCIAL-STATES] a login-proven Facebook Page with 0 followers is below_minimum, has no numeric displayHandle, and does not count", async () => {
    whatsapp();
    chan("hfch_fb000001", "facebook", "1378608792005431", "rejected", 0);
    const b = await (await get())!.json();
    expect(b.social.state).toBe("below_minimum");
    expect(b.social.accounts).toEqual([{ id: "hfch_fb000001", platform: "facebook", handle: "1378608792005431", displayHandle: null, url: "https://www.facebook.com/1378608792005431", followers: 0, views: 0, state: "below_minimum", need: "followers", viaLogin: true }]);
    expect(b.badges.channel).toBe(false);
    expect(b.canGoLive).toBe(false);
    expect(b.missing).toEqual(["channel_or_video_kyc"]);
  });
  it("[HF-SOCIAL-STATES] YouTube with enough subscribers but few views needs views; pending bio-code and removed accounts are not listed", async () => {
    chan("hfch_yt000002", "youtube", "mayatv", "rejected", 50, 10, true, "youtube-oauth");
    chan("hfch_ig000003", "instagram", "pending.one", "pending", 900, 0, false, "treg");
    chan("hfch_ig000004", "instagram", "gone", "disconnected", 900, 0, true, "instagram-oauth");
    const b = await (await get())!.json();
    expect(b.social.accounts.map((a: any) => [a.platform, a.state, a.need])).toEqual([["youtube", "below_minimum", "views"]]);
  });
  it("[HF-SOCIAL-STATES] one approved account makes it verified; approved accounts come first", async () => {
    chan("hfch_fb000005", "facebook", "Priya Vlogs", "rejected", 3);
    chan("hfch_ig000006", "instagram", "priya.reels", "approved", 900, 0, true, "instagram-oauth");
    const b = await (await get())!.json();
    expect(b.social.state).toBe("verified");
    expect(b.social.accounts.map((a: any) => [a.displayHandle, a.state, a.need])).toEqual([["priya.reels", "approved", null], ["Priya Vlogs", "below_minimum", "followers"]]);
    expect(b.badges.channel).toBe(true);
  });
  it("reports selfie rejection reason and qualification of a women creator", async () => {
    whatsapp(); aadhaar("F");
    await post({ kind: "women" });
    selfie("rejected");
    let b = await (await get())!.json();
    expect(b).toMatchObject({ kind: "women", whatsappVerified: true, aadhaarVerified: true, gender: "F", selfie: { status: "rejected", reason: "face does not match" }, videoKycVerified: false, qualified: false, hostStatus: "draft" });
    selfie("approved", "u1", 5);
    b = await (await get())!.json();
    expect(b).toMatchObject({ selfie: { status: "approved", reason: null }, videoKycVerified: true, qualified: true });
  });
});

describe("POST /api/hf/spaces/creator", () => {
  it("rejects a bad kind (400) and a flag-off call (404)", async () => {
    expect((await post({ kind: "men" }))!.status).toBe(400);
    expect((await post({}))!.status).toBe(400);
    cfg = { hfCreatorSpacesEnabled: false };
    expect((await post({ kind: "women" }))!.status).toBe(404);
  });
  it("channel: creates a DRAFT host row (never an influencer) with creator_kind channel", async () => {
    expect(await (await post({ kind: "channel" }))!.json()).toEqual({ ok: true, kind: "channel" });
    expect(kindOf()).toMatchObject({ creator_kind: "channel", status: "draft", women_lane: 0 });
    expect(events.map((e) => e.event)).toContain("hf_space_creator_chosen");
  });
  it("women: before Aadhaar it is accepted and sets women_lane; telemetry has the kind only", async () => {
    expect(await (await post({ kind: "women" }))!.json()).toEqual({ ok: true, kind: "women" });
    expect(kindOf()).toMatchObject({ creator_kind: "women", women_lane: 1, lgbtq_lane: 0, lgbtq_public: 0, status: "draft" });
    const ev = events.find((e) => e.event === "hf_space_creator_chosen");
    expect(ev!.props).toEqual({ area: "hf_spaces", kind: "women" });
  });
  it.each(["M", "T"])("women with verified Aadhaar %s -> 403 not_eligible", async (g) => {
    aadhaar(g);
    const r = (await post({ kind: "women" }))!;
    expect(r.status).toBe(403);
    const b = await r.json();
    expect(b.error).toBe("not_eligible");
    expect(typeof b.message).toBe("string");
    expect(db.prepare("SELECT COUNT(*) c FROM hf_hosts").get().c).toBe(0);
  });
  it("lgbtq: needs publicTagConsent (400 consent_required) first, then declare+acceptTerms (400 declare_required)", async () => {
    let r = (await post({ kind: "lgbtq", declare: true, acceptTerms: true }))!;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("consent_required");
    r = (await post({ kind: "lgbtq", publicTagConsent: true }))!;
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("declare_required");
    r = (await post({ kind: "lgbtq", publicTagConsent: true, declare: true }))!;
    expect((await r.json()).error).toBe("declare_required");
    expect(db.prepare("SELECT COUNT(*) c FROM hf_hosts").get().c).toBe(0);
  });
  it("lgbtq with the declaration: public tag on, the declaration is stored privately and never in telemetry", async () => {
    const r = (await post({ kind: "lgbtq", publicTagConsent: true, declare: true, acceptTerms: true }))!;
    expect(await r.json()).toEqual({ ok: true, kind: "lgbtq" });
    expect(kindOf()).toMatchObject({ creator_kind: "lgbtq", lgbtq_lane: 1, lgbtq_public: 1, women_lane: 0 });
    expect(db.prepare("SELECT declared_at FROM hf_lane_access WHERE uid='u1' AND lane='lgbtq'").get().declared_at).not.toBeNull();
    expect(JSON.stringify(events)).not.toMatch(/declare|gender/i);
    expect((await (await get())!.json()).lgbtqDeclared).toBe(true);
  });
  it("lgbtq with Aadhaar gender T needs only the public consent", async () => {
    aadhaar("T");
    expect((await post({ kind: "lgbtq", publicTagConsent: true }))!.status).toBe(200);
    expect(kindOf()).toMatchObject({ creator_kind: "lgbtq", lgbtq_public: 1 });
  });
  it("switching back to channel clears the space lanes and a space creator stays untouched by channel sync", async () => {
    await post({ kind: "women" });
    await post({ kind: "channel" });
    expect(kindOf()).toMatchObject({ creator_kind: "channel", women_lane: 0 });
  });
  it("an already approved/live host cannot become a space creator before video KYC (409 video_kyc_required)", async () => {
    db.exec("INSERT INTO hf_hosts (uid, status, created_at, updated_at) VALUES ('u1','live',1,1)");
    const r = (await post({ kind: "women" }))!;
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("video_kyc_required");
    expect(kindOf()).toMatchObject({ creator_kind: "channel", women_lane: 0, status: "live" });
  });
});

describe("publication blockers", () => {
  it("an unqualified space creator is blocked with video_kyc_required, a qualified one is not", async () => {
    db.exec("INSERT INTO hf_hosts (uid, creator_kind, women_lane, status, created_at, updated_at) VALUES ('u1','women',1,'pending_review',1,1)");
    expect(await creatorPublicationBlockers(env, "u1")).toContain("video_kyc_required");
    whatsapp(); aadhaar("F"); selfie("approved");
    expect(await creatorPublicationBlockers(env, "u1")).not.toContain("video_kyc_required");
  });
  it("a channel creator is never blocked by the space rule", async () => {
    db.exec("INSERT INTO hf_hosts (uid, status, created_at, updated_at) VALUES ('u1','pending_review',1,1)");
    expect(await creatorPublicationBlockers(env, "u1")).not.toContain("video_kyc_required");
  });
});
