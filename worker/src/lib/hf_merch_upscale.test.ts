// @ts-nocheck -- uses node:sqlite via the shared D1 shim
// [HF-MERCH-AI-HIRES-1] Sharp AI merch art: the 4K -> 2K -> no-size chain, the upscale step that never fails a generation, and the free
// "Make it sharper" endpoint (auth by owner, locked source untouched, moderation carried over, 10 a day, kill switch).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "./hf_token_d1_shim";

let cfg: Record<string, unknown> = {};
vi.mock("../routes/config", () => ({ readConfig: async () => cfg }));
const vertexCalls: Array<{ path: string; body: any }> = [];
let vertexAnswers: any[] = [];
vi.mock("./vertex", () => ({
  vertexMediaRequest: async (_env: any, path: string, body: any) => { vertexCalls.push({ path, body }); return vertexAnswers.shift() ?? { ok: false, status: 599, out: {} }; },
}));
vi.mock("./moderation", () => ({ moderate: async () => ({ ok: true, safe: true }), moderateGeneratedImage: async () => ({ ok: true, blocked: false, label: "safe" }) }));
const tracked: Array<{ event: string; props: any }> = [];
vi.mock("./hf_merch_notify", () => ({
  merchTrack: async (_e: any, _u: string, event: string, props: any) => { tracked.push({ event, props }); },
  merchFail: async () => {}, merchPush: async () => {},
}));
import { callImageModel, generateAiPicture, IMAGE_SIZE_CHAIN, type AiDeps } from "./hf_merch_ai";
import { upscaleFactorFor, upscaleForPrint, upscaleMerchArt, UPSCALE_DAILY_LIMIT, type UpscaleDeps } from "./hf_merch_upscale";
import { saveMerchArt } from "./hf_merch_products";

/** A PNG header parseImageInfo can read (colour type 2 = RGB, 6 = RGBA). */
function png(w: number, h: number, ct = 2): Uint8Array {
  const b = new Uint8Array(45);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h); b[24] = 8; b[25] = ct;
  b.set([0, 0, 0, 0, 73, 69, 78, 68], 33); // IEND
  return b;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const imageAnswer = (u: Uint8Array) => ({ ok: true, status: 200, out: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64(u) } }] } }] } });
const bad400 = { ok: false, status: 400, out: { error: { message: "Invalid argument: imageOutputOptions" } } };

function bucket() {
  const m = new Map<string, Uint8Array>();
  return {
    _m: m,
    get: async (k: string) => (m.has(k) ? { size: m.get(k)!.byteLength, arrayBuffer: async () => m.get(k)!.slice().buffer, httpMetadata: {} } : null),
    put: async (k: string, v: Uint8Array) => { m.set(k, new Uint8Array(v)); },
    delete: async (k: string) => { m.delete(k); },
  };
}
function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
}
const DESIGNS = `CREATE TABLE studio_designs (id TEXT PRIMARY KEY, name TEXT, status TEXT, step TEXT, art_key TEXT, art_w INTEGER, art_h INTEGER, art_bytes INTEGER, art_mime TEXT,
  art_checks_json TEXT, art_preview_url TEXT, products_json TEXT, version INTEGER, colours_json TEXT, product_id TEXT, locked_at INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER)`;

let env: any;
beforeEach(() => {
  cfg = { hfMerchAiEnabled: true, hfMerchAiChargeRupees: 0, hfMerchUpscaleEnabled: true };
  vertexCalls.length = 0; vertexAnswers = []; tracked.length = 0;
  env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-23-hf-merch-ai-gens.sql"]), DIGITAL: bucket(), BLOBS: bucket(), TOKENS: kv(), BLOSSOM_BASE_URL: "https://media.example", VERTEX_PROJECT: "p1" };
  env.DB_META._raw.exec(DESIGNS);
});

describe("AI picture size chain: 4K -> 2K -> no size", () => {
  it("asks for 4K as a JPEG first", async () => {
    vertexAnswers = [imageAnswer(png(4096, 4096))];
    const r = await callImageModel(env, [{ text: "a lion" }], "1:1");
    expect(r).toMatchObject({ ok: true, imageSize: "4K" });
    expect(vertexCalls).toHaveLength(1);
    expect(vertexCalls[0].body.generationConfig.imageConfig).toEqual({ aspectRatio: "1:1", imageSize: "4K", imageOutputOptions: { mimeType: "image/jpeg", compressionQuality: 92 } });
  });
  it("each 400 moves one step down the chain", async () => {
    vertexAnswers = [bad400, bad400, imageAnswer(png(2048, 2048))];
    const r = await callImageModel(env, [{ text: "a lion" }], "3:4");
    expect(r).toMatchObject({ ok: true, imageSize: "2K" });
    expect(vertexCalls.map((c) => c.body.generationConfig.imageConfig)).toEqual([
      { aspectRatio: "3:4", imageSize: "4K", imageOutputOptions: { mimeType: "image/jpeg", compressionQuality: 92 } },
      { aspectRatio: "3:4", imageSize: "2K", imageOutputOptions: { mimeType: "image/jpeg", compressionQuality: 92 } },
      { aspectRatio: "3:4", imageSize: "2K" },
    ]);
  });
  it("ends with no size at all, and fails only after the whole chain", async () => {
    vertexAnswers = [bad400, bad400, bad400, bad400];
    const r = await callImageModel(env, [{ text: "a lion" }], "1:1");
    expect(r.ok).toBe(false);
    expect(vertexCalls).toHaveLength(IMAGE_SIZE_CHAIN.length);
    expect(vertexCalls[3].body.generationConfig.imageConfig).toEqual({ aspectRatio: "1:1" });
  });
  it("a timeout or 5xx is never retried (one charge, one try)", async () => {
    vertexAnswers = [{ ok: false, status: 503, out: { error: { message: "busy" } } }];
    const r = await callImageModel(env, [{ text: "a lion" }], "1:1");
    expect(r.ok).toBe(false);
    expect(vertexCalls).toHaveLength(1);
  });
});

describe("upscaleFactorFor", () => {
  it("smallest factor that reaches ~4000 px within Imagen's 17 MP cap", () => {
    expect(upscaleFactorFor(2048, 2048)).toBe(2);   // 4096 x 4096 = 16.8 MP
    expect(upscaleFactorFor(1024, 1024)).toBe(4);   // 1K answer (Vertex sometimes ignores imageSize)
    expect(upscaleFactorFor(896, 1200)).toBe(3);    // x4 would pass 17 MP; x3 is the biggest that fits
    expect(upscaleFactorFor(1792, 2400)).toBe(null); // x2 = 17.2 MP: over the cap
    expect(upscaleFactorFor(4096, 4096)).toBe(null); // already big enough
    expect(upscaleFactorFor(0, 10)).toBe(null);
  });
});

describe("upscaleForPrint", () => {
  const ok = (w: number, h: number): UpscaleDeps => ({ callModel: async () => ({ ok: true, bytes: png(w, h) }) });
  it("returns the bigger picture", async () => {
    const r = await upscaleForPrint(env, png(2048, 2048), { model: "m" }, ok(4096, 4096));
    expect(r).toMatchObject({ ok: true, w: 4096, h: 4096, fromW: 2048, factor: 2 });
  });
  it("keeps the original for every kind of failure", async () => {
    expect(await upscaleForPrint(env, png(2048, 2048), { model: "m" }, { callModel: async () => ({ ok: false, reason: "vertex_404: not found" }) })).toMatchObject({ ok: false, reason: "vertex_404: not found" });
    expect(await upscaleForPrint(env, png(2048, 2048), { model: "m" }, { callModel: async () => { throw new Error("boom"); } })).toMatchObject({ ok: false, reason: "error:boom" });
    expect(await upscaleForPrint(env, png(2048, 2048), { model: "m" }, ok(2048, 2048))).toMatchObject({ ok: false, reason: "not_bigger" });
    expect(await upscaleForPrint(env, png(2048, 2048), { model: "m" }, ok(4096, 3000))).toMatchObject({ ok: false, reason: "shape_changed" });
    expect(await upscaleForPrint(env, png(2048, 2048, 6), { model: "m" }, ok(4096, 4096))).toMatchObject({ ok: false, reason: "alpha_lost" });
    expect(await upscaleForPrint(env, png(4096, 4096), { model: "m" }, ok(8192, 8192))).toMatchObject({ ok: false, reason: "not_needed" });
  });
  it("times out instead of hanging", async () => {
    const r = await upscaleForPrint(env, png(2048, 2048), { model: "m", timeoutMs: 1 }, { callModel: () => new Promise(() => {}) });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  }, 10_000);
  it("calls Imagen on us-central1 with mode upscale and the factor; a cut-out asks for PNG", async () => {
    vertexAnswers = [{ ok: true, status: 200, out: { predictions: [{ mimeType: "image/png", bytesBase64Encoded: b64(png(4096, 4096, 6)) }] } }];
    const r = await upscaleForPrint(env, png(2048, 2048, 6), { model: "imagen-4.0-upscale-preview" });
    expect(r.ok).toBe(true);
    expect(vertexCalls[0].path).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/imagen-4.0-upscale-preview:predict");
    expect(vertexCalls[0].body.parameters).toEqual({ mode: "upscale", upscaleConfig: { upscaleFactor: "x2" }, outputOptions: { mimeType: "image/png" } });
  });
});

describe("generate: the upscale step never fails a generation", () => {
  const body = (k: string) => ({ requestKey: k, prompt: "a lion in Madhubani style" });
  function deps(up: AiDeps["upscale"], saveFails: (bytes: Uint8Array) => boolean = () => false) {
    const saved: Uint8Array[] = [];
    const d: AiDeps = {
      moderatePrompt: async () => ({ safe: true }),
      callModel: async () => ({ ok: true, bytes: png(2048, 2048), mime: "image/png", ms: 5, imageSize: "2K" }),
      saveArt: async (e: any, uid: string, bytes: Uint8Array) => {
        saved.push(bytes);
        if (saveFails(bytes)) return { ok: false, status: 413, error: "too_large", message: "x" };
        const id = `dsn-${String(saved.length).padStart(8, "0")}`;
        const w = new DataView(bytes.buffer).getUint32(16);
        e.DB_META._raw.prepare("INSERT INTO studio_designs (id, created_by, step, art_key, art_preview_url, art_w, art_h) VALUES (?,?,'merch','k','https://x/a.png',?,?)").run(id, uid, w, w);
        return { ok: true, artId: id, url: "https://x/a.png", width: w, height: w, checks: { ok: true, dpiAtFullWidth: Math.round(w / 15.6), warnings: [] } };
      },
      upscale: up,
    };
    return { d, saved };
  }
  it("stores the upscaled picture as the art", async () => {
    const { d, saved } = deps(async (e, bytes) => upscaleForPrint(e, bytes, { model: "m" }, { callModel: async () => ({ ok: true, bytes: png(4096, 4096) }) }));
    const r = await generateAiPicture(env, "u1", body("key-up-00001"), d);
    expect(r.ok).toBe(true);
    expect(r.body.art.width).toBe(4096);
    expect(saved).toHaveLength(1);
    expect(tracked.find((t) => t.event === "merch_art_upscaled")?.props).toMatchObject({ ok: true, from_w: 2048, to_w: 4096, stage: "generate" });
  });
  it("model fails -> the original is kept, the reason is recorded, the picture is still made", async () => {
    const { d, saved } = deps(async (e, bytes) => upscaleForPrint(e, bytes, { model: "m" }, { callModel: async () => ({ ok: false, reason: "vertex_404: model not found" }) }));
    const r = await generateAiPicture(env, "u1", body("key-up-00002"), d);
    expect(r.ok).toBe(true);
    expect(r.body.art.width).toBe(2048);
    expect(saved).toHaveLength(1);
    expect(tracked.find((t) => t.event === "merch_art_upscaled")?.props).toMatchObject({ ok: false, from_w: 2048, to_w: 2048, reason: "vertex_404: model not found" });
  });
  it("an upscale that throws is caught too", async () => {
    const { d } = deps(async () => { throw new Error("isolate"); });
    const r = await generateAiPicture(env, "u1", body("key-up-00003"), d);
    expect(r.ok).toBe(true);
    expect(r.body.art.width).toBe(2048);
  });
  it("the bigger copy cannot be stored -> the original is stored instead", async () => {
    const { d, saved } = deps(async (e, bytes) => upscaleForPrint(e, bytes, { model: "m" }, { callModel: async () => ({ ok: true, bytes: png(4096, 4096) }) }),
      (bytes) => new DataView(bytes.buffer).getUint32(16) === 4096);
    const r = await generateAiPicture(env, "u1", body("key-up-00004"), d);
    expect(r.ok).toBe(true);
    expect(r.body.art.width).toBe(2048);
    expect(saved).toHaveLength(2);
  });
});

describe("POST art/:id/upscale (Make it sharper)", () => {
  const put = (id: string, uid: string, w: number, h: number, extra: Record<string, unknown> = {}) => {
    const key = `merch/${uid}/${id}/art-1.png`;
    env.DIGITAL._m.set(key, png(w, h));
    env.DB_META._raw.prepare(`INSERT INTO studio_designs (id, name, status, step, art_key, art_w, art_h, art_bytes, art_mime, art_checks_json, art_preview_url, products_json, version, colours_json, product_id, locked_at, created_by, created_at, updated_at)
      VALUES (?, 'Merch art', 'draft', 'merch', ?, ?, ?, 45, 'image/png', ?, 'https://media.example/a.png', '[]', 1, '[]', ?, ?, ?, 1, 1)`)
      .run(id, key, w, h, JSON.stringify({ moderation: "ok", w, h }), extra.product_id ?? null, extra.locked_at ?? null, uid);
  };
  const row = (id: string) => env.DB_META._raw.prepare("SELECT * FROM studio_designs WHERE id=?").get(id);
  const count = () => Number(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM studio_designs").get().n);
  const x2: UpscaleDeps = { callModel: async (_e, bytes, f) => { const dv = new DataView(bytes.buffer, bytes.byteOffset); return { ok: true, bytes: png(dv.getUint32(16) * f, dv.getUint32(20) * f) }; } };

  it("makes a new, bigger row for the owner; a locked original is untouched; moderation is carried over", async () => {
    put("dsn-aaaaaaaa", "u1", 2048, 2048, { product_id: "prd_1", locked_at: 123 });
    const before = row("dsn-aaaaaaaa");
    const r = await upscaleMerchArt(env, "u1", "dsn-aaaaaaaa", x2);
    expect(r).toMatchObject({ ok: true, fromW: 2048, toW: 4096, art: { width: 4096, height: 4096 } });
    expect(r.art.artId).not.toBe("dsn-aaaaaaaa");
    expect(row("dsn-aaaaaaaa")).toEqual(before);
    const n = row(r.art.artId);
    expect(n).toMatchObject({ created_by: "u1", step: "merch", art_w: 4096, art_h: 4096, product_id: null, locked_at: null, status: "draft" });
    expect(JSON.parse(n.art_checks_json)).toMatchObject({ moderation: "ok", upscaled_from: "dsn-aaaaaaaa", upscale_factor: 2, w: 4096 });
    expect(env.DIGITAL._m.has(n.art_key)).toBe(true);
    expect(r.art.url.startsWith("https://media.example/u/u1/public/merch/")).toBe(true);
    expect(r.art.checks.warnings).toEqual([]);
    expect(tracked.find((t) => t.event === "merch_art_upscaled")?.props).toMatchObject({ ok: true, from_w: 2048, to_w: 4096, stage: "button" });
  });
  it("another user's picture, a bad id or a missing file is 404", async () => {
    put("dsn-aaaaaaaa", "u1", 2048, 2048);
    expect(await upscaleMerchArt(env, "u2", "dsn-aaaaaaaa", x2)).toMatchObject({ ok: false, status: 404 });
    expect(await upscaleMerchArt(env, "u1", "../etc", x2)).toMatchObject({ ok: false, status: 404 });
    expect(count()).toBe(1);
  });
  it("a picture that is already big enough is 409 and costs nothing", async () => {
    put("dsn-bbbbbbbb", "u1", 4096, 4096);
    let called = 0;
    expect(await upscaleMerchArt(env, "u1", "dsn-bbbbbbbb", { callModel: async () => { called++; return { ok: false, reason: "x" }; } })).toMatchObject({ ok: false, status: 409, error: "already_sharp" });
    expect(called).toBe(0);
  });
  it(`allows ${UPSCALE_DAILY_LIMIT} a day, then 429`, async () => {
    put("dsn-aaaaaaaa", "u1", 2048, 2048);
    for (let i = 0; i < UPSCALE_DAILY_LIMIT; i++) expect((await upscaleMerchArt(env, "u1", "dsn-aaaaaaaa", x2)).ok).toBe(true);
    expect(await upscaleMerchArt(env, "u1", "dsn-aaaaaaaa", x2)).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
    put("dsn-cccccccc", "u2", 2048, 2048);
    expect((await upscaleMerchArt(env, "u2", "dsn-cccccccc", x2)).ok).toBe(true); // per user
  });
  it("the model fails -> 502, no new row, original untouched", async () => {
    put("dsn-aaaaaaaa", "u1", 2048, 2048);
    const r = await upscaleMerchArt(env, "u1", "dsn-aaaaaaaa", { callModel: async () => ({ ok: false, reason: "vertex_500: internal" }) });
    expect(r).toMatchObject({ ok: false, status: 502, error: "upscale_failed" });
    expect(count()).toBe(1);
    expect(tracked.find((t) => t.event === "merch_art_upscaled")?.props).toMatchObject({ ok: false, reason: "vertex_500: internal" });
  });
  it("kill switch hfMerchUpscaleEnabled=false -> 403", async () => {
    cfg.hfMerchUpscaleEnabled = false;
    put("dsn-aaaaaaaa", "u1", 2048, 2048);
    expect(await upscaleMerchArt(env, "u1", "dsn-aaaaaaaa", x2)).toMatchObject({ ok: false, status: 403, error: "upscale_off" });
  });
});

describe("saveMerchArt: art over 4 MB is scanned from a small copy", () => {
  const big = () => { const b = new Uint8Array(4.5 * 1024 * 1024); b.set(png(4096, 4096)); return b; };
  it("a clean big picture is stored as moderation ok", async () => {
    const seen: string[] = [];
    const r = await saveMerchArt(env, "u1", big(), "image/png", "ai.png", async (_e, _u, url) => { seen.push(url); return { moderation: "ok", blocked: false, source: url }; });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([r.url]);
    expect(JSON.parse(env.DB_META._raw.prepare("SELECT art_checks_json AS j FROM studio_designs WHERE id=?").get(r.artId).j).moderation).toBe("ok");
  });
  it("a blocked big picture is refused and its files are removed", async () => {
    const r = await saveMerchArt(env, "u1", big(), "image/png", "ai.png", async (_e, _u, url) => ({ moderation: "blocked", blocked: true, label: "nsfw", source: url }));
    expect(r).toMatchObject({ ok: false, status: 422, error: "art_blocked" });
    expect(env.DIGITAL._m.size).toBe(0);
    expect(env.BLOBS._m.size).toBe(0);
  });
  it("a scan that cannot run stays unscanned (admin reviews it)", async () => {
    const r = await saveMerchArt(env, "u1", big(), "image/png", "ai.png", async () => { throw new Error("x"); });
    expect(r.ok).toBe(true);
    expect(r.checks.warnings).toContain("This image will be checked by our team before it goes on sale.");
  });
});
