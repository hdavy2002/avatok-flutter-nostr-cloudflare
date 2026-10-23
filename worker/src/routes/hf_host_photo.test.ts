// @ts-nocheck -- node:sqlite via the shared D1 shim; auth, rate limit and telemetry are faked
// [HF-CHANNEL-CORE-1] PUT /api/hosts/me/photo: magic bytes (not just the header), size and minimum dimensions, storage + media rows, telemetry.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "../lib/hf_token_d1_shim";

const h = vi.hoisted(() => ({ events: [] as any[], exceptions: [] as any[], limited: false }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => (req.headers.get("authorization") ? { uid: "inf1" } : { status: 401, error: "unauthorized" }), isFail: (x: any) => !!x.error }));
vi.mock("../money", () => ({ rateLimit: async () => (h.limited ? new Response("{}", { status: 429 }) : null) }));
vi.mock("../hooks", () => ({ trackUser: async (_e: any, uid: string, email: any, event: string, app: string, props: any) => { h.events.push({ uid, email, event, props }); }, trackException: async (_e: any, err: any) => { h.exceptions.push(err); } }));
vi.mock("../lib/identity", () => ({ emailFor: async () => "inf@example.com" }));

import { putHostPhoto } from "./hf_host_photo";
import { validateHostPhoto } from "../lib/hf_host_photo";

function jpeg(w: number, h2: number, pad = 64): Uint8Array {
  const b = new Uint8Array(20 + pad);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h2 >> 8, h2 & 255, w >> 8, w & 255, 0x03], 0);
  return b;
}
function png(w: number, h2: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h2); b[24] = 8; b[25] = 2;
  return b;
}
function webp(w: number, h2: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0); // RIFF....WEBPVP8X
  const wv = w - 1, hv = h2 - 1;
  b.set([wv & 255, (wv >> 8) & 255, (wv >> 16) & 255, hv & 255, (hv >> 8) & 255, (hv >> 16) & 255], 24);
  return b;
}

let env: any, blobs: Map<string, any>;
const put = (body: Uint8Array | null, type = "image/jpeg", auth = true) =>
  putHostPhoto(new Request("https://api.test/api/hosts/me/photo", { method: "PUT", headers: { ...(auth ? { authorization: "Bearer x" } : {}), "content-type": type }, body: body ?? undefined }), env);

beforeEach(() => {
  h.events = []; h.exceptions = []; h.limited = false; blobs = new Map();
  env = {
    DB_META: makeDb(["2026-10-09-hf-hosts.sql"]), BLOSSOM_BASE_URL: "https://media.test",
    BLOBS: { put: async (k: string, v: any) => { blobs.set(k, v); }, delete: async (k: string) => { blobs.delete(k); } },
  };
  env.DB_META._raw.prepare("INSERT INTO hf_hosts (uid, slug, status, created_at, updated_at) VALUES ('inf1','inf-one','live',1,1)").run();
});

describe("validateHostPhoto", () => {
  it("accepts a real JPEG, PNG and WebP of at least 600x750", () => {
    expect(validateHostPhoto("image/jpeg", jpeg(1200, 1500))).toMatchObject({ ok: true, ext: "jpg", width: 1200, height: 1500 });
    expect(validateHostPhoto("image/png", png(600, 750))).toMatchObject({ ok: true, ext: "png" });
    expect(validateHostPhoto("image/webp", webp(1200, 1500))).toMatchObject({ ok: true, ext: "webp", width: 1200, height: 1500 });
  });
  it("checks the bytes, not the header: a PNG sent as JPEG, a text file and an unsupported type are bad_type", () => {
    expect(validateHostPhoto("image/jpeg", png(1200, 1500))).toMatchObject({ ok: false, error: "bad_type" });
    expect(validateHostPhoto("image/png", new TextEncoder().encode("<html>not an image</html>"))).toMatchObject({ ok: false, error: "bad_type" });
    expect(validateHostPhoto("image/gif", jpeg(1200, 1500))).toMatchObject({ ok: false, status: 400, error: "bad_type" });
  });
  it("too small and too big", () => {
    expect(validateHostPhoto("image/jpeg", jpeg(599, 1500))).toMatchObject({ ok: false, error: "too_small" });
    expect(validateHostPhoto("image/jpeg", jpeg(1200, 749))).toMatchObject({ ok: false, error: "too_small" });
    expect(validateHostPhoto("image/jpeg", null)).toMatchObject({ ok: false, error: "too_big" });
  });
});

describe("PUT /api/hosts/me/photo", () => {
  it("stores the photo, supersedes the older profile row, and answers avatarUrl + uploaded", async () => {
    env.DB_META._raw.prepare("INSERT INTO hf_host_media (id, uid, kind, r2_key, status, job_id, created_at) VALUES ('old','inf1','profile','hf/hosts/inf1/old.png','active','job1',1)").run();
    const res = await put(jpeg(1200, 1500));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ ok: true, imageProvenance: "uploaded" });
    expect(body.avatarUrl).toMatch(/^https:\/\/media\.test\/hf\/hosts\/inf1\/profile-\d+\.jpg$/);
    expect([...blobs.keys()]).toHaveLength(1);
    const media = env.DB_META._raw.prepare("SELECT id, status, job_id, kind FROM hf_host_media ORDER BY created_at").all();
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({ id: "old", status: "superseded" });
    expect(media[1]).toMatchObject({ kind: "profile", status: "active", job_id: null });
    expect(h.events.map((e) => e.event)).toEqual(["host_profile_photo_uploaded"]);
    expect(h.events[0]).toMatchObject({ uid: "inf1", email: "inf@example.com" });
  });
  it("404 not_host when the caller has no host row; 401 without sign-in", async () => {
    env.DB_META._raw.prepare("DELETE FROM hf_hosts").run();
    expect((await put(jpeg(1200, 1500))).status).toBe(404);
    expect((await put(jpeg(1200, 1500), "image/jpeg", false)).status).toBe(401);
  });
  it("400 bad_type / too_small, nothing stored, rejection tracked", async () => {
    const a: any = await put(png(1200, 1500), "image/jpeg");
    expect(a.status).toBe(400); expect((await a.json()).error).toBe("bad_type");
    const b: any = await put(jpeg(300, 300));
    expect(b.status).toBe(400); expect((await b.json()).error).toBe("too_small");
    expect(blobs.size).toBe(0);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_host_media").get().n).toBe(0);
    expect(h.events.map((e) => e.event)).toEqual(["host_profile_photo_rejected", "host_profile_photo_rejected"]);
  });
  it("400 too_big when the declared length is over 10 MB", async () => {
    const res = await putHostPhoto(new Request("https://api.test/x", { method: "PUT", headers: { authorization: "Bearer x", "content-type": "image/jpeg", "content-length": String(11 * 1024 * 1024) }, body: jpeg(1200, 1500) }), env);
    expect(res.status).toBe(400); expect((await res.json()).error).toBe("too_big");
  });
  it("rate limited", async () => {
    h.limited = true;
    expect((await put(jpeg(1200, 1500))).status).toBe(429);
  });
  it("a storage failure removes the blob, tracks the exception and answers 500", async () => {
    env.DB_META.batch = async () => { throw new Error("d1 down"); };
    const res = await put(jpeg(1200, 1500));
    expect(res.status).toBe(500);
    expect(blobs.size).toBe(0);
    expect(h.exceptions).toHaveLength(1);
  });
});
