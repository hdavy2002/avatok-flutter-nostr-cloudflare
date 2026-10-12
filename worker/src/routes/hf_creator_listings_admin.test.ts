// @ts-nocheck -- route integration on the shared node:sqlite D1 adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ uid: "admin" }));
vi.mock("../authz", () => ({ requireUser: async () => ({ uid: auth.uid }), isFail: () => false }));
vi.mock("../lib/preview", () => ({ isAdminUid: (_e: any, uid: string) => uid === "admin" }));
vi.mock("../lib/identity", () => ({ emailFor: async () => "fixture@example.invalid" }));
vi.mock("../hooks", () => ({ trackUser: async () => {}, trackException: async () => {} }));
vi.mock("../lib/hf_intro_check", () => ({ transcribeAndFlag: async () => {} }));
import { makeDb } from "../lib/hf_token_d1_shim";
import { hfCreatorListingsAdminRoute } from "./hf_creator_listings_admin";
import { creatorPublicationBlockers } from "../lib/hf_creator_publication";
import { card } from "./hf_hosts_public";

let env: any;
const call = (suffix: string, method = "GET", data?: unknown) => hfCreatorListingsAdminRoute(new Request(`https://api.test/api/admin/hf/listings${suffix}`, { method, ...(data ? { body: JSON.stringify(data), headers: { "content-type": "application/json" } } : {}) }), env);
beforeEach(async () => {
  auth.uid = "admin";
  const db = makeDb(["2026-10-09-hf-hosts.sql", "2026-10-09-hf-host-kyc.sql", "2026-10-09-hf-voice-intro.sql", "2026-10-12-hf-creator-price-alters.sql"], { alters: true });
  db._raw.exec("CREATE TABLE admin_audit(id TEXT PRIMARY KEY,admin_id TEXT,action TEXT,target TEXT,meta TEXT,created_at INTEGER)");
  env = { DB_META: db, DB_WALLET: db, HF_PII_KEY: btoa("t".repeat(32)), BLOSSOM_BASE_URL: "https://media.example.invalid", VERIFICATION: { put: vi.fn(), delete: vi.fn() } };
});
describe("creator draft administration", () => {
  it("requires admin and a declared creator category", async () => {
    auth.uid = "host";
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(403);
    auth.uid = "admin";
    expect((await call("", "POST", { uid: "creator", category: "typo" })).status).toBe(400);
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(201);
    expect((await call("", "POST", { uid: "creator", category: "celebrity" })).status).toBe(409);
  });
  it("saves encrypted private phone, exposes it only to the admin, and keeps empty drafts unpublished", async () => {
    await call("", "POST", { uid: "creator", category: "influencer" });
    const saved = await call("/creator", "PUT", { displayName: "Example", privatePhone: "+919876543210", pricePerMin: 20 });
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
