// @ts-nocheck -- route integration on the shared node:sqlite D1 adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ uid: "admin" }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: auth.uid }), isFail: () => false }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin" }));
vi.mock("../lib/identity", () => ({ emailFor: async () => "fixture@example.invalid" }));
vi.mock("../hooks", () => ({ trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../lib/hf_intro_check", () => ({ transcribeAndFlag: async () => {} }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("./config", () => ({ readConfig: async () => ({ hostOnboardingEnabled: true, hfStdPlanEnabled: false }) }));
import { makeDb } from "../lib/hf_token_d1_shim";
import { hfCreatorListingsAdminRoute } from "./hf_creator_listings_admin";
import { creatorPublicationBlockers } from "../lib/hf_creator_publication";
import { card } from "./hf_hosts_public";
import { hfHostsRoute } from "./hf_hosts";
import { approveIntroRow } from "./hf_hosts_admin";

let env: any;
const call = (suffix: string, method = "GET", data?: unknown) => hfCreatorListingsAdminRoute(new Request(`https://api.test/api/admin/hf/listings${suffix}`, { method, ...(data ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } } : {}) }), env);
beforeEach(async () => {
  auth.uid = "admin";
  const db = makeDb(["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-09-hf-host-kyc.sql", "2026-10-09-hf-voice-intro.sql", "2026-10-12-hf-creator-price-alters.sql"], { alters: true });
  db._raw.exec("CREATE TABLE users(uid TEXT PRIMARY KEY); INSERT INTO users(uid) VALUES ('creator')");
  db._raw.exec("CREATE TABLE admin_audit(id TEXT PRIMARY KEY,admin_id TEXT,action TEXT,target TEXT,meta TEXT,created_at INTEGER)");
  env = { DB_META: db, DB_WALLET: db, HF_PII_KEY: btoa("t".repeat(32)), BLOSSOM_BASE_URL: "https://media.example.invalid", VERIFICATION: { put: vi.fn(), delete: vi.fn().mockResolvedValue(undefined), get: vi.fn() }, BLOBS: { put: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) } };
});
describe("creator draft administration", () => {
  it("seeds only private offline drafts, preserves edits, and never permits fixture publication", async () => {
    auth.uid = "host";
    expect((await call("/seed", "POST", { mode: "private_drafts" })).status).toBe(403);
    auth.uid = "admin";
    expect((await call("/seed", "POST", {})).status).toBe(400);
    expect((await call("/seed", "POST", { mode: "private_drafts" })).status).toBe(200);
    const rows = env.DB_META._raw.prepare("SELECT * FROM hf_hosts").all();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.status === "draft" && r.presence === "offline" && !r.voice_sample_r2 && !r.agreements_at)).toBe(true);
    env.DB_META._raw.exec("UPDATE hf_hosts SET display_name='Edited' WHERE uid='fixture_creator_anya'");
    await call("/seed", "POST", { mode: "private_drafts" });
    const preview = await call("/fixture_creator_anya/preview");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect((await preview.json()).item).toMatchObject({ displayName: "Edited", status: "offline", rating: null, reviewCount: 0, talkedTo: 0 });
    expect((await call("/fixture_creator_anya/publish", "POST", {})).status).toBe(422);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM users").get().n).toBe(1);
  });
  it("removes pending and approved voice references, but refuses a live listing", async () => {
    await call("", "POST", { uid: "creator", category: "influencer" });
    const db = env.DB_META._raw;
    db.exec("UPDATE hf_hosts SET voice_sample_r2='private/voice',voice_seconds=20,intro_status='pending' WHERE uid='creator'");
    db.exec("INSERT INTO hf_host_media(id,uid,kind,r2_key,created_at) VALUES('voice','creator','intro_audio','public/voice',1)");
    expect((await call("/creator/voice", "DELETE")).status).toBe(200);
    expect(db.prepare("SELECT voice_sample_r2,voice_seconds,intro_status FROM hf_hosts").get()).toMatchObject({ voice_sample_r2: null, voice_seconds: null, intro_status: null });
    expect(db.prepare("SELECT status FROM hf_host_media WHERE id='voice'").get().status).toBe("superseded");
    expect(env.VERIFICATION.delete).toHaveBeenCalledWith("private/voice");
    expect(env.BLOBS.delete).toHaveBeenCalledWith("public/voice");
    db.exec("UPDATE hf_hosts SET status='live' WHERE uid='creator'");
    expect((await call("/creator/voice", "DELETE")).status).toBe(409);
  });
  it("cannot resurrect voice media when removal races an approval", async () => {
    await call("", "POST", { uid: "creator", category: "celebrity" });
    env.DB_META._raw.exec("UPDATE hf_hosts SET voice_sample_r2='private/voice',voice_seconds=20,intro_mime='audio/mpeg',intro_status='pending' WHERE uid='creator'");
    const snapshot = env.DB_META._raw.prepare("SELECT * FROM hf_hosts").get();
    env.VERIFICATION.get.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(22000), httpMetadata: { contentType: "audio/mpeg" } });
    env.BLOBS.put.mockImplementationOnce(async () => { expect((await call("/creator/voice", "DELETE")).status).toBe(200); });
    expect(await approveIntroRow(env, "creator", snapshot)).toMatchObject({ ok: false, error: "listing_changed" });
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_host_media WHERE status='active'").get().n).toBe(0);
  });
  it("rejects a self-service category edit if publication wins the write race", async () => {
    await call("", "POST", { uid: "creator", category: "influencer" });
    auth.uid = "creator";
    const prepare = env.DB_META.prepare;
    let raced = false;
    env.DB_META.prepare = (sql: string) => {
      if (!raced && sql.startsWith("UPDATE hf_hosts SET category=")) {
        raced = true;
        env.DB_META._raw.exec("UPDATE hf_hosts SET status='live',listing_revision=listing_revision+1 WHERE uid='creator'");
      }
      return prepare(sql);
    };
    const response = await hfHostsRoute(new Request("https://api.test/api/hosts/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "celebrity" }) }), env);
    expect(response.status).toBe(409);
    expect(env.DB_META._raw.prepare("SELECT category,status FROM hf_hosts").get()).toMatchObject({ category: "influencer", status: "live" });
  });
  it("cleans a self-service upload if publication races storage", async () => {
    await call("", "POST", { uid: "creator", category: "celebrity" });
    auth.uid = "creator";
    env.VERIFICATION.put.mockImplementationOnce(async () => env.DB_META._raw.exec("UPDATE hf_hosts SET status='live',listing_revision=listing_revision+1 WHERE uid='creator'"));
    const response = await hfHostsRoute(new Request("https://api.test/api/hosts/me/voice", { method: "PUT", body: new Uint8Array(22000), headers: { "content-type": "audio/webm", "x-duration-seconds": "20", "x-voice-consent": "v1" } }), env);
    expect(response.status).toBe(409);
    expect(env.VERIFICATION.delete).toHaveBeenCalledOnce();
    expect(env.DB_META._raw.prepare("SELECT voice_sample_r2 FROM hf_hosts").get().voice_sample_r2).toBeNull();
  });
  it("requires admin and a declared creator category", async () => {
    auth.uid = "host";
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(403);
    auth.uid = "admin";
    expect((await call("", "POST", { uid: "creator", category: "typo" })).status).toBe(400);
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(201);
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(409);
  });
  it("cannot create a listing for an account that does not exist", async () => {
    const response = await call("", "POST", { uid: "missing", category: "influencer" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "account_not_found", field: "uid" });
  });
  it("saves encrypted private phone, exposes it only to the admin, and keeps empty drafts unpublished", async () => {
    await call("", "POST", { uid: "creator", category: "influencer" });
    const saved = await call("/creator", "PUT", { expectedRevision: 1, displayName: "Example", privatePhone: "+919876543210", pricePerMin: 20 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).listing.privatePhone).toBe("+919876543210");
    const row = env.DB_META._raw.prepare("SELECT * FROM hf_hosts WHERE uid='creator'").get();
    expect(row.private_phone_enc).toMatch(/^v1:/);
    expect(row.private_phone_enc).not.toContain("9876543210");
    expect(JSON.stringify(card(env, { ...row, image_key: null, audio_key: null, audio_caption: null }))).not.toMatch(/privatePhone|private_phone|9876543210|v1:/);
    const publish = await call("/creator/publish", "POST", { verified: true, status: "live" });
    expect(publish.status).toBe(422);
    expect((await publish.json()).missing).toEqual(expect.arrayContaining(["video_kyc", "identity_verification", "voice"]));
  });
  it("rejects a stale admin editor revision instead of overwriting a newer save", async () => {
    await call("", "POST", { uid: "creator", category: "influencer" });
    expect((await call("/creator", "PUT", { expectedRevision: 1, displayName: "First save", pricePerMin: 20 })).status).toBe(200);
    const stale = await call("/creator", "PUT", { expectedRevision: 1, displayName: "Stale save", pricePerMin: 30 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "listing_changed", currentRevision: 2 });
    expect(env.DB_META._raw.prepare("SELECT display_name,price_per_min FROM hf_hosts WHERE uid='creator'").get()).toMatchObject({ display_name: "First save", price_per_min: 20 });
  });
  it("rejects undersized MP3 duration and invalid audio bytes before storage", async () => {
    await call("", "POST", { uid: "creator", category: "celebrity" });
    const bytes = new Uint8Array(22000); bytes.set([73, 68, 51]);
    const upload = (seconds: string, type = "audio/mpeg") => hfCreatorListingsAdminRoute(new Request("https://api.test/api/admin/hf/listings/creator/voice", { method: "PUT", body: bytes, headers: { "content-type": type, "x-duration-seconds": seconds, "x-voice-consent": "v1" } }), env);
    expect((await upload("19.99")).status).toBe(422);
    expect((await upload("20", "image/png")).status).toBe(415);
    expect(env.VERIFICATION.put).not.toHaveBeenCalled();
    expect((await upload("20")).status).toBe(200);
    expect(env.VERIFICATION.put).toHaveBeenCalledOnce();
    expect((await (await call("/creator")).json()).listing.voice).toMatchObject({ status: "pending", seconds: 20, mime: "audio/mpeg" });
  });
  it("requires a real approved six-digit video record, not identity verification alone", async () => {
    await call("", "POST", { uid: "creator", category: "celebrity" });
    const db = env.DB_META._raw;
    db.exec("INSERT INTO hf_kyc(uid,verified_at,age_ok,updated_at) VALUES ('creator',1,1,1)");
    db.exec("INSERT INTO hf_selfie(id,uid,code,r2_key,mime,bytes,created_at,review_status) VALUES ('v','creator','1234','private/video','video/mp4',22000,1,'approved')");
    expect(await creatorPublicationBlockers(env, "creator")).toContain("video_kyc");
    db.exec("UPDATE hf_selfie SET code='123456' WHERE id='v'");
    expect(await creatorPublicationBlockers(env, "creator")).not.toContain("video_kyc");
    db.exec("UPDATE hf_selfie SET review_status='pending' WHERE id='v'");
    expect(await creatorPublicationBlockers(env, "creator")).toContain("video_kyc");
  });
});
