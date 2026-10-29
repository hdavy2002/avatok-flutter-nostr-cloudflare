// @ts-nocheck -- node:sqlite via the shared D1 shim; auth, config, rate limit, telemetry and Workers AI are faked
// [HF-MOD-2] Clef photo check through the hf-mod-photo queue: store privately, queue, pass -> public, refuse -> deleted.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "../lib/hf_token_d1_shim";

const h = vi.hoisted(() => ({ events: [] as any[], cfg: { hfPhotoModerationEnabled: true } as any, admin: false }));
vi.mock("../authz", () => ({ requireUser: async (req: Request) => (req.headers.get("authorization") ? { uid: req.headers.get("x-uid") ?? "fan1" } : { status: 401, error: "unauthorized" }), isFail: (x: any) => !!x.error }));
vi.mock("../money", () => ({ rateLimit: async () => null }));
vi.mock("../hooks", () => ({
  track: async (_e: any, uid: string, event: string, _a: string, props: any) => { h.events.push({ uid, event, props }); },
  trackUser: async (_e: any, uid: string, _m: any, event: string, _a: string, props: any) => { h.events.push({ uid, event, props }); },
  trackException: async () => undefined,
}));
vi.mock("../lib/identity", () => ({ emailFor: async () => "x@example.com" }));
vi.mock("../lib/preview", () => ({ isAdminUid: () => h.admin }));
vi.mock("./config", () => ({ readConfig: async () => h.cfg }));

import { hfUserPhotosRoute } from "./hf_user_photos";
import { putHostPhoto } from "./hf_host_photo";
import { handleModerationQueue } from "../lib/hf_user_photos";
import { decidePhoto, decideVideo, readNoulAnswers, retryDelaySeconds, refusalMessage, sweepModerationJobs, MOD_MAX_ATTEMPTS } from "../lib/hf_moderation";
import { validateUserPhoto } from "../lib/hf_user_photos";

function jpeg(w: number, h2: number, pad = 200): Uint8Array {
  const b = new Uint8Array(20 + pad);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h2 >> 8, h2 & 255, w >> 8, w & 255, 0x03], 0);
  return b;
}
const CLEAN = { nudity: 0.02, sexual: 0.01, minor_sexual: 0.01, gore: 0.0, face: 0.97 };

let env: any, digital: Map<string, Uint8Array>, blobs: Map<string, any>, sent: any[], aiAnswer: any, aiCalls: any[];
const store = (m: Map<string, any>) => ({
  put: async (k: string, v: any) => { m.set(k, v instanceof Uint8Array ? v : new Uint8Array(v)); },
  get: async (k: string) => (m.has(k) ? { arrayBuffer: async () => m.get(k).buffer.slice(0) } : null),
  delete: async (k: string) => { m.delete(k); },
});
const call = (path: string, method = "GET", body?: Uint8Array, uid = "fan1") =>
  hfUserPhotosRoute(new Request("https://api.test" + path, { method, headers: { authorization: "Bearer x", "x-uid": uid, "content-type": "image/jpeg" }, body }), env, path);
const runQueue = async (attempts = 1) => {
  const msgs = sent.splice(0).map((body) => ({ body, attempts, acked: false, retried: null as any, ack() { this.acked = true; }, retry(o: any) { this.retried = o; } }));
  await handleModerationQueue({ queue: "hf-mod-photo", messages: msgs } as any, env);
  return msgs;
};
const rows = (sql: string) => env.DB_META._raw.prepare(sql).all();

beforeEach(() => {
  h.events = []; h.cfg = { hfPhotoModerationEnabled: true }; h.admin = false;
  digital = new Map(); blobs = new Map(); sent = []; aiCalls = []; aiAnswer = CLEAN;
  env = {
    DB_META: makeDb(["2026-10-09-hf-hosts.sql", "2026-10-29-hf-moderation.sql"]), BLOSSOM_BASE_URL: "https://media.test",
    DIGITAL: store(digital), BLOBS: store(blobs),
    Q_MOD_PHOTO: { send: async (b: any) => { sent.push(b); } },
    AI: { run: async (model: string, input: any) => {
      aiCalls.push({ model, input });
      if (aiAnswer instanceof Error) throw aiAnswer;
      return { answers: Object.fromEntries(Object.entries(aiAnswer).map(([k, v]) => [k, { type: "noul", noul: v }])), usage: { input_tokens: 700, output_tokens: 0 } };
    } },
  };
  env.DB_META._raw.prepare("INSERT INTO hf_hosts (uid, slug, status, created_at, updated_at) VALUES ('inf1','inf-one','live',1,1)").run();
});

describe("policy v1 (pure)", () => {
  it("photo: nudity, sexual, minor in a sexual way and gore refuse; no face never refuses", () => {
    expect(decidePhoto(CLEAN)).toEqual({ status: "passed", reasons: [], noFace: false });
    expect(decidePhoto({ ...CLEAN, nudity: 0.71 })).toMatchObject({ status: "refused", reasons: ["nudity"] });
    expect(decidePhoto({ ...CLEAN, minor_sexual: 0.5, sexual: 0.9 })).toMatchObject({ status: "refused", reasons: ["minor_sexual", "sexual"] });
    expect(decidePhoto({ ...CLEAN, gore: 0.85 })).toMatchObject({ status: "refused", reasons: ["gore"] });
    expect(decidePhoto({ ...CLEAN, face: 0.1 })).toMatchObject({ status: "passed", noFace: true });
  });
  it("video: flagged beats needs-a-look; child safety is marked", () => {
    const ok = { face: 0.9, nudity: 0.0, sexual: 0.0, minor: 0.05, quality: 0.1 };
    expect(decideVideo(ok)).toMatchObject({ status: "passed" });
    expect(decideVideo({ ...ok, minor: 0.6 })).toMatchObject({ status: "flagged", childSafety: true, reasons: ["minor"] });
    expect(decideVideo({ ...ok, nudity: 0.92, face: 0.1 })).toMatchObject({ status: "flagged", reasons: ["nudity"] });
    expect(decideVideo({ ...ok, face: 0.2 })).toMatchObject({ status: "needs_look", reasons: ["no_face"] });
    expect(decideVideo({ ...ok, quality: 0.8 })).toMatchObject({ status: "needs_look", reasons: ["poor_quality"] });
  });
  it("a missing answer is never a pass; retry delays grow to 8 minutes", () => {
    expect(readNoulAnswers({ nudity: { noul: 0.1 } }, ["nudity", "sexual"])).toBeNull();
    expect(readNoulAnswers(null, ["nudity"])).toBeNull();
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 480]);
    expect(refusalMessage(["nudity"])).toMatch(/nudity or sexual content/);
  });
  it("validates photos: 4 MB cap (Clef limit), bytes sniffed, minimum sizes per kind", () => {
    expect(validateUserPhoto("profile", "image/jpeg", jpeg(400, 400))).toMatchObject({ ok: true });
    expect(validateUserPhoto("cover", "image/jpeg", jpeg(400, 400))).toMatchObject({ ok: false, error: "too_small" });
    expect(validateUserPhoto("profile", "image/png", jpeg(400, 400))).toMatchObject({ ok: false, error: "bad_type" });
    expect(validateUserPhoto("profile", "image/jpeg", jpeg(400, 400, 4 * 1024 * 1024))).toMatchObject({ ok: false, error: "too_big" });
  });
});

describe("fan photo through the queue", () => {
  it("upload -> private + queued; Clef passes -> public, old one replaced", async () => {
    const r = await call("/api/hf/me/photo", "PUT", jpeg(800, 800));
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, status: "checking" });
    expect(sent).toHaveLength(1);
    expect([...digital.keys()][0]).toMatch(/^hf-mod\/pending\/fan1\/profile-hfph_/);
    expect(blobs.size).toBe(0); // never public while checking
    expect((await (await call("/api/hf/me/photos")).json()).photos.profile).toEqual({ url: null, checking: true, refused: null });

    const [m] = await runQueue();
    expect(m.acked).toBe(true);
    expect(aiCalls[0].model).toBe("@cf/cloudflare/clef-flash");
    expect(aiCalls[0].input.images[0]).toMatchObject({ content_type: "image/jpeg" });
    expect(digital.size).toBe(0);
    expect([...blobs.keys()][0]).toMatch(/^hf\/users\/fan1\/profile-hfph_.*\.jpg$/);
    const p = (await (await call("/api/hf/me/photos")).json()).photos.profile;
    expect(p.url).toMatch(/^https:\/\/media\.test\/hf\/users\/fan1\/profile-/);
    expect(p.checking).toBe(false);
    expect(h.events.find((e) => e.event === "hf_photo_check")?.props).toMatchObject({ kind: "profile_photo", verdict: "passed" });

    await call("/api/hf/me/photo", "PUT", jpeg(900, 900));
    await runQueue();
    expect(rows("SELECT status FROM hf_user_photos WHERE kind='profile' ORDER BY created_at").map((x) => x.status)).toEqual(["superseded", "active"]);
  });

  it("Clef refuses -> deleted, never public, the person sees why; the old photo stays", async () => {
    await call("/api/hf/me/cover", "PUT", jpeg(1600, 600));
    await runQueue();
    aiAnswer = { ...CLEAN, nudity: 0.93 };
    await call("/api/hf/me/cover", "PUT", jpeg(1600, 600));
    await runQueue();
    expect(digital.size).toBe(0);
    expect(blobs.size).toBe(1); // only the first, passed cover
    const c = (await (await call("/api/hf/me/photos")).json()).photos.cover;
    expect(c.url).toMatch(/cover-/);
    expect(c.refused).toMatch(/can't be used because it shows nudity/);
    expect(rows("SELECT status FROM hf_moderation_jobs ORDER BY created_at").map((x) => x.status)).toEqual(["passed", "refused"]);
  });

  it("Clef error -> retried with a delay; the 5th failure marks it failed and the photo is never shown", async () => {
    aiAnswer = new Error("429 rate limited");
    await call("/api/hf/me/photo", "PUT", jpeg(800, 800));
    const job = sent[0];
    const [m1] = await runQueue(1);
    expect(m1.acked).toBe(false);
    expect(m1.retried).toEqual({ delaySeconds: 30 });
    expect(rows("SELECT status FROM hf_moderation_jobs")[0].status).toBe("queued");
    sent.push(job);
    const [m5] = await runQueue(MOD_MAX_ATTEMPTS);
    expect(m5.acked).toBe(true);
    expect(rows("SELECT status FROM hf_moderation_jobs")[0].status).toBe("failed");
    expect(rows("SELECT status, reason FROM hf_user_photos")[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/couldn't check/) });
    expect(digital.size).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it("a duplicate message does not check twice", async () => {
    await call("/api/hf/me/photo", "PUT", jpeg(800, 800));
    sent.push(sent[0]);
    await runQueue();
    expect(aiCalls).toHaveLength(1);
  });

  it("queue down at upload: the job waits as 'queued' and the cron sweep sends it later", async () => {
    env.Q_MOD_PHOTO = { send: async () => { throw new Error("queue down"); } };
    const r = await call("/api/hf/me/photo", "PUT", jpeg(800, 800));
    expect(r.status).toBe(202);
    env.Q_MOD_PHOTO = { send: async (b: any) => { sent.push(b); } };
    expect((await sweepModerationJobs(env, Date.now() + 10 * 60_000)).resent).toBe(1);
    await runQueue();
    expect(rows("SELECT status FROM hf_user_photos")[0].status).toBe("active");
  });

  it("switch off -> 404; admin routes need an admin", async () => {
    h.cfg = { hfPhotoModerationEnabled: false };
    expect((await call("/api/hf/me/photo", "PUT", jpeg(800, 800))).status).toBe(404);
    expect((await call("/api/admin/hf/moderation/queue")).status).toBe(403);
    h.admin = true;
    const q = await (await call("/api/admin/hf/moderation/queue")).json();
    expect(q).toMatchObject({ ok: true, counts: [] });
    const t = await (await call("/api/admin/hf/moderation/try", "POST", jpeg(800, 800))).json();
    expect(t).toMatchObject({ ok: true, decision: { status: "passed" }, model: "clef-flash" });
    expect(digital.size + blobs.size).toBe(0); // the try endpoint stores nothing
  });
});

describe("influencer photo with the switch on", () => {
  it("PUT /api/hosts/me/photo answers 202 with the current photo, and Clef's pass makes it the live profile photo", async () => {
    env.DB_META._raw.prepare("INSERT INTO hf_host_media (id, uid, kind, r2_key, status, job_id, created_at) VALUES ('old','inf1','profile','hf/hosts/inf1/old.png','active',NULL,1)").run();
    const res = await putHostPhoto(new Request("https://api.test/api/hosts/me/photo", { method: "PUT", headers: { authorization: "Bearer x", "x-uid": "inf1", "content-type": "image/jpeg" }, body: jpeg(1200, 1500) }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "checking", avatarUrl: "https://media.test/hf/hosts/inf1/old.png" });
    await runQueue();
    const media = rows("SELECT id, status, r2_key FROM hf_host_media ORDER BY created_at");
    expect(media[0]).toMatchObject({ id: "old", status: "superseded" });
    expect(media[1].status).toBe("active");
    expect(media[1].r2_key).toMatch(/^hf\/hosts\/inf1\/profile-\d+\.jpg$/);
  });
});
