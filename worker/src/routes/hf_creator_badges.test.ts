// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-CREATOR-BADGES-1] stacked badges: badge matrix, ONE go-live rule, space switch, "who can call you" gate (call / booking / queue),
// selfie approval re-running the go-live sync, kyc=1 filters, public callerLevel + channelVerified.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
const events: { event: string; props: any }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({ track: async () => {}, trackUser: async (_e: any, _u: any, _m: any, event: string, _a: any, props: any) => { events.push({ event, props }); }, trackException: async () => {} }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }), isFail: (u: any) => !!u?.error }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/identity", () => ({ emailFor: async () => null }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => "+910000000000" }));
vi.mock("../lib/hf_notify", () => ({ notifyHostOnline: async () => {} }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin" }));
vi.mock("../lib/hf_age_eligibility", () => ({ requireHfAgeConfirmation: async () => null }));
vi.mock("../lib/hf_queue_store", () => ({
  readQueueCfg: async () => ({ enabled: true }),
  loadHostBySlug: async () => ({ uid: "host1", status: "live" }),
  pokeLine: async () => ({ ok: true, entryId: "e1", position: 1, waiting: 1 }),
  myQueueEntry: async () => null,
}));

import { hfSpacesRoute } from "./hf_spaces";
import { hfCallsRoute } from "./hf_calls";
import { hfQueueRoute } from "./hf_queue";
import { hfHostKycRoute } from "./hf_host_kyc";
import { laneGuardSql } from "./hf_bookings";
import { syncHostState } from "./hf_channels";
import { creatorPublicationBlockers } from "../lib/hf_creator_publication";
import { canGoLive, goLiveBlockers, creatorBadges, effectiveCallerLevel, spaceOfHost, callerKycBlocked, channelVerifiedSql } from "../lib/hf_spaces";
import { parseHostList, buildWhere, listCacheKey } from "../lib/hf_hosts_list";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any;
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, slug TEXT, price_per_min INTEGER NOT NULL DEFAULT 20, category TEXT NOT NULL DEFAULT 'standard',
      presence TEXT, presence_at INTEGER, women_lane INTEGER NOT NULL DEFAULT 0, lgbtq_lane INTEGER NOT NULL DEFAULT 0, lgbtq_public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_kyc (uid TEXT PRIMARY KEY, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_selfie (id TEXT PRIMARY KEY, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT, reviewed_by TEXT, reviewed_at INTEGER);
    CREATE TABLE hf_lane_access (uid TEXT NOT NULL, lane TEXT NOT NULL, verified_at INTEGER NOT NULL, declared_at INTEGER, PRIMARY KEY (uid, lane));
    CREATE TABLE contact_verification (uid TEXT PRIMARY KEY, phone_verified INTEGER, phone_hash TEXT);
    CREATE TABLE phone_otp (uid TEXT, phone_hash TEXT, status TEXT);
    CREATE TABLE hf_age_confirm (uid TEXT PRIMARY KEY, confirmed_at INTEGER);
    CREATE TABLE hf_exit_requests (uid TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, caption TEXT, transcript_json TEXT, sort INTEGER, status TEXT, job_id TEXT, created_at INTEGER);
    CREATE TABLE admin_audit (id TEXT PRIMARY KEY, admin_id TEXT, action TEXT, target TEXT, meta TEXT, created_at INTEGER);
  `);
  db.exec(mig("2026-10-19-hf-channels.sql")); db.exec(mig("hf_creator_spaces.sql")); db.exec(mig("hf_creator_badges.sql"));
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  env = { DB_META: { prepare: (q: string) => stmt(q) }, DB_WALLET: { prepare: (q: string) => stmt(q) }, HF_CALL_DID: "x", VOBIZ_AUTH_ID: "x", VOBIZ_AUTH_TOKEN: "x", VOBIZ_WEBHOOK_SECRET: "x" };
}
const whatsapp = (uid = "u1") => db.exec(`INSERT OR REPLACE INTO contact_verification VALUES ('${uid}',1,'h${uid}'); INSERT INTO phone_otp VALUES ('${uid}','h${uid}','verified')`);
const aadhaar = (gender: string, uid = "u1") => db.prepare("INSERT OR REPLACE INTO hf_kyc VALUES (?,?,1)").run(uid, gender);
const selfie = (status: string, uid = "u1", at = 1) => db.prepare("INSERT INTO hf_selfie (id, uid, created_at, review_status) VALUES (?,?,?,?)").run(`s${Math.random()}`, uid, at, status);
const channel = (uid = "u1") => db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, created_at) VALUES (?,?,?,?,?,?,?)").run(`c${Math.random()}`, uid, "youtube", "@x", 500, "approved", 1);
const host = (uid: string, o = "") => db.exec(`INSERT INTO hf_hosts (uid, status, slug, display_name, presence, presence_at ${o ? "," + o.split("|")[0] : ""}) VALUES ('${uid}', 'pending_check', 's-${uid}', 'N', 'online', 1 ${o ? "," + o.split("|")[1] : ""})`);
const req = (method: string, path: string, uid: string, body?: unknown) =>
  new Request(`https://x${path}`, { method, headers: { "x-test-uid": uid, "content-type": "application/json", "idempotency-key": "k" }, body: body === undefined ? undefined : JSON.stringify(body) });
const spaces = (path: string, body: unknown, uid = "u1") => hfSpacesRoute(req("POST", `/api/hf/spaces/${path}`, uid, body), env, `/api/hf/spaces/${path}`);
const me = async (uid = "u1") => (await hfSpacesRoute(req("GET", "/api/hf/spaces/me", uid), env, "/api/hf/spaces/me")).json();
const status = (uid = "u1") => db.prepare("SELECT status FROM hf_hosts WHERE uid=?").get(uid)?.status;

beforeEach(() => { makeEnv(); cfg = { hfCreatorSpacesEnabled: true, hfCallsEnabled: true, hostKycEnabled: true, hfInfluencerMinFollowers: 20, hfInfluencerMinViews: 1000 }; events.length = 0; });

describe("go-live rule (pure)", () => {
  const f = (o = {}) => ({ channel: false, videoKyc: false, space: null, spaceQualified: true, ...o });
  it("approved channel OR video KYC; a space also needs its qualification", () => {
    expect(canGoLive(f())).toEqual({ ok: false, missing: ["channel_or_video_kyc"] });
    expect(canGoLive(f({ channel: true })).ok).toBe(true);
    expect(canGoLive(f({ videoKyc: true })).ok).toBe(true);
    expect(canGoLive(f({ channel: true, space: "women", spaceQualified: false }))).toEqual({ ok: false, missing: ["space_video_kyc"] });
    expect(canGoLive(f({ videoKyc: true, space: "lgbtq", spaceQualified: true })).ok).toBe(true);
    expect(canGoLive(f({ space: "women", spaceQualified: false })).missing).toEqual(["channel_or_video_kyc", "space_video_kyc"]);
  });
  it("blocker codes: verification_required / video_kyc_required", () => {
    expect(goLiveBlockers(f())).toEqual(["verification_required"]);
    expect(goLiveBlockers(f({ channel: true, space: "women", spaceQualified: false }))).toEqual(["video_kyc_required"]);
    expect(goLiveBlockers(f(), { requireBasis: false })).toEqual([]);
  });
  it("space is derived from the lanes (creator_kind is legacy); space hosts are always video_kyc", () => {
    expect(spaceOfHost({ women_lane: 1, creator_kind: "channel" })).toBe("women");
    expect(spaceOfHost({ lgbtq_lane: 1 })).toBe("lgbtq");
    expect(spaceOfHost({ creator_kind: "lgbtq" })).toBe("lgbtq");
    expect(spaceOfHost({ creator_kind: "channel" })).toBeNull();
    expect(effectiveCallerLevel({ women_lane: 1, caller_level: "everyone" })).toBe("video_kyc");
    expect(effectiveCallerLevel({ caller_level: "video_kyc" })).toBe("video_kyc");
    expect(effectiveCallerLevel({})).toBe("everyone");
  });
});

describe("badge matrix (DB)", () => {
  it("phone / channel / video KYC / space stack independently", async () => {
    host("u1");
    expect((await creatorBadges(env, "u1")).badges).toEqual({ phone: false, channel: false, videoKyc: false, space: null });
    whatsapp(); aadhaar("M"); selfie("approved");
    let b = await creatorBadges(env, "u1");
    expect(b.badges).toEqual({ phone: true, channel: false, videoKyc: true, space: null });
    expect(b.canGoLive).toBe(true);
    channel();
    b = await creatorBadges(env, "u1");
    expect(b.badges.channel).toBe(true);
    db.exec("UPDATE hf_hosts SET women_lane=1 WHERE uid='u1'");
    b = await creatorBadges(env, "u1");
    expect(b.badges.space).toBe("women");
    expect(b.canGoLive).toBe(false); // Aadhaar M cannot qualify for women
    expect(b.missing).toEqual(["space_video_kyc"]);
  });
  it("a latest PENDING selfie removes the video KYC badge", async () => {
    host("u1"); aadhaar("F"); selfie("approved", "u1", 1); selfie("pending", "u1", 2);
    expect((await creatorBadges(env, "u1")).badges.videoKyc).toBe(false);
  });
  it("publication blockers: verification_required without channel or video KYC, gone with either", async () => {
    host("u1", "category|'influencer'");
    expect(await creatorPublicationBlockers(env, "u1")).toContain("verification_required");
    channel();
    expect(await creatorPublicationBlockers(env, "u1")).not.toContain("verification_required");
    db.exec("DELETE FROM hf_channels"); aadhaar("F"); selfie("approved");
    expect(await creatorPublicationBlockers(env, "u1")).not.toContain("verification_required");
    db.exec("UPDATE hf_hosts SET women_lane=0, lgbtq_lane=1 WHERE uid='u1'");
    expect(await creatorPublicationBlockers(env, "u1")).toContain("video_kyc_required"); // F, not declared
    expect(await creatorPublicationBlockers(env, "u1")).not.toContain("verification_required");
  });
});

describe("syncHostState and the selfie review [HF-INFLUENCER-GATE-1: read-only, nobody is promoted or demoted]", () => {
  it("never changes a host's status: not a promotion, not a demotion", async () => {
    host("u1"); db.exec("UPDATE hf_hosts SET status='draft'"); aadhaar("F"); selfie("approved");
    expect((await syncHostState(env, "u1")).hostStatus).toBe("draft");
    db.exec("DELETE FROM hf_selfie");
    expect((await syncHostState(env, "u1")).hostStatus).toBe("draft");
    db.exec("UPDATE hf_hosts SET status='live'");
    expect((await syncHostState(env, "u1")).hostStatus).toBe("live");
  });
  it("a video-KYC selfie approval does NOT make her an influencer; a later rejection changes nothing", async () => {
    host("u1"); db.exec("UPDATE hf_hosts SET status='draft'"); aadhaar("F"); whatsapp();
    const id = "sv1";
    db.prepare("INSERT INTO hf_selfie (id, uid, created_at, review_status) VALUES (?,?,?,'pending')").run(id, "u1", 5);
    const ok = await hfHostKycRoute(req("POST", "/api/admin/hf/kyc/u1/selfie", "admin", { decision: "approve" }), env, "/api/admin/hf/kyc/u1/selfie");
    expect(ok.status).toBe(200);
    expect(status()).toBe("draft");
    expect(events.some((e) => e.event === "hf_verify_badge_added" && e.props.badge === "video_kyc")).toBe(true);
    db.prepare("INSERT INTO hf_selfie (id, uid, created_at, review_status) VALUES ('sv2','u1',9,'pending')").run();
    const no = await hfHostKycRoute(req("POST", "/api/admin/hf/kyc/u1/selfie", "admin", { decision: "reject", reason: "blurry" }), env, "/api/admin/hf/kyc/u1/selfie");
    expect(no.status).toBe(200);
    expect(status()).toBe("draft");
  });
  it("a customer with no host row is untouched by the sync (no host row is created)", async () => {
    aadhaar("F", "cust"); db.prepare("INSERT INTO hf_selfie (id, uid, created_at, review_status) VALUES ('c1','cust',1,'pending')").run();
    const r = await hfHostKycRoute(req("POST", "/api/admin/hf/kyc/cust/selfie", "admin", { decision: "approve" }), env, "/api/admin/hf/kyc/cust/selfie");
    expect(r.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM hf_hosts").get().n).toBe(0);
  });
  it("a space creator with a channel but no space qualification still reports qualified:false, and never changes status", async () => {
    host("u1", "women_lane|1"); db.exec("UPDATE hf_hosts SET status='draft'"); channel();
    expect(await syncHostState(env, "u1")).toMatchObject({ hostStatus: "draft", qualified: false });
    aadhaar("F"); whatsapp(); selfie("approved");
    expect(await syncHostState(env, "u1")).toMatchObject({ hostStatus: "draft", qualified: true });
  });
});

describe("GET /api/hf/spaces/me + space switch + caller level", () => {
  it("reports badges, canGoLive, missing, callerLevel", async () => {
    host("u1"); whatsapp(); aadhaar("F"); selfie("approved");
    const b = await me();
    expect(b).toMatchObject({ badges: { phone: true, channel: false, videoKyc: true, space: null }, canGoLive: true, missing: [], callerLevel: "everyone", callerLevelLocked: false, kind: "channel", qualified: true });
  });
  it("one space at a time: joining lgbtq clears women; null leaves; events carry no gender", async () => {
    whatsapp(); aadhaar("F"); selfie("approved");
    expect((await spaces("space", { space: "women" })).status).toBe(200);
    expect(db.prepare("SELECT women_lane, lgbtq_lane FROM hf_hosts").get()).toMatchObject({ women_lane: 1, lgbtq_lane: 0 });
    expect((await spaces("space", { space: "lgbtq", declare: true, acceptTerms: true, publicTagConsent: true })).status).toBe(200);
    expect(db.prepare("SELECT women_lane, lgbtq_lane, lgbtq_public, creator_kind FROM hf_hosts").get()).toMatchObject({ women_lane: 0, lgbtq_lane: 1, lgbtq_public: 1, creator_kind: "lgbtq" });
    expect((await me()).badges.space).toBe("lgbtq");
    expect((await spaces("space", { space: null })).status).toBe(200);
    expect(db.prepare("SELECT women_lane, lgbtq_lane, lgbtq_public, creator_kind FROM hf_hosts").get()).toMatchObject({ women_lane: 0, lgbtq_lane: 0, lgbtq_public: 0, creator_kind: "channel" });
    const names = events.map((e) => e.event);
    expect(names).toContain("hf_space_joined"); expect(names).toContain("hf_space_left");
    expect(JSON.stringify(events)).not.toMatch(/gender|declare/i);
    expect((await spaces("space", { space: "bogus" })).status).toBe(400);
  });
  it("same eligibility errors as /creator: women with Aadhaar M is 403, lgbtq without consent is 400", async () => {
    aadhaar("M");
    const w = await spaces("space", { space: "women" });
    expect(w.status).toBe(403); expect((await w.json()).error).toBe("not_eligible");
    const l = await spaces("space", { space: "lgbtq", declare: true, acceptTerms: true });
    expect(l.status).toBe(400); expect((await l.json()).error).toBe("consent_required");
  });
  it("an already live host cannot join a space before her video KYC (409 video_kyc_required)", async () => {
    host("u1"); db.exec("UPDATE hf_hosts SET status='live'"); aadhaar("F");
    const r = await spaces("space", { space: "women" });
    expect(r.status).toBe(409); expect((await r.json()).error).toBe("video_kyc_required");
  });
  it("/creator still works: channel = no space, women = join", async () => {
    whatsapp(); aadhaar("F"); selfie("approved");
    expect((await spaces("creator", { kind: "women" })).status).toBe(200);
    expect((await me()).badges.space).toBe("women");
    expect((await spaces("creator", { kind: "channel" })).status).toBe(200);
    expect((await me()).badges.space).toBeNull();
  });
  it("caller-level: set + read back + telemetry; invalid is 400; space creators are locked (409 space_locked)", async () => {
    const r = await spaces("caller-level", { level: "video_kyc" });
    expect(await r.json()).toEqual({ ok: true, callerLevel: "video_kyc" });
    expect((await me()).callerLevel).toBe("video_kyc");
    expect(events.find((e) => e.event === "hf_caller_level_set")?.props.level).toBe("video_kyc");
    expect((await spaces("caller-level", { level: "everyone" })).status).toBe(200);
    expect((await me()).callerLevel).toBe("everyone");
    expect((await spaces("caller-level", { level: "nope" })).status).toBe(400);
    whatsapp(); aadhaar("F"); selfie("approved");
    await spaces("space", { space: "women" });
    const locked = await spaces("caller-level", { level: "everyone" });
    expect(locked.status).toBe(409); expect((await locked.json()).error).toBe("space_locked");
    expect(await me()).toMatchObject({ callerLevel: "video_kyc", callerLevelLocked: true });
  });
});

describe("caller-level gate", () => {
  beforeEach(() => {
    db.prepare("INSERT INTO hf_age_confirm VALUES ('cust',1)").run();
    db.exec(`INSERT INTO hf_hosts (uid, slug, display_name, price_per_min, presence, presence_at, status) VALUES ('host1','asha-k','Asha',10,'online',1,'live')`);
  });
  const call = (uid = "cust") => hfCallsRoute(req("POST", "/api/hf/calls", uid, { hostSlug: "asha-k" }), env, "/api/hf/calls");
  const queue = (uid = "cust") => hfQueueRoute(req("POST", "/api/hf/hosts/asha-k/queue", uid), env);
  it("callerKycBlocked: everyone-hosts never block; video_kyc hosts block unless the caller is video-KYC verified", async () => {
    expect(await callerKycBlocked(env, "cust", { caller_level: "everyone" })).toBe(false);
    expect(await callerKycBlocked(env, "cust", { caller_level: "video_kyc" })).toBe(true);
    aadhaar("M", "cust"); selfie("pending", "cust");
    expect(await callerKycBlocked(env, "cust", { caller_level: "video_kyc" })).toBe(true);
    selfie("approved", "cust", 9);
    expect(await callerKycBlocked(env, "cust", { caller_level: "video_kyc" })).toBe(false);
  });
  it("call start: video_kyc host -> 403 video_kyc_required_caller {level}; everyone host is not stopped by it", async () => {
    db.exec("UPDATE hf_hosts SET caller_level='video_kyc'");
    const r = await call();
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "video_kyc_required_caller", level: "video_kyc" });
    db.exec("UPDATE hf_hosts SET caller_level='everyone'");
    expect((await (await call()).json()).error).not.toBe("video_kyc_required_caller");
  });
  it("call start: a video-KYC caller passes the gate", async () => {
    db.exec("UPDATE hf_hosts SET caller_level='video_kyc'"); aadhaar("M", "cust"); selfie("approved", "cust");
    expect((await (await call()).json()).error).not.toBe("video_kyc_required_caller");
  });
  it("space hosts keep lane_required (not the new code)", async () => {
    db.exec("UPDATE hf_hosts SET women_lane=1");
    expect((await (await call()).json()).error).toBe("lane_required");
  });
  it("queue join: 403 video_kyc_required_caller for a plain customer, joins for a video-KYC one; everyone hosts join", async () => {
    db.exec("UPDATE hf_hosts SET caller_level='video_kyc'");
    const r = await queue();
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "video_kyc_required_caller", level: "video_kyc" });
    aadhaar("M", "cust"); selfie("approved", "cust");
    expect((await queue()).status).toBe(200);
    db.exec("DELETE FROM hf_selfie; UPDATE hf_hosts SET caller_level='everyone'");
    expect((await queue()).status).toBe(200);
  });
  it("booking atomic SQL guard: video_kyc host needs the customer's video KYC; everyone host does not", () => {
    const sql = (c: string, h: string) => db.prepare(`SELECT ${laneGuardSql(1, 2, null)} AS ok`).get(c, h).ok;
    expect(sql("cust", "host1")).toBe(1);
    db.exec("UPDATE hf_hosts SET caller_level='video_kyc'");
    expect(sql("cust", "host1")).toBe(0);
    aadhaar("M", "cust"); selfie("pending", "cust");
    expect(sql("cust", "host1")).toBe(0);
    selfie("approved", "cust", 9);
    expect(sql("cust", "host1")).toBe(1);
  });
});

describe("kyc=1 filter and public flags", () => {
  it("parseHostList + buildWhere + cache key carry kyc", () => {
    const off = parseHostList(new URLSearchParams("")); const on = parseHostList(new URLSearchParams("kyc=1"));
    expect(off.ok && on.ok).toBe(true);
    expect(off.q.kyc).toBeUndefined(); expect(on.q.kyc).toBe(true);
    expect(listCacheKey(on.q)).toContain("kyc=1"); expect(listCacheKey(on.q)).not.toBe(listCacheKey(off.q));
    expect(buildWhere(on.q).where).toContain("hf_kyc"); expect(buildWhere(off.q).where).not.toContain("hf_kyc");
  });
  it("the SQL keeps only video-KYC-verified hosts, and channelVerifiedSql flags approved channels", () => {
    db.exec(`INSERT INTO hf_hosts (uid, slug, status) VALUES ('a','a-x','live'),('b','b-x','live'),('c','c-x','live')`);
    aadhaar("F", "a"); selfie("approved", "a"); aadhaar("F", "b"); selfie("pending", "b"); channel("c");
    const q = parseHostList(new URLSearchParams("kyc=1")).q;
    const rows = db.prepare(`SELECT h.uid, ${channelVerifiedSql("h.uid")} AS cv FROM hf_hosts h WHERE ${buildWhere(q).where}`).all(...buildWhere(q).binds);
    expect(rows.map((r) => r.uid)).toEqual(["a"]);
    expect(db.prepare(`SELECT ${channelVerifiedSql("'c'")} AS cv`).get().cv).toBe(1);
    expect(db.prepare(`SELECT ${channelVerifiedSql("'a'")} AS cv`).get().cv).toBe(0);
  });
});
