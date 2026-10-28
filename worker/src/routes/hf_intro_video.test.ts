// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for
// [HF-INTRO-W1] HF-INTRO-VIDEO-1: recorded intro upload validation, submission rules (Aadhaar / sensitive / women F), admin approve + reject + WhatsApp,
// reels feed filtering (option A always, B only Online, unapproved / legacy hidden) and the engage hook (likes / comments accept hfin_ ids).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let cfg: Record<string, unknown> = {};
let phoneVerified = true;
const sent: { to: string; text: string }[] = [];
const events: { event: string; props: any }[] = [];
vi.mock("./config", () => ({ readConfig: async () => cfg }));
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _a: string, props: any) => { events.push({ event, props: { uid, ...props } }); }, trackException: async () => {},
  trackUser: async (_e: any, uid: string, email: any, event: string, _a: string, props: any) => { events.push({ event, props: { uid, email, ...props } }); },
}));
vi.mock("../authz", () => ({
  requireUser: async (req: Request) => ({ uid: req.headers.get("x-test-uid") ?? "u1" }),
  isFail: (u: any) => !!u?.error,
}));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../lib/identity", () => ({ emailFor: async (_e: any, uid: string) => `${uid}@test.dev` }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid.startsWith("admin") }));
vi.mock("../lib/whatsapp_send", () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { sent.push({ to, text }); return { ok: true }; } }));
vi.mock("../lib/whatsapp_notify", () => ({ verifiedWhatsAppNumber: async (_e: any, uid: string) => (uid === "nophone" ? null : "+9190000" + uid) }));
vi.mock("../lib/hf_push", () => ({ pushHostDecision: async () => true }));
vi.mock("../lib/hf_public_verification", async (orig) => ({ ...(await orig()), isPhoneVerified: async () => phoneVerified }));
vi.mock("../lib/hf_booking_store", () => ({ getHfBookingSchedule: async () => ({ timezone: "Asia/Kolkata", rules: [{ weekday: 1, startMin: 600, endMin: 900 }], exceptions: [] }) }));

import { hfIntroOnboardingRoute } from "./hf_intro_onboarding";
import { hfIntroAdminRoute } from "./hf_intro_admin";
import { hfReelsRoute, visibleReel } from "./hf_reels";
import { hfReelEngageRoute } from "./hf_reel_engage";
import { sweepIntroVideos } from "../lib/hf_intro_cleanup";
import { introSelfState } from "../lib/hf_intro_reels";
import { validateIntroVideo, submissionGate, rejectedMessage } from "../lib/hf_intro_video";
import { HF_CATEGORIES, isSensitiveCategory, normalizeCategories } from "../lib/hf_categories";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
let db: any, env: any, blobs: Map<string, any>;
const uploadedAt = new Map<string, Date>(); // [HF-INTRO-DELETE-1] object ages for the orphan check (default: very old)
const kv = new Map<string, string>();
const mig = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

function makeEnv() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE hf_hosts (uid TEXT PRIMARY KEY, slug TEXT, status TEXT NOT NULL DEFAULT 'draft', display_name TEXT, about TEXT, tagline TEXT, price_per_min INTEGER NOT NULL DEFAULT 0,
    category TEXT, presence TEXT NOT NULL DEFAULT 'offline', presence_at INTEGER, call_mode TEXT NOT NULL DEFAULT 'online', on_call_since INTEGER, presence_call_id TEXT, queue_paused INTEGER DEFAULT 0,
    avatar_id TEXT, women_lane INTEGER DEFAULT 0, lgbtq_lane INTEGER DEFAULT 0, lgbtq_public INTEGER DEFAULT 0, live_at INTEGER, review_note TEXT, reviewed_by TEXT, reviewed_at INTEGER,
    listing_revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hf_kyc (uid TEXT, gender TEXT, verified_at INTEGER);
    CREATE TABLE hf_selfie (id TEXT, uid TEXT, created_at INTEGER, review_status TEXT, review_reason TEXT);
    CREATE TABLE hf_avatars (id TEXT PRIMARY KEY, image_key TEXT);
    CREATE TABLE hf_host_media (id TEXT PRIMARY KEY, uid TEXT, kind TEXT, r2_key TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE hf_user_registration (uid TEXT PRIMARY KEY, username TEXT);
    CREATE TABLE users (uid TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT);`);
  db.exec(mig("2026-10-19-hf-channels.sql"));
  db.exec("ALTER TABLE hf_channels ADD COLUMN views INTEGER NOT NULL DEFAULT 0"); // hf_creator_spaces.sql
  db.exec(mig("2026-10-19-hf-reels.sql"));
  db.exec(mig("2026-10-19-hf-demo-hosts.sql"));
  db.exec(mig("2026-10-24-hf-reel-engage.sql"));
  db.exec(mig("2026-10-28-hf-intro-video-alters.sql"));
  db.exec(mig("2026-10-28-hf-intro-video-tables.sql"));
  db.exec(mig("2026-10-28-hf-intro-video-deleted-alters.sql")); // [HF-INTRO-DELETE-1]
  uploadedAt.clear(); kv.clear();
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = db.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    first: async () => (db.prepare(q).get(...args) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...args) }),
  });
  blobs = new Map();
  env = {
    DB_META: { prepare: (q: string) => stmt(q), batch: async (ss: any[]) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } },
    DB_WALLET: { prepare: () => stmt("SELECT 1") },
    BLOBS: {
      put: async (k: string, v: any) => { blobs.set(k, v); }, delete: async (k: string) => { blobs.delete(k); },
      list: async ({ prefix = "", cursor, limit = 1000 }: any) => { // [HF-INTRO-DELETE-1] paged listing like R2
        const keys = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + limit);
        const truncated = start + limit < keys.length;
        return { objects: page.map((key) => ({ key, size: blobs.get(key)?.byteLength ?? 0, uploaded: uploadedAt.get(key) ?? new Date(0) })), truncated, cursor: truncated ? String(start + limit) : undefined };
      },
    },
    TOKENS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); }, delete: async (k: string) => { kv.delete(k); } },
    BLOSSOM_BASE_URL: "https://media.test",
    ADMIN_UIDS: "admin1",
  };
  env.DB_WALLET = { prepare: (_q: string) => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) };
}

const MP4 = (n = 4096) => { const b = new Uint8Array(n); b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0); return b; };
const WEBM = (n = 4096) => { const b = new Uint8Array(n); b.set([0x1a, 0x45, 0xdf, 0xa3], 0); return b; };
const call = (path: string, init: any = {}, uid = "u1") => hfIntroOnboardingRoute(new Request("https://x" + path, { ...init, headers: { "x-test-uid": uid, ...(init.headers ?? {}) } }), env, path.split("?")[0]);
const adm = (path: string, init: any = {}) => hfIntroAdminRoute(new Request("https://x" + path, { ...init, headers: { "x-test-uid": "admin1", ...(init.headers ?? {}) } }), env, path.split("?")[0]);
const body = async (r: Response) => ({ status: r.status, ...(await r.json()) });
const upload = (o: any = {}, uid = "u1") => call("/api/hf/onboarding/intro-video", {
  method: "POST", body: o.bytes ?? MP4(),
  headers: { "content-type": o.mime ?? "video/mp4", "x-duration-ms": String(o.ms ?? 12000), "x-video-width": String(o.w ?? 720), "x-video-height": String(o.h ?? 1280), ...(o.extra ?? {}) },
}, uid);
const submit = (b: any, uid = "u1") => call("/api/hf/onboarding/submit", { method: "POST", body: JSON.stringify(b) }, uid);
const vid = (n: number) => "hfin_" + n.toString(16).padStart(20, "0");

function host(uid: string, o: any = {}) {
  db.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, about, price_per_min, presence, call_mode, avatar_id, women_lane) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(uid, o.slug === undefined ? "slug-" + uid : o.slug, o.status ?? "draft", o.name === undefined ? "Name " + uid : o.name, o.about === undefined ? "I talk about travel and food." : o.about, o.rate ?? 20, o.presence ?? "offline", o.mode ?? "online", o.avatar === undefined ? "av1" : o.avatar, o.women ?? 0);
}
const kyc = (uid: string, gender: string, done = 1) => db.prepare("INSERT INTO hf_kyc (uid, gender, verified_at) VALUES (?,?,?)").run(uid, gender, done ? 1 : null);
const social = (uid: string, platform = "youtube") => db.prepare("INSERT INTO hf_channels (id, host_uid, platform, handle, followers, status, verified_at, created_at, platform_user_id, provider_ref, url) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("ch_" + uid + platform, uid, platform, "@" + uid, 500, "approved", 1, 1, "pu_" + uid + platform, platform + "-oauth", "https://example.com/" + uid); // [HF-INTRO-INT] verified by login
async function recordedDraft(uid = "u1") { const j = await body(await upload({}, uid)); expect(j.ok).toBe(true); return j.video.id as string; }
const base = (id: string, o: any = {}) => ({ categories: o.categories ?? ["traveller"], lang: "hi", intro_video_id: id, call_option: o.option ?? "B" });

beforeEach(() => { makeEnv(); cfg = { hfIntroOnboardingEnabled: true, hfIntroReelsEnabled: true, hfReelsEnabled: true }; phoneVerified = true; sent.length = 0; events.length = 0; });

describe("catalogue", () => {
  it("normal categories first, the four sensitive ones last in order, no LGBTQ+", () => {
    const ids = HF_CATEGORIES.map((c) => c.id);
    expect(ids.slice(-4)).toEqual(["listener", "prayer", "virtual_friend", "women_to_women"]);
    expect(ids.slice(0, -4).some((i) => isSensitiveCategory(i))).toBe(false);
    expect(ids.some((i) => /lgbt/i.test(i))).toBe(false);
    expect(normalizeCategories(["prayer", "astrology", "astrology"])).toEqual(["astrology", "prayer"]);
    expect(normalizeCategories(["nope"])).toBeNull();
    expect(normalizeCategories([])).toBeNull();
  });
  it("GET categories works and the flag gates it", async () => {
    const j = await body(await call("/api/hf/onboarding/categories"));
    expect(j.categories.length).toBe(HF_CATEGORIES.length);
    cfg = { hfIntroOnboardingEnabled: false };
    expect((await call("/api/hf/onboarding/categories")).status).toBe(404);
  });
});

describe("recorded video validation (pure)", () => {
  const ok = (ms: number, w = 720, h = 1280, mime = "video/mp4", b = MP4()) => validateIntroVideo(mime, b, ms, w, h);
  it("accepts 10-20 s portrait mp4 / webm", () => {
    expect(ok(10000).ok).toBe(true);
    expect(ok(20000).ok).toBe(true);
    expect(ok(20400).ok).toBe(true);
    expect(ok(12000, 720, 1280, "video/webm", WEBM()).ok).toBe(true);
  });
  it("rejects too short, too long, landscape, square, wrong type, wrong bytes, missing numbers", () => {
    expect(ok(9999)).toMatchObject({ ok: false, error: "too_short" });
    expect(ok(21000)).toMatchObject({ ok: false, error: "too_long" });
    expect(ok(12000, 1280, 720)).toMatchObject({ ok: false, error: "not_portrait" });
    expect(ok(12000, 720, 720)).toMatchObject({ ok: false, error: "not_portrait" });
    expect(ok(12000, 720, 1280, "video/quicktime")).toMatchObject({ ok: false, error: "unsupported_type" });
    expect(ok(12000, 720, 1280, "video/mp4", WEBM())).toMatchObject({ ok: false, error: "unsupported_type" });
    expect(validateIntroVideo("video/mp4", MP4(), undefined, 720, 1280)).toMatchObject({ ok: false, error: "duration_required" });
    expect(validateIntroVideo("video/mp4", MP4(), 12000, null, null)).toMatchObject({ ok: false, error: "size_required" });
    expect(validateIntroVideo("video/mp4", null, 12000, 720, 1280)).toMatchObject({ ok: false, error: "too_large" });
  });
});

describe("POST intro-video", () => {
  it("stores a valid portrait video in R2 and returns public URLs", async () => {
    const j = await body(await upload({ extra: { "x-lang": "hi", "x-topic": "astrology" } }));
    expect(j.status).toBe(200);
    expect(j.video.videoUrl).toMatch(/^https:\/\/media\.test\/intro-video\/u1\/hfin_[a-f0-9]{20}\.mp4$/);
    expect(j.video.status).toBe("draft");
    expect(blobs.size).toBe(1);
    expect(events.some((e) => e.event === "hf_intro_upload" && e.props.ok === true && e.props.email === "u1@test.dev")).toBe(true);
  });
  it("rejects landscape, short, long, wrong type with clear codes and stores nothing", async () => {
    expect((await body(await upload({ w: 1280, h: 720 }))).error).toBe("not_portrait");
    expect((await body(await upload({ ms: 5000 }))).error).toBe("too_short");
    expect((await body(await upload({ ms: 30000 }))).error).toBe("too_long");
    expect((await body(await upload({ mime: "image/png" }))).error).toBe("unsupported_type");
    expect(blobs.size).toBe(0);
    expect(events.filter((e) => e.event === "hf_intro_upload" && e.props.ok === false).length).toBe(4);
  });
  it("a new recording replaces the previous draft (one intro per person) and removes its file", async () => {
    const a = await recordedDraft();
    const b = await recordedDraft();
    expect(a).not.toBe(b);
    expect(blobs.size).toBe(1);
    expect(db.prepare("SELECT status FROM hf_intro_videos WHERE id=?").get(a).status).toBe("replaced");
  });
  it("poster upload: owner only", async () => {
    const id = await recordedDraft();
    const png = new Uint8Array(500);
    const r = await body(await call(`/api/hf/onboarding/intro-video/${id}/poster`, { method: "PUT", body: png, headers: { "content-type": "image/png" } }));
    expect(r.status).toBe(200);
    expect(r.video.posterUrl).toMatch(/poster/);
    expect((await call(`/api/hf/onboarding/intro-video/${id}/poster`, { method: "PUT", body: png, headers: { "content-type": "image/png" } }, "other")).status).toBe(404);
  });
});

describe("submit rules", () => {
  it("incomplete profile is refused with what is missing", async () => {
    const id = await recordedDraft();
    host("u1", { about: "", avatar: null, rate: 0 });
    const j = await body(await submit(base(id)));
    expect(j.status).toBe(422);
    expect(j.missing).toEqual(expect.arrayContaining(["description", "photo", "rate"]));
  });
  it("no verified social and no Aadhaar -> aadhaar_required", async () => {
    const id = await recordedDraft(); host("u1");
    const j = await body(await submit(base(id)));
    expect(j).toMatchObject({ status: 409, error: "aadhaar_required" });
  });
  it("verified social + normal category needs no Aadhaar and creates a 'submitted' application; account is NOT live", async () => {
    const id = await recordedDraft(); host("u1"); social("u1");
    const j = await body(await submit(base(id)));
    expect(j.status).toBe(200);
    expect(j.application.status).toBe("submitted");
    expect(j.message).toMatch(/Sent for approval/);
    expect(db.prepare("SELECT status, intro_approved_at FROM hf_hosts WHERE uid='u1'").get()).toMatchObject({ status: "draft", intro_approved_at: null });
    expect(events.some((e) => e.event === "hf_onb_submitted" && e.props.clerk_uid === "u1" && e.props.email === "u1@test.dev")).toBe(true);
  });
  it("sensitive category needs Aadhaar even with a verified social", async () => {
    const id = await recordedDraft(); host("u1"); social("u1");
    expect((await body(await submit(base(id, { categories: ["listener"] })))).error).toBe("aadhaar_required");
    kyc("u1", "M");
    expect((await body(await submit(base(id, { categories: ["prayer"] })))).status).toBe(200);
  });
  it("Women-to-Women needs Aadhaar gender F", async () => {
    const id = await recordedDraft(); host("u1"); social("u1"); kyc("u1", "M");
    const no = await body(await submit(base(id, { categories: ["women_to_women"] })));
    expect(no).toMatchObject({ status: 403, error: "women_to_women_requires_female" });
    db.prepare("UPDATE hf_kyc SET gender='F' WHERE uid='u1'").run();
    expect((await body(await submit(base(id, { categories: ["women_to_women"] })))).status).toBe(200);
  });
  it("pure gate matches D4", () => {
    expect(submissionGate({ categories: ["tech"], hasVerifiedSocial: true, aadhaarDone: false, aadhaarGender: null })).toBeNull();
    expect(submissionGate({ categories: ["tech"], hasVerifiedSocial: false, aadhaarDone: false, aadhaarGender: null })).toBe("aadhaar_required");
    expect(submissionGate({ categories: ["tech"], hasVerifiedSocial: false, aadhaarDone: true, aadhaarGender: "M" })).toBeNull();
    expect(submissionGate({ categories: ["women_to_women"], hasVerifiedSocial: true, aadhaarDone: true, aadhaarGender: "T" })).toBe("women_to_women_requires_female");
  });
  it("bad input and double submit", async () => {
    const id = await recordedDraft(); host("u1"); social("u1");
    expect((await body(await submit({ ...base(id), categories: [] }))).field).toBe("categories");
    expect((await body(await submit({ ...base(id), call_option: "C" }))).field).toBe("call_option");
    expect((await body(await submit({ ...base(id), lang: "xx" }))).field).toBe("lang");
    expect((await body(await submit({ ...base(id), intro_video_id: "nope" }))).field).toBe("intro_video_id");
    expect((await body(await submit(base(vid(99))))).error).toBe("video_not_found");
    expect((await body(await submit(base(id)))).status).toBe(200);
    expect((await body(await submit(base(id)))).status).toBeGreaterThanOrEqual(409);
  });
  it("whatsapp not verified is listed as missing", async () => {
    const id = await recordedDraft(); host("u1"); social("u1"); phoneVerified = false;
    expect((await body(await submit(base(id)))).missing).toContain("whatsapp");
  });
});

async function submitted(uid = "u1", o: any = {}) {
  host(uid, { status: o.hostStatus ?? "draft", presence: o.presence, rate: o.rate });
  if (o.social !== false) social(uid);
  if (o.gender) kyc(uid, o.gender);
  const id = await recordedDraft(uid);
  const j = await body(await submit({ categories: o.cats ?? ["traveller"], lang: "en", intro_video_id: id, call_option: o.option ?? "B" }, uid));
  expect(j.status).toBe(200);
  return { videoId: id, appId: j.application.id as string };
}
const approve = (id: string) => adm(`/api/admin/hf/intro-applications/${id}/approve`, { method: "POST" });
const reject = (id: string, b: any) => adm(`/api/admin/hf/intro-applications/${id}/reject`, { method: "POST", body: JSON.stringify(b) });

describe("admin review", () => {
  it("non-admin is refused; list and detail show the D12 facts", async () => {
    const s = await submitted();
    const denied = await hfIntroAdminRoute(new Request("https://x/api/admin/hf/intro-applications", { headers: { "x-test-uid": "u1" } }), env, "/api/admin/hf/intro-applications");
    expect(denied.status).toBe(403);
    const l = await body(await adm("/api/admin/hf/intro-applications"));
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ id: s.appId, name: "Name u1", lang: "en", ratePerMin: 20, hasSocials: true, callOption: "B" });
    expect(l.rejectReasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["face_unclear", "video_dark", "audio_unclear", "contact_shared", "unsuitable", "wrong_category", "description_fix", "rate_fix", "aadhaar_mismatch", "other"]));
    const d = await body(await adm(`/api/admin/hf/intro-applications/${s.appId}`));
    expect(d.video.videoUrl).toMatch(/intro-video\/u1\//);
    expect(d.socials[0]).toMatchObject({ platform: "youtube" });
    expect(d.socials[0].url).toMatch(/^https:\/\//);
    expect(d.host).toMatchObject({ name: "Name u1", description: "I talk about travel and food.", ratePerMin: 20, callOption: "B" });
    expect(d.calendar.weekly[0].weekday).toBe(1);
    expect(d.aadhaar).toMatchObject({ done: false, female: false });
  });

  it("approve: host goes live with categories / call option / intro fields, WhatsApp 'you are live', telemetry", async () => {
    const s = await submitted("u1", { cats: ["traveller", "women_to_women"], gender: "F", option: "A" });
    const r = await body(await approve(s.appId));
    expect(r).toMatchObject({ ok: true, status: "approved", notified: true });
    const h = db.prepare("SELECT * FROM hf_hosts WHERE uid='u1'").get();
    expect(h).toMatchObject({ status: "live", call_option: "A", intro_video_id: s.videoId, women_lane: 1 });
    expect(h.intro_approved_at).toBeGreaterThan(0);
    expect(JSON.parse(h.categories_json)).toEqual(["traveller", "women_to_women"]);
    expect(db.prepare("SELECT status FROM hf_intro_videos WHERE id=?").get(s.videoId).status).toBe("approved");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("+9190000u1");
    expect(sent[0].text).toMatch(/approved/);
    expect(sent[0].text).toMatch(/Hello Fraands/);
    expect(events.some((e) => e.event === "hf_admin_review" && e.props.decision === "approve" && e.props.uid === "admin1")).toBe(true);
    expect(events.some((e) => e.event === "hf_review_whatsapp" && e.props.decision === "approve" && e.props.ok === true)).toBe(true);
    expect((await body(await approve(s.appId))).error).toBe("bad_state"); // decided already
  });

  it("approve re-checks the rules: Aadhaar removed after submit blocks it", async () => {
    const s = await submitted("u1", { cats: ["listener"], gender: "M" });
    db.prepare("UPDATE hf_kyc SET verified_at=NULL WHERE uid='u1'").run();
    expect((await body(await approve(s.appId))).error).toBe("aadhaar_required");
    expect(sent).toHaveLength(0);
  });

  it("reject needs reasons; WhatsApp lists the reasons and the note; person can fix and resubmit", async () => {
    const s = await submitted();
    expect((await body(await reject(s.appId, { reasons: [] }))).field).toBe("reasons");
    expect((await body(await reject(s.appId, { reasons: ["bogus"] }))).field).toBe("reasons");
    expect((await body(await reject(s.appId, { reasons: ["other"] }))).error).toBe("note_required");
    const r = await body(await reject(s.appId, { reasons: ["video_dark", "audio_unclear"], note: "Please say your name first." }));
    expect(r).toMatchObject({ ok: true, status: "rejected", notified: true });
    expect(sent[0].text).toMatch(/too dark/);
    expect(sent[0].text).toMatch(/could not hear you/);
    expect(sent[0].text).toMatch(/Please say your name first\./);
    expect(sent[0].text).toMatch(/send it again/);
    expect(db.prepare("SELECT status FROM hf_hosts WHERE uid='u1'").get().status).toBe("draft"); // never became live
    expect(db.prepare("SELECT intro_approved_at FROM hf_hosts WHERE uid='u1'").get().intro_approved_at).toBeNull();
    expect(events.some((e) => e.event === "hf_admin_review" && e.props.decision === "reject" && e.props.reasons === "video_dark,audio_unclear")).toBe(true);
    // me shows the reasons; resubmit with a NEW recording works, with the same rejected one too
    const me = await body(await call("/api/hf/onboarding/me"));
    expect(me.application.status).toBe("rejected");
    expect(me.application.rejectReasons[0].code).toBe("video_dark");
    // [HF-INTRO-DELETE-1] the rejected video is deleted, so the OLD one can not be sent again - she records a new one
    expect((await body(await submit({ categories: ["traveller"], lang: "en", intro_video_id: s.videoId, call_option: "B" }))).error).toBe("video_not_available");
    const fresh = await recordedDraft();
    const again = await body(await submit({ categories: ["traveller"], lang: "en", intro_video_id: fresh, call_option: "B" }));
    expect(again.status).toBe(200);
    const l = await body(await adm("/api/admin/hf/intro-applications"));
    expect(l.items).toHaveLength(1);
    const rejectedList = await body(await adm("/api/admin/hf/intro-applications?status=rejected"));
    expect(rejectedList.items).toHaveLength(1);
  });

  it("a person with no WhatsApp number still gets decided (notified=false, no crash)", async () => {
    const s = await submitted("nophone");
    const r = await body(await approve(s.appId));
    expect(r).toMatchObject({ ok: true, notified: false, notifyReason: "no_number" });
    expect(events.some((e) => e.event === "hf_review_whatsapp" && e.props.ok === false)).toBe(true);
  });

  it("reject message text is plain English", () => {
    expect(rejectedMessage(["face_unclear"], null)).toMatch(/not approved yet/);
  });
});

describe("reels feed (hfIntroReelsEnabled)", () => {
  async function liveInfluencer(uid: string, o: any = {}) {
    const s = await submitted(uid, { option: o.option ?? "B", hostStatus: o.hostStatus, presence: o.presence ?? "online" });
    if (o.approve !== false) expect((await body(await approve(s.appId))).ok).toBe(true);
    if (o.presence) db.prepare("UPDATE hf_hosts SET presence=? WHERE uid=?").run(o.presence, uid);
    if (o.mode) db.prepare("UPDATE hf_hosts SET call_mode=? WHERE uid=?").run(o.mode, uid);
    return s;
  }
  const feed = async (q = "") => body(await hfReelsRoute(new Request("https://x/api/hf/reels" + q), env, "/api/hf/reels"));
  const ids = (j: any) => j.items.map((i: any) => i.host.slug);

  it("returns only approved intro videos: A always, B only while Online, B offline hidden, unapproved hidden", async () => {
    await liveInfluencer("a1", { option: "A", presence: "offline" });
    await liveInfluencer("b_on", { option: "B", presence: "online" });
    await liveInfluencer("b_busy", { option: "B", presence: "busy" });
    await liveInfluencer("b_off", { option: "B", presence: "offline" });
    await liveInfluencer("b_bk", { option: "B", presence: "online", mode: "bookings_only" });
    await liveInfluencer("pending", { option: "A", approve: false });
    const j = await feed();
    expect(j.ok).toBe(true);
    expect(ids(j).sort()).toEqual(["slug-a1", "slug-b_busy", "slug-b_on"]);
    const a = j.items.find((i: any) => i.host.slug === "slug-a1");
    expect(a).toMatchObject({ kind: "intro", callOption: "A", callState: "appointments", womenOnly: false, greenTick: true });
    expect(a.videoUrl).toMatch(/intro-video/);
    expect(a.categories).toEqual([{ id: "traveller", label: "Traveller" }]);
    expect(a.ratePaise).toBe(2000);
    expect(a.socials[0]).toMatchObject({ platform: "youtube" });
    expect(j.items.find((i: any) => i.host.slug === "slug-b_busy").callState).toBe("on_call");
    expect(j.items.find((i: any) => i.host.slug === "slug-b_on").callState).toBe("available");
  });

  it("a pre-existing live influencer without an approved intro video is excluded, and /me says needsIntroVideo", async () => {
    host("old", { status: "live", slug: "old", presence: "online" }); social("old");
    db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, visible, is_demo, published_at, imported_at) VALUES ('hfrl_oldoldold1','old','ch_oldyoutube','youtube','v1','https://e/1','c',1,0,5,1)").run();
    expect((await feed()).items).toEqual([]);
    expect(await introSelfState(env, "old", "live")).toMatchObject({ needsIntroVideo: true, introStatus: "none" });
    await submitted("new"); // a brand-new applicant is not "needs": he is mid-onboarding
    expect(await introSelfState(env, "new", "draft")).toMatchObject({ needsIntroVideo: false, introStatus: "submitted" });
    // after submitting, the banner goes away for the old influencer too
    const id = await recordedDraft("old");
    expect((await body(await submit({ categories: ["tech"], lang: "hi", intro_video_id: id, call_option: "A" }, "old"))).status).toBe(200);
    expect(await introSelfState(env, "old", "live")).toMatchObject({ needsIntroVideo: false, introStatus: "submitted" });
  });

  it("flag off keeps the old embed feed untouched", async () => {
    await liveInfluencer("a1", { option: "A" });
    host("old", { status: "approved", slug: "old", presence: "online" }); social("old");
    db.prepare("INSERT INTO hf_reels (id, host_uid, channel_id, platform, platform_video_id, embed_url, caption, visible, is_demo, published_at, imported_at) VALUES ('hfrl_oldoldold1','old','ch_oldyoutube','youtube','v1','https://e/1','c',1,0,5,1)").run();
    cfg = { hfIntroOnboardingEnabled: true, hfIntroReelsEnabled: false, hfReelsEnabled: true };
    const j = await feed();
    expect(j.items.map((i: any) => i.id)).toEqual(["hfrl_oldoldold1"]);
    expect(j.items[0].kind).toBeUndefined();
  });

  it("paging uses a stable cursor", async () => {
    await liveInfluencer("p1", { option: "A" }); await liveInfluencer("p2", { option: "A" }); await liveInfluencer("p3", { option: "A" });
    db.prepare("UPDATE hf_hosts SET intro_approved_at=intro_approved_at+CASE uid WHEN 'p1' THEN 3 WHEN 'p2' THEN 2 ELSE 1 END WHERE uid LIKE 'p%'").run();
    const one = await feed("?limit=2");
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).toMatch(/^\d+_hfin_/);
    const two = await feed(`?limit=2&cursor=${one.nextCursor}`);
    expect(two.items).toHaveLength(1);
    expect(two.nextCursor).toBeNull();
    expect((await feed("?cursor=bad")).error).toBe("invalid_field");
  });

  it("intro reels have stable ids that likes / comments / share accept (visibleReel)", async () => {
    const s = await liveInfluencer("b_off", { option: "B", presence: "offline" }); // hidden from the feed, but a shared link still plays
    expect(await visibleReel(env, cfg, s.videoId)).toMatchObject({ id: s.videoId, platform: "intro" });
    const one = await body(await hfReelsRoute(new Request("https://x/api/hf/reels/" + s.videoId), env, "/api/hf/reels/" + s.videoId));
    expect(one.item.id).toBe(s.videoId);
    expect(one.item.shareUrl).toContain("/r/" + s.videoId);
    cfg = { ...cfg, hfIntroReelsEnabled: false };
    expect(await visibleReel(env, cfg, s.videoId)).toBeNull();
    expect(await visibleReel(env, { hfIntroReelsEnabled: true }, vid(12345))).toBeNull();
  });

  it("likes and comments work on an intro reel and counts reach the feed", async () => {
    cfg = { ...cfg, hfReelEngageEnabled: true };
    const s = await liveInfluencer("a1", { option: "A" });
    const eng = (path: string, init: any = {}) => hfReelEngageRoute(new Request("https://x" + path, { ...init, headers: { "x-test-uid": "fan1", "content-type": "application/json" } }), env, path);
    expect((await body(await eng(`/api/hf/reels/${s.videoId}/like`, { method: "POST" }))).liked).toBe(true);
    const c = await body(await eng(`/api/hf/reels/${s.videoId}/comments`, { method: "POST", body: JSON.stringify({ body: "Great video" }) }));
    expect(c.ok).toBe(true);
    const list = await body(await eng(`/api/hf/reels/${s.videoId}/comments`, { method: "GET" }));
    expect(list.items.some((i: any) => i.body === "Great video")).toBe(true);
    const f = await feed();
    expect(f.items[0]).toMatchObject({ id: s.videoId, likes: 1, comments: 1 });
  });
});

// ── [HF-INTRO-DELETE-1] clean-up: files must not outlive the decision ─────────────────────────────────────────────
const dayMs = 86_400_000;
const delEvents = () => events.filter((e) => e.event === "hf_intro_video_deleted");
async function withPoster(videoId: string, uid = "u1") {
  const r = await call(`/api/hf/onboarding/intro-video/${videoId}/poster`, { method: "PUT", body: new Uint8Array(300), headers: { "content-type": "image/jpeg" } }, uid);
  expect((await body(r)).ok).toBe(true);
}

describe("intro video clean-up", () => {
  it("reject deletes the video + poster from storage, keeps the row and the reasons, emits telemetry", async () => {
    host("u1"); social("u1");
    const videoId = await recordedDraft();
    await withPoster(videoId);
    const j = await body(await submit({ categories: ["traveller"], lang: "en", intro_video_id: videoId, call_option: "B" }));
    const s = { videoId, appId: j.application.id as string };
    expect(blobs.size).toBe(2);
    const bytes = db.prepare("SELECT bytes FROM hf_intro_videos WHERE id=?").get(s.videoId).bytes;
    const r = await body(await reject(s.appId, { reasons: ["video_dark"] }));
    expect(r).toMatchObject({ ok: true, status: "rejected", videoDeleted: true });
    expect(blobs.size).toBe(0);
    const row = db.prepare("SELECT * FROM hf_intro_videos WHERE id=?").get(s.videoId);
    expect(row).toMatchObject({ status: "rejected", r2_key: "", poster_key: null, deleted_reason: "rejected" });
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(db.prepare("SELECT reject_reasons_json FROM hf_influencer_applications WHERE id=?").get(s.appId).reject_reasons_json).toContain("video_dark");
    expect(delEvents()).toHaveLength(1);
    expect(delEvents()[0].props).toMatchObject({ reason: "rejected", bytes, files: 2 });
    // admin detail: no URLs, says when it was deleted (drives the "Video deleted" panel)
    const d = await body(await adm(`/api/admin/hf/intro-applications/${s.appId}`));
    expect(d.video).toMatchObject({ videoUrl: null, posterUrl: null, deletedReason: "rejected" });
    expect(d.video.deletedAt).toBe(row.deleted_at);
    // the person's own state does not show the dead video
    expect((await body(await call("/api/hf/onboarding/me"))).video).toBeNull();
  });

  it("a failed R2 delete keeps the keys; the daily sweep finishes the job", async () => {
    const s = await submitted();
    const realDelete = env.BLOBS.delete;
    env.BLOBS.delete = async () => { throw new Error("r2 down"); };
    expect((await body(await reject(s.appId, { reasons: ["video_dark"] }))).videoDeleted).toBe(false);
    expect(blobs.size).toBe(1);
    expect(db.prepare("SELECT deleted_at FROM hf_intro_videos WHERE id=?").get(s.videoId).deleted_at).toBeNull();
    env.BLOBS.delete = realDelete;
    const r = await sweepIntroVideos(env);
    expect(r).toMatchObject({ rejected: 1, errors: 0 });
    expect(blobs.size).toBe(0);
    expect(db.prepare("SELECT deleted_at FROM hf_intro_videos WHERE id=?").get(s.videoId).deleted_at).toBeGreaterThan(0);
    expect((await sweepIntroVideos(env)).rejected).toBe(0); // nothing left to do
  });

  it("approve deletes the files of the older approved video (status replaced) and keeps the new one", async () => {
    const first = await submitted("u1");
    await approve(first.appId);
    const oldKey = db.prepare("SELECT r2_key FROM hf_intro_videos WHERE id=?").get(first.videoId).r2_key;
    const id2 = await recordedDraft("u1");
    const j = await body(await submit({ categories: ["traveller"], lang: "en", intro_video_id: id2, call_option: "B" }));
    expect(j.status).toBe(200);
    expect(blobs.has(oldKey)).toBe(true);
    const ok = await body(await approve(j.application.id));
    expect(ok.ok).toBe(true);
    expect(blobs.has(oldKey)).toBe(false);
    expect(blobs.size).toBe(1);
    expect(db.prepare("SELECT status, r2_key, deleted_reason FROM hf_intro_videos WHERE id=?").get(first.videoId)).toMatchObject({ status: "replaced", r2_key: "", deleted_reason: "replaced" });
    expect(db.prepare("SELECT status, deleted_at FROM hf_intro_videos WHERE id=?").get(id2)).toMatchObject({ status: "approved", deleted_at: null });
    expect(delEvents().map((e) => e.props.reason)).toEqual(["replaced"]);
  });

  it("recording again replaces the old draft and deletes its file (telemetry draft_replaced)", async () => {
    await recordedDraft(); await recordedDraft();
    expect(blobs.size).toBe(1);
    expect(delEvents().map((e) => e.props.reason)).toEqual(["draft_replaced"]);
  });

  it("drafts never submitted for 7 days are deleted; younger ones and submitted ones stay", async () => {
    const old = await recordedDraft("u1");
    const young = await recordedDraft("u2");
    const sub = await submitted("u3");
    const t = Date.now();
    db.prepare("UPDATE hf_intro_videos SET created_at=? WHERE id=?").run(t - 8 * dayMs, old);
    db.prepare("UPDATE hf_intro_videos SET created_at=? WHERE id=?").run(t - 8 * dayMs, sub.videoId); // submitted: not a draft any more
    db.prepare("UPDATE hf_intro_videos SET created_at=? WHERE id=?").run(t - 6 * dayMs, young);
    const r = await sweepIntroVideos(env, t);
    expect(r.expired).toBe(1);
    expect(db.prepare("SELECT status, r2_key, deleted_reason FROM hf_intro_videos WHERE id=?").get(old)).toMatchObject({ status: "expired", r2_key: "", deleted_reason: "draft_expired" });
    expect(db.prepare("SELECT status FROM hf_intro_videos WHERE id=?").get(young).status).toBe("draft");
    expect(db.prepare("SELECT status FROM hf_intro_videos WHERE id=?").get(sub.videoId).status).toBe("submitted");
    expect(blobs.size).toBe(2);
    // an expired draft can no longer be submitted
    host("u1"); social("u1");
    expect((await body(await submit(base(old)))).error).toBe("video_not_available");
  });

  it("weekly orphan check deletes unreferenced intro-video/ objects, spares referenced and brand-new ones, runs once a week", async () => {
    const kept = await recordedDraft("u1");
    const keptKey = db.prepare("SELECT r2_key FROM hf_intro_videos WHERE id=?").get(kept).r2_key;
    blobs.set("intro-video/u9/hfin_orphan.mp4", new Uint8Array(500));
    blobs.set("intro-video/u9/hfin_new.mp4", new Uint8Array(500));
    uploadedAt.set("intro-video/u9/hfin_new.mp4", new Date()); // in flight: younger than the grace period
    const r = await sweepIntroVideos(env);
    expect(r.orphans).toBe(1);
    expect(blobs.has("intro-video/u9/hfin_orphan.mp4")).toBe(false);
    expect(blobs.has("intro-video/u9/hfin_new.mp4")).toBe(true);
    expect(blobs.has(keptKey)).toBe(true);
    expect(delEvents().find((e) => e.props.reason === "orphan")?.props).toMatchObject({ bytes: 500, uid: "u9" });
    blobs.set("intro-video/u9/hfin_orphan2.mp4", new Uint8Array(1));
    expect((await sweepIntroVideos(env)).orphans).toBe(0); // once a week
    expect(blobs.has("intro-video/u9/hfin_orphan2.mp4")).toBe(true);
  });

  it("the sweep does nothing (and does not throw) before the deleted_at column exists", async () => {
    db.exec("DROP TABLE hf_intro_videos; CREATE TABLE hf_intro_videos (id TEXT PRIMARY KEY, uid TEXT, r2_key TEXT, status TEXT)");
    expect(await sweepIntroVideos(env)).toMatchObject({ rejected: 0, replaced: 0, expired: 0, orphans: 0 });
  });
});
