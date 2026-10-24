// @ts-nocheck -- uses node:sqlite via the shared D1 shim
// [HF-MERCH-STUDIO-2] AI pictures: one charge per request key, 402 with no charge, automatic refund exactly once, blocked prompts never charge.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { creditLot, balanceSummary } from "./hf_token_ledger";
import { MICRO } from "./hf_token_math";

let cfg: Record<string, unknown> = { hfMerchAiEnabled: true, hfMerchAiChargeRupees: 10 };
vi.mock("../routes/config", () => ({ readConfig: async () => cfg }));
vi.mock("./vertex", () => ({ vertexMediaRequest: async () => ({ ok: false, status: 599, out: {} }) }));
vi.mock("./moderation", () => ({ moderate: async () => ({ safe: true }) }));
vi.mock("./hf_merch_products", () => ({ saveMerchArt: async () => ({ ok: false, status: 500, error: "x", message: "x" }) }));
const tracked: Array<{ event: string; props: any }> = [];
vi.mock("./hf_merch_notify", () => ({
  merchTrack: async (_e: any, _u: string, event: string, props: any) => { tracked.push({ event, props }); },
  merchFail: async () => {},
}));
import { generateAiPicture, buildAiPrompt, refundWalletForAi, aiRefundMarkOpId, aiState, deleteAiPicture, type AiDeps } from "./hf_merch_ai";

const T = (n: number) => Math.round(n * MICRO);
const lot = (env: any, uid: string, kind: "purchase" | "test", tokens: number, op: string) =>
  creditLot(env, uid, { kind, pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: T(tokens), paidPaise: kind === "purchase" ? tokens * 100 : 0, provider: kind === "purchase" ? "cashfree" : "test", providerRef: op }, op);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const body = (k = "key-00000001", extra: Record<string, unknown> = {}) => ({ requestKey: k, prompt: "a lion in Madhubani style", ...extra });
const spendRows = (env: any) => Number(env.DB_META._raw.prepare("SELECT COALESCE(SUM(rupee_value_paise),0) AS n FROM hf_token_ledger WHERE kind='spend' AND lot_id IS NOT NULL AND call_id LIKE 'merchai:%'").get().n); // paise spent
const gens = (env: any) => env.DB_META._raw.prepare("SELECT * FROM hf_merch_ai_gens").all();

let env: any; let calls: number; let deps: AiDeps; let modelOut: any; let saveOut: any; let moderationSafe: boolean;
beforeEach(() => {
  cfg = { hfMerchAiEnabled: true, hfMerchAiChargeRupees: 10 };
  env = { DB_META: makeDb(["2026-10-10-hf-tokens.sql", "2026-10-23-hf-merch-ai-gens.sql"]) };
  env.DB_META._raw.exec("CREATE TABLE studio_designs (id TEXT PRIMARY KEY, created_by TEXT, step TEXT, art_key TEXT, art_mime TEXT, art_bytes INTEGER, art_preview_url TEXT, art_w INTEGER, art_h INTEGER)");
  calls = 0; tracked.length = 0; moderationSafe = true;
  modelOut = { ok: true, bytes: PNG, mime: "image/png", ms: 5 };
  saveOut = null;
  deps = {
    moderatePrompt: async () => ({ safe: moderationSafe }),
    callModel: async () => { calls++; return modelOut; },
    saveArt: async (e: any, uid: string) => saveOut ?? (e.DB_META._raw.prepare("INSERT INTO studio_designs VALUES ('dsn-aaaaaaaa',?,'merch','k','image/png',9,'https://x/a.png',1024,1024)").run(uid), { ok: true, artId: "dsn-aaaaaaaa", url: "https://x/a.png", width: 1024, height: 1024, checks: { ok: true, dpiAtFullWidth: 65, warnings: [] } }),
  };
});

describe("generate: idempotent per request key", () => {
  it("a repeated key returns the first result and charges once", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    const a = await generateAiPicture(env, "u1", body(), deps);
    const b = await generateAiPicture(env, "u1", body(), deps);
    expect(a.ok && b.ok).toBe(true);
    expect(a.body.art.artId).toBe(b.body.art.artId);
    expect(a.body.gen.genId).toBe(b.body.gen.genId);
    expect(a.body.gen.chargedPaise).toBe(1000);
    expect(calls).toBe(1);
    expect(spendRows(env)).toBe(1000);
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000 - 1000);
    expect(gens(env)).toHaveLength(1);
  });
  it("a request still in progress answers 409 in_progress", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    const now = Date.now();
    env.DB_META._raw.prepare("INSERT INTO hf_merch_ai_gens (id,uid,request_key,status,charge_paise,prompt,created_at,updated_at) VALUES ('aig_x','u1','key-00000001','generating',1000,'p',?,?)").run(now, now);
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 409, error: "in_progress" });
    expect(calls).toBe(0);
  });
});

describe("generate: wallet", () => {
  it("not enough paid money -> 402 and no charge, no row, no model call", async () => {
    await lot(env, "u1", "purchase", 5, "p1"); // Rs 5 < Rs 10
    const r = await generateAiPicture(env, "u1", body(), deps);
    expect(r).toMatchObject({ ok: false, status: 402, error: "insufficient_funds", extra: { chargePaise: 1000, balancePaise: 500, shortPaise: 500, testCreditNotUsable: false } });
    expect(r.message).toBe("Making a picture costs ₹10. Your wallet has ₹5 of paid money. Add money to continue.");
    expect(spendRows(env)).toBe(0);
    expect(gens(env)).toHaveLength(0);
    expect(calls).toBe(0);
    expect(tracked.some((t) => t.event === "merch_ai_generate" && t.props.status === "insufficient")).toBe(true);
  });
  it("free test credit never pays", async () => {
    await lot(env, "u1", "test", 1000, "t1");
    const r = await generateAiPicture(env, "u1", body(), deps);
    expect(r).toMatchObject({ ok: false, status: 402, extra: { balancePaise: 0, testCreditNotUsable: true } });
    expect((await balanceSummary(env, "u1")).availableTestPaise).toBe(100_000);
  });
  it("a charge of 0 skips the wallet", async () => {
    cfg.hfMerchAiChargeRupees = 0;
    const r = await generateAiPicture(env, "u1", body(), deps);
    expect(r.ok).toBe(true);
    expect(r.body.gen.chargedPaise).toBe(0);
    expect(spendRows(env)).toBe(0);
  });
  it("AI switched off -> 403 ai_off", async () => {
    cfg.hfMerchAiEnabled = false;
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 403, error: "ai_off" });
  });
});

describe("generate: failure refunds exactly once", () => {
  it("provider error -> refunded, row refunded, second refund credits nothing", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    modelOut = { ok: false, blocked: false, message: "vertex_500: boom", ms: 3 };
    const r = await generateAiPicture(env, "u1", body(), deps);
    expect(r).toMatchObject({ ok: false, status: 502, error: "generation_failed", extra: { refundedPaise: 1000 } });
    expect(r.message).toContain("Your ₹10 is back in your wallet.");
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
    expect(gens(env)[0].status).toBe("refunded");
    const again = await refundWalletForAi(env, "u1", gens(env)[0].id);
    expect(again).toMatchObject({ ok: true, again: true, refundedPaise: 1000 });
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id=?").get(aiRefundMarkOpId(gens(env)[0].id)).n).toBe(1);
  });
  it("model throws -> refunded", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    deps.callModel = async () => { throw new Error("network"); };
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 502, extra: { refundedPaise: 1000 } });
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
  });
  it("provider safety block -> 422 prompt_blocked and refunded", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    modelOut = { ok: false, blocked: true, message: "blocked:SAFETY", ms: 3 };
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 422, error: "prompt_blocked", extra: { refundedPaise: 1000 } });
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
  });
  it("output fails the art scan -> 422 art_blocked and refunded", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    saveOut = { ok: false, status: 422, error: "art_blocked", message: "no" };
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 422, error: "art_blocked", extra: { refundedPaise: 1000 } });
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
  });
  it("a repeat of a refunded request returns the failure, never a second charge", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    modelOut = { ok: false, blocked: false, message: "x", ms: 1 };
    await generateAiPicture(env, "u1", body(), deps);
    const r = await generateAiPicture(env, "u1", body(), deps);
    expect(r).toMatchObject({ ok: false, status: 502, extra: { refundedPaise: 1000 } });
    expect(calls).toBe(1);
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
  });
});

describe("generate: blocked prompt never charges", () => {
  it("moderation says unsafe -> 422, no charge, no row, no model call", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    moderationSafe = false;
    expect(await generateAiPicture(env, "u1", body(), deps)).toMatchObject({ ok: false, status: 422, error: "prompt_blocked", extra: { refundedPaise: 0 } });
    expect(spendRows(env)).toBe(0); expect(gens(env)).toHaveLength(0); expect(calls).toBe(0);
    expect((await balanceSummary(env, "u1")).availablePaidPaise).toBe(50_000);
  });
  it("obvious sexual wording is refused before moderation", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    expect(await generateAiPicture(env, "u1", body("key-00000002", { prompt: "a girl in a bikini" }), deps)).toMatchObject({ ok: false, status: 422, error: "prompt_blocked" });
    expect(spendRows(env)).toBe(0); expect(calls).toBe(0);
  });
});

describe("generate: validation", () => {
  it("bad request key, short prompt, unknown style, too many refs", async () => {
    expect(await generateAiPicture(env, "u1", { requestKey: "x", prompt: "hello world" }, deps)).toMatchObject({ status: 400, error: "invalid_request_key" });
    expect(await generateAiPicture(env, "u1", body("key-00000003", { prompt: "hi" }), deps)).toMatchObject({ status: 400, error: "invalid_prompt" });
    expect(await generateAiPicture(env, "u1", body("key-00000003", { style: "nope" }), deps)).toMatchObject({ status: 400, error: "invalid_style" });
    expect(await generateAiPicture(env, "u1", body("key-00000003", { refArtIds: ["dsn-00000001", "dsn-00000002", "dsn-00000003", "dsn-00000004"] }), deps)).toMatchObject({ status: 400, error: "invalid_refs" });
    expect(await generateAiPicture(env, "u1", body("key-00000003", { refArtIds: ["dsn-00000001"] }), deps)).toMatchObject({ status: 400, error: "ref_not_found" });
    expect(calls).toBe(0);
  });
});

describe("buildAiPrompt", () => {
  it("plain background, style and refs", () => {
    const p = buildAiPrompt({ prompt: "a tiger", style: "warli", plainBackground: true, refCount: 1, isEdit: false });
    expect(p).toContain("a tiger"); expect(p).toContain("#FFFFFF"); expect(p).toContain("Warli"); expect(p).toContain("likeness"); expect(p).toContain("NOT a mockup");
  });
  it("edit keeps the rest and no plain background when off", () => {
    const p = buildAiPrompt({ prompt: "make it blue", style: null, plainBackground: false, refCount: 0, isEdit: true });
    expect(p).toContain("Edit the given image: make it blue"); expect(p).not.toContain("#FFFFFF");
  });
});

describe("[HF-MERCH-AI-DELETE-1] delete an earlier AI picture", () => {
  it("is gone from GET ai for good (a reload does not bring it back), only for its owner, and is idempotent", async () => {
    await lot(env, "u1", "purchase", 500, "p1");
    const a = await generateAiPicture(env, "u1", body(), deps);
    expect(a.ok).toBe(true);
    expect((await aiState(env, "u1")).recent).toHaveLength(1);
    expect(await deleteAiPicture(env, "u2", "dsn-aaaaaaaa")).toMatchObject({ ok: true, removed: 0 }); // someone else's: nothing changes
    expect((await aiState(env, "u1")).recent).toHaveLength(1);
    expect(await deleteAiPicture(env, "u1", "dsn-aaaaaaaa")).toMatchObject({ ok: true, removed: 1 });
    expect((await aiState(env, "u1")).recent).toHaveLength(0);
    expect((await aiState(env, "u1")).recent).toHaveLength(0); // "after refresh"
    expect(await deleteAiPicture(env, "u1", "dsn-aaaaaaaa")).toMatchObject({ ok: true, removed: 0 });
    expect(await deleteAiPicture(env, "u1", "../etc")).toMatchObject({ ok: false, status: 400 });
    const again = await generateAiPicture(env, "u1", body(), deps); // the same request key still answers with its picture, no new charge
    expect(again.ok).toBe(true);
    expect(spendRows(env)).toBe(1000);
  });
});
