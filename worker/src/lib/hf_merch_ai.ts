// [HF-MERCH-STUDIO-2 2026-10-23] "Create with AI" pictures and the background remover for the merch studio. Spec: Specs/SPEC-2026-10-23-HF-MERCH-STUDIO-2.md section 3.
// Every AI picture costs a FIXED admin-set charge (hfMerchAiChargeRupees) taken from PURCHASE lots only (free test credit never pays), and is
// refunded automatically, exactly once, when anything fails after the charge. The result is stored with saveMerchArt, so it is a normal merch art
// ("My art" tray) and the rest of the flow (product, design, price) is unchanged.
// Wallet: call id `merchai:<genId>`, op ids `hfmai:<genId>:p|t|mark` (mirrors hf_merch_wallet.ts, which is for orders).
// State machine: charging -> generating -> done | refunded | failed. A row stuck in charging/generating (isolate killed) is refunded by the stale sweep.
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { vertexMediaRequest } from "./vertex";
import { moderate } from "./moderation";
import { balanceSummary, creditLot, hasOpenDebt, settleCall } from "./hf_token_ledger";
import { paiseToMicro, RUPEE_LOT_VALUE_PAISE } from "./hf_token_math";
import { parseImageInfo } from "./studio_logic";
import { saveMerchArt, type ArtResult, type PFail } from "./hf_merch_products";
import { merchFail, merchTrack } from "./hf_merch_notify";
import { upscaleConfig, upscaleForPrint, type UpscaleOut } from "./hf_merch_upscale";

export const AI_MODEL = "gemini-3.1-flash-image";
export const AI_ASPECTS = ["1:1", "3:4", "4:3", "9:16"] as const;
export const AI_STYLES: Record<string, string> = {
  bollywood_poster: "a hand-painted vintage Bollywood movie poster, bold dramatic colours, painted look",
  madhubani: "Madhubani folk painting from Bihar, fine line work, intricate patterns, natural earthy colours",
  warli: "Warli tribal art, simple white geometric figures, mud-brown background feel, stick-figure style",
  kalamkari: "Kalamkari hand-painted textile art, floral and mythological motifs, rich natural dyes",
  pop_art: "bold pop art, thick outlines, halftone dots, bright flat colours",
  truck_art: "Indian truck art, vivid decorative painting, flowers, bright colours, ornamental borders and patterns",
  watercolour: "soft watercolour painting, gentle washes, hand-painted feel",
  line_art: "clean continuous black line art, minimal, no fill",
  retro_70s: "1970s retro style, warm sunset colours, groovy shapes, vintage print feel",
  typography: "bold typographic design where the words are the artwork, strong lettering",
  clay_3d: "cute 3D clay render, soft lighting, smooth rounded shapes",
  photo_real: "realistic photographic look, natural detail, sharp focus",
};
export const MAX_AI_REFS = 3;
/** Inline images go in the request body: bigger pictures are skipped (refs) or refused (the picture being edited). */
export const AI_REF_MAX_BYTES = 7 * 1024 * 1024;
const STALE_MS = 4 * 60_000;
const VERTEX_TIMEOUT_MS = 120_000;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const ART_ID = /^dsn-[a-f0-9]{8}$/;

const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): PFail => ({ ok: false, status, error, message, extra });
export const inr = (paise: number): string => { const r = paise / 100; return `₹${Number.isInteger(r) ? r : r.toFixed(2)}`; };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export async function aiConfig(env: Env): Promise<{ flag: boolean; chargeRupees: number; chargePaise: number }> {
  const c = (await readConfig(env)) as unknown as Record<string, unknown>;
  const n = Number(c.hfMerchAiChargeRupees);
  const chargeRupees = Number.isInteger(n) && n >= 0 && n <= 500 ? n : 10;
  return { flag: c.hfMerchAiEnabled !== false, chargeRupees, chargePaise: chargeRupees * 100 };
}
/** False when the migration has not been applied yet: callers answer 503 ai_unavailable instead of crashing. */
export async function aiTableOk(env: Env): Promise<boolean> {
  try { await metaDb(env).prepare("SELECT 1 AS x FROM hf_merch_ai_gens LIMIT 1").first(); return true; } catch { return false; }
}
export const AI_UNAVAILABLE = () => fail(503, "ai_unavailable", "Picture making is not ready yet. Please try again later.");

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
export function buildAiPrompt(o: { prompt: string; style?: string | null; plainBackground: boolean; refCount: number; isEdit: boolean }): string {
  const idea = o.prompt.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  if (o.isEdit) {
    lines.push(`Edit the given image: ${idea}. Keep everything else the same: the same subject, composition and colours, except what this change asks for.`);
  } else {
    lines.push(`Create print-ready artwork for merchandise (T-shirts, hoodies, mugs, posters, phone cases) sold in India. The idea: ${idea}.`);
  }
  if (o.refCount > 0) lines.push(`Use the person or artwork in the reference image${o.refCount > 1 ? "s" : ""}. Keep the person's face and likeness recognisable.`);
  lines.push(
    "Make one single centred subject or composition that fills most of the frame. This is the artwork itself and NOT a mockup: do not show any T-shirt, hoodie, mug, poster frame, phone, bag or model wearing it, and no product of any kind. No frame, no border, no watermark, no signature, no logo.",
    "Do not add any text, letters or numbers unless the idea asks for words. If it does, write exactly those words, spelled correctly and clearly.",
  );
  const style = o.style ? AI_STYLES[o.style] : null;
  if (style) lines.push(`Style: ${style}.`);
  if (o.plainBackground) lines.push("Put it on a perfectly plain flat pure white (#FFFFFF) background, with no shadow, no gradient, no texture and crisp clean edges, so the background can be removed easily.");
  return lines.join("\n");
}

/** Obvious sexual wording is refused before any charge (same backstop as ava_image). The model gate in moderate() handles the rest. */
export const obviousSexualPrompt = (p: string): boolean => /\b(bikini|bikinis|lingerie|underwear|nude|naked|topless|sexually?\s+explicit)\b/i.test(p);

// ---------------------------------------------------------------------------
// Wallet (purchase lots only)
// ---------------------------------------------------------------------------
export const aiCallId = (genId: string) => `merchai:${genId}`;
export const aiRefundPaidOpId = (genId: string) => `hfmai:${genId}:p`;
export const aiRefundTestOpId = (genId: string) => `hfmai:${genId}:t`;
export const aiRefundMarkOpId = (genId: string) => `hfmai:${genId}:mark`;
const NOMINAL_RATE_PAISE_PER_MIN = 100;

export type AiSpend =
  | { ok: true; again: boolean; spentPaise: number }
  | { ok: false; reason: "insufficient"; shortPaise: number; balancePaise: number; testCreditNotUsable: boolean }
  | { ok: false; reason: "debt" | "conflict" | "invalid" };

export async function spendWalletForAi(env: Env, uid: string, genId: string, amountPaise: number): Promise<AiSpend> {
  const amt = Math.trunc(amountPaise);
  if (!(amt > 0)) return { ok: false, reason: "invalid" };
  const callId = aiCallId(genId);
  const already = await env.DB_META.prepare("SELECT rupee_value_paise AS v FROM hf_token_ledger WHERE op_id=?1").bind(`hftset:${callId}`).first<{ v: number }>();
  if (already) {
    const refunded = await env.DB_META.prepare("SELECT 1 AS x FROM hf_token_ledger WHERE op_id=?1").bind(aiRefundMarkOpId(genId)).first();
    if (!refunded && Number(already.v) >= amt) return { ok: true, again: true, spentPaise: Number(already.v) };
    return { ok: false, reason: "conflict" };
  }
  if (await hasOpenDebt(env, uid)) return { ok: false, reason: "debt" };
  const short = async (): Promise<AiSpend> => {
    const b = await balanceSummary(env, uid);
    return { ok: false, reason: "insufficient", shortPaise: Math.max(1, amt - b.availablePaidPaise), balancePaise: b.availablePaidPaise, testCreditNotUsable: b.availableTestPaise > 0 };
  };
  const bal = await balanceSummary(env, uid);
  if (bal.availablePaidPaise < amt) return short();
  const r = await settleCall(env, uid, callId, NOMINAL_RATE_PAISE_PER_MIN, 0, { fixedValuePaise: amt, onlyKind: "purchase" });
  if (!r.ok) return { ok: false, reason: r.reason === "invalid" ? "invalid" : "conflict" };
  if (r.shortfall || r.totalValuePaise < amt) { await refundWalletForAi(env, uid, genId); return short(); }
  return { ok: true, again: r.again, spentPaise: r.totalValuePaise };
}

async function walletSpentForAi(env: Env, genId: string): Promise<{ paidPaise: number; testPaise: number }> {
  const rows = (await env.DB_META.prepare(
    `SELECT t.kind AS kind, COALESCE(SUM(l.rupee_value_paise),0) AS v
       FROM hf_token_ledger l JOIN hf_token_lots t ON t.id=l.lot_id
      WHERE l.call_id=?1 AND l.kind='spend' AND l.lot_id IS NOT NULL GROUP BY t.kind`,
  ).bind(aiCallId(genId)).all<{ kind: string; v: number }>()).results ?? [];
  let paid = 0, test = 0;
  for (const r of rows) { if (r.kind === "purchase") paid += Number(r.v); else test += Number(r.v); }
  return { paidPaise: paid, testPaise: test };
}

export type AiRefund = { ok: true; again: boolean; refundedPaise: number } | { ok: false; reason: "nothing_spent" | "wallet_error" };
/** Idempotent: the credits carry fixed op ids, so a second call returns the first result and credits nothing more. */
export async function refundWalletForAi(env: Env, uid: string, genId: string): Promise<AiRefund> {
  const { paidPaise, testPaise } = await walletSpentForAi(env, genId);
  if (paidPaise + testPaise <= 0) return { ok: false, reason: "nothing_spent" };
  const callId = aiCallId(genId);
  const credit = async (kind: "purchase" | "test", paise: number, opId: string) => paise > 0
    ? creditLot(env, uid, {
      kind, pricingVersion: "gp-r2", valuePaisePerToken: RUPEE_LOT_VALUE_PAISE, micro: paiseToMicro(paise), paidPaise: 0,
      provider: "merch_ai_refund", providerRef: opId, note: `merchai_refund:${genId};${kind}=${paise}`, sourceLotId: callId,
    }, opId)
    : { applied: false, lotId: null as string | null };
  const p = await credit("purchase", paidPaise, aiRefundPaidOpId(genId));
  const t = await credit("test", testPaise, aiRefundTestOpId(genId));
  if ((paidPaise > 0 && !p.lotId) || (testPaise > 0 && !t.lotId)) return { ok: false, reason: "wallet_error" };
  const lotId = p.lotId ?? t.lotId;
  await env.DB_META.prepare(
    `INSERT OR IGNORE INTO hf_token_ledger (id, uid, kind, lot_id, delta_micro, rupee_value_paise, call_id, purchase_id, op_id, note, created_at)
     VALUES (?1,?2,'call_refund',?3,0,?4,?5,NULL,?6,?7,?8)`,
  ).bind(crypto.randomUUID(), uid, lotId, paidPaise + testPaise, callId, aiRefundMarkOpId(genId), `merchai_refund:${genId}`, Date.now()).run();
  return { ok: true, again: !(p.applied || t.applied), refundedPaise: paidPaise + testPaise };
}

// ---------------------------------------------------------------------------
// Model call (Vertex Nano Banana 2)
// ---------------------------------------------------------------------------
export type AiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export type ModelOut = { ok: true; bytes: Uint8Array; mime: string; ms: number; imageSize?: string | null } | { ok: false; blocked: boolean; message: string; ms: number };

/**
 * [HF-MERCH-AI-HIRES-1] What we ask the model for, best first. gemini-3.1-flash-image makes 512 / 1K / 2K / 4K (4K is GA on Vertex since
 * 2026-08-31, ~16 MP, 2,520 output tokens vs 1,680 for 2K). 4K comes back as a quality-92 JPEG (imageConfig.imageOutputOptions) so the file stays
 * well under the 15 MB art limit; a PNG 4K would not. Each step is tried only when the one before answered 400 (an option not accepted).
 */
export const IMAGE_SIZE_CHAIN: ReadonlyArray<{ imageSize: "4K" | "2K" | null; jpeg: boolean }> = [
  { imageSize: "4K", jpeg: true },
  { imageSize: "2K", jpeg: true },
  { imageSize: "2K", jpeg: false },
  { imageSize: null, jpeg: false },
];
export function imageConfigFor(aspect: string, step: { imageSize: string | null; jpeg: boolean }): Record<string, unknown> {
  return {
    aspectRatio: aspect,
    ...(step.imageSize ? { imageSize: step.imageSize } : {}),
    ...(step.jpeg ? { imageOutputOptions: { mimeType: "image/jpeg", compressionQuality: 92 } } : {}),
  };
}

export function b64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const bytesOfB64 = (b64: string): Uint8Array => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const BLOCK_REASON = /SAFETY|PROHIBITED|BLOCKLIST|SPII|IMAGE_SAFETY|BLOCKED/i;

export async function callImageModel(env: Env, parts: AiPart[], aspect: string): Promise<ModelOut> {
  const t0 = Date.now();
  const run = (step: (typeof IMAGE_SIZE_CHAIN)[number]) => vertexMediaRequest(env, `/publishers/google/models/${AI_MODEL}:generateContent`, {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: imageConfigFor(aspect, step) },
  }, { timeoutMs: VERTEX_TIMEOUT_MS });
  // [HF-MERCH-AI-HIRES-1] 4K JPEG -> 2K JPEG -> 2K -> no size. Only a 400 (an option this endpoint does not accept) moves down the chain;
  // timeouts, 5xx and safety blocks are never retried (one charge = at most one real picture).
  let used: (typeof IMAGE_SIZE_CHAIN)[number] = IMAGE_SIZE_CHAIN[0];
  let r = await run(used);
  for (let i = 1; i < IMAGE_SIZE_CHAIN.length && !r.ok && r.status === 400; i++) { used = IMAGE_SIZE_CHAIN[i]; r = await run(used); }
  const ms = Date.now() - t0;
  const cand = r.out?.candidates?.[0];
  const imagePart = (cand?.content?.parts ?? []).find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
  const data = imagePart?.inlineData?.data ?? imagePart?.inline_data?.data;
  if (r.ok && data) {
    const bytes = bytesOfB64(String(data));
    const info = parseImageInfo(bytes);
    if (info && (info.mime === "image/png" || info.mime === "image/jpeg")) return { ok: true, bytes, mime: info.mime, ms, imageSize: used.imageSize };
    return { ok: false, blocked: false, message: "unreadable_image", ms };
  }
  const block = String(r.out?.promptFeedback?.blockReason ?? "") || String(cand?.finishReason ?? "");
  if (BLOCK_REASON.test(block)) return { ok: false, blocked: true, message: `blocked:${block}`.slice(0, 120), ms };
  return { ok: false, blocked: false, message: `vertex_${r.status}: ${String(r.out?.error?.message ?? "no image returned").slice(0, 160)}`, ms };
}

export type AiDeps = {
  moderatePrompt: (env: Env, text: string) => Promise<{ safe: boolean }>;
  callModel: (env: Env, parts: AiPart[], aspect: string) => Promise<ModelOut>;
  saveArt: (env: Env, uid: string, bytes: Uint8Array, mime: string, fileName: string) => Promise<ArtResult | PFail>;
  /** [HF-MERCH-AI-HIRES-1] Makes a small picture print-sized. Left out = no upscale step. */
  upscale?: (env: Env, bytes: Uint8Array) => Promise<UpscaleOut>;
};
/** [HF-MERCH-AI-HIRES-1] The upscale step after a generation: time-limited (45 s), never throws. */
export async function upscaleAfterGenerate(env: Env, bytes: Uint8Array): Promise<UpscaleOut> {
  const c = await upscaleConfig(env);
  if (!c.enabled) return { ok: false, reason: "switched_off", fromW: 0, fromH: 0, ms: 0 };
  return upscaleForPrint(env, bytes, { model: c.model, timeoutMs: 45_000 });
}
export const DEFAULT_AI_DEPS: AiDeps = {
  moderatePrompt: async (env, text) => { const v = await moderate(env, { text, field: "vertex_image_prompt" }); return { safe: v.safe }; },
  callModel: callImageModel,
  saveArt: saveMerchArt,
  upscale: upscaleAfterGenerate,
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
type GenRow = { id: string; uid: string; request_key: string; status: string; charge_paise: number; prompt: string; style: string | null; result_art_id: string | null; error: string | null; created_at: number; updated_at: number };
const GEN_COLS = "id, uid, request_key, status, charge_paise, prompt, style, result_art_id, error, created_at, updated_at";
const hex12 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function setStatus(env: Env, id: string, status: string, error: string | null, resultArtId?: string): Promise<void> {
  await metaDb(env).prepare("UPDATE hf_merch_ai_gens SET status=?2, error=?3, result_art_id=COALESCE(?4, result_art_id), updated_at=?5 WHERE id=?1")
    .bind(id, status, error ? error.slice(0, 300) : null, resultArtId ?? null, Date.now()).run();
}

export type ArtOut = { artId: string; url: string; width: number; height: number; checks: { ok: boolean; dpiAtFullWidth: number; warnings: string[] } };
async function artOf(env: Env, uid: string, artId: string): Promise<ArtOut | null> {
  const d = await metaDb(env).prepare("SELECT id, art_preview_url AS url, art_w AS w, art_h AS h FROM studio_designs WHERE id=?1 AND created_by=?2 AND step='merch'").bind(artId, uid).first<{ id: string; url: string | null; w: number | null; h: number | null }>();
  if (!d || !d.url) return null;
  return { artId: d.id, url: d.url, width: Number(d.w ?? 0), height: Number(d.h ?? 0), checks: { ok: true, dpiAtFullWidth: Math.round(Number(d.w ?? 0) / 15.6), warnings: [] } };
}

/** Give the charge back and close the row. Returns the paise actually returned (0 when nothing had been charged). Never throws. */
async function refundAndClose(env: Env, uid: string, row: { id: string; chargePaise: number }, code: string): Promise<number> {
  let refunded = 0;
  try {
    if (row.chargePaise > 0) {
      const r = await refundWalletForAi(env, uid, row.id);
      if (r.ok) refunded = r.refundedPaise;
      else if (r.reason === "wallet_error") { await merchFail(env, new Error("merch_ai_refund_failed"), "ai_refund", uid, { gen_id: row.id, charge_paise: row.chargePaise }); await setStatus(env, row.id, "failed", `refund_failed:${code}`); return 0; }
    }
    await setStatus(env, row.id, refunded > 0 ? "refunded" : "failed", code);
  } catch (e) { await merchFail(env, e, "ai_refund", uid, { gen_id: row.id }); }
  return refunded;
}

/** Rows left in charging/generating by a killed request are refunded here (called from GET ai and from a repeated request). */
export async function sweepStaleGens(env: Env, uid: string): Promise<number> {
  let n = 0;
  try {
    const rows = (await metaDb(env).prepare(`SELECT id, charge_paise FROM hf_merch_ai_gens WHERE uid=?1 AND status IN ('charging','generating') AND updated_at<?2 LIMIT 5`).bind(uid, Date.now() - STALE_MS).all<{ id: string; charge_paise: number }>()).results ?? [];
    for (const r of rows) { await refundAndClose(env, uid, { id: r.id, chargePaise: Number(r.charge_paise) }, "stale"); await merchTrack(env, uid, "merch_ai_generate", { status: "refunded", gen_id: r.id, reason: "stale" }); n++; }
  } catch (e) { await merchFail(env, e, "ai_sweep", uid); }
  return n;
}

// ---------------------------------------------------------------------------
// GET ai
// ---------------------------------------------------------------------------
export async function aiState(env: Env, uid: string): Promise<Record<string, unknown>> {
  const cfg = await aiConfig(env);
  const tableOk = await aiTableOk(env);
  const enabled = cfg.flag && tableOk;
  const bal = await balanceSummary(env, uid);
  let recent: Array<Record<string, unknown>> = [];
  if (tableOk) {
    await sweepStaleGens(env, uid);
    const rows = (await metaDb(env).prepare(
      // [HF-MERCH-ART-REUSE-1] Only real AI source pictures: the row the generator saved, with its art bytes, a size and a public preview.
      // Print files, cutouts, uploads and reuse copies are never AI gens, so they never show here; one tile per picture.
      `SELECT MAX(g.id) AS id, g.result_art_id AS art_id, MAX(g.prompt) AS prompt, MAX(g.style) AS style, MAX(g.created_at) AS created_at, d.art_preview_url AS url, d.art_w AS w, d.art_h AS h
         FROM hf_merch_ai_gens g JOIN studio_designs d ON d.id=g.result_art_id AND d.created_by=g.uid
        WHERE g.uid=?1 AND g.status='done' AND d.step='merch' AND d.art_key IS NOT NULL AND d.art_w > 0 AND d.art_h > 0 AND d.art_preview_url LIKE 'http%'
        GROUP BY g.result_art_id ORDER BY MAX(g.created_at) DESC LIMIT 24`,
    ).bind(uid).all<{ id: string; art_id: string; prompt: string; style: string | null; created_at: number; url: string; w: number; h: number }>()).results ?? [];
    recent = rows.map((r) => ({ genId: r.id, artId: r.art_id, url: r.url, width: Number(r.w), height: Number(r.h), prompt: r.prompt, style: r.style, createdAt: Number(r.created_at) }));
  }
  const up = await upscaleConfig(env);
  return {
    enabled, upscaleEnabled: up.enabled, chargePaise: cfg.chargePaise, chargeRupees: cfg.chargeRupees, balancePaise: bal.availablePaidPaise, testCreditPaise: bal.availableTestPaise,
    canAfford: cfg.chargePaise === 0 || bal.availablePaidPaise >= cfg.chargePaise, recent,
  };
}

// ---------------------------------------------------------------------------
// POST ai/generate
// ---------------------------------------------------------------------------
export type AiOk = { ok: true; body: { gen: { genId: string; chargedPaise: number }; art: ArtOut; balancePaise: number; warnings?: string[] } };

type LoadedArt = { ok: true; part: AiPart } | { ok: false; reason: "not_found" | "too_big" };
async function loadArtPart(env: Env, uid: string, artId: string): Promise<LoadedArt> {
  const d = await metaDb(env).prepare("SELECT art_key, art_mime, art_bytes FROM studio_designs WHERE id=?1 AND created_by=?2 AND step='merch' AND art_key IS NOT NULL").bind(artId, uid).first<{ art_key: string; art_mime: string | null; art_bytes: number | null }>();
  if (!d) return { ok: false, reason: "not_found" };
  if (Number(d.art_bytes ?? 0) > AI_REF_MAX_BYTES) return { ok: false, reason: "too_big" };
  const o = await env.DIGITAL.get(d.art_key);
  if (!o) return { ok: false, reason: "not_found" };
  if (o.size > AI_REF_MAX_BYTES) return { ok: false, reason: "too_big" };
  const bytes = new Uint8Array(await o.arrayBuffer());
  return { ok: true, part: { inlineData: { mimeType: d.art_mime || o.httpMetadata?.contentType || "image/png", data: b64Of(bytes) } } };
}

export async function generateAiPicture(env: Env, uid: string, b: Record<string, unknown>, deps: AiDeps = DEFAULT_AI_DEPS): Promise<AiOk | PFail> {
  const cfg = await aiConfig(env);
  if (!cfg.flag) return fail(403, "ai_off", "Making pictures with AI is switched off right now.");
  if (!(await aiTableOk(env))) return AI_UNAVAILABLE();

  // 1. Validate.
  const requestKey = typeof b.requestKey === "string" ? b.requestKey : "";
  if (!REQUEST_KEY.test(requestKey)) return fail(400, "invalid_request_key", "Missing request key.", { field: "requestKey" });
  const prompt = typeof b.prompt === "string" ? b.prompt.replace(/\s+/g, " ").trim() : "";
  if (prompt.length < 3 || prompt.length > 800) return fail(400, "invalid_prompt", "Describe the picture in 3 to 800 letters.", { field: "prompt" });
  const style = typeof b.style === "string" && b.style ? b.style : null;
  if (style && !AI_STYLES[style]) return fail(400, "invalid_style", "Pick one of the styles shown.", { field: "style" });
  const aspect = b.aspect === undefined || b.aspect === null ? "1:1" : String(b.aspect);
  if (!(AI_ASPECTS as readonly string[]).includes(aspect)) return fail(400, "invalid_aspect", "Pick a picture shape from the list.", { field: "aspect" });
  const plainBackground = b.plainBackground !== false;
  const refArtIds = Array.isArray(b.refArtIds) ? [...new Set(b.refArtIds.map((x) => String(x)))] : [];
  if (refArtIds.length > MAX_AI_REFS || refArtIds.some((x) => !ART_ID.test(x))) return fail(400, "invalid_refs", `Use up to ${MAX_AI_REFS} of your own pictures.`, { field: "refArtIds" });
  const baseArtId = typeof b.baseArtId === "string" && b.baseArtId ? b.baseArtId : null;
  if (baseArtId && !ART_ID.test(baseArtId)) return fail(400, "invalid_base", "Pick the picture you want to change.", { field: "baseArtId" });
  const db = metaDb(env);

  // 2. Repeated request: same key returns the first result, never a second charge.
  const find = () => db.prepare(`SELECT ${GEN_COLS} FROM hf_merch_ai_gens WHERE uid=?1 AND request_key=?2`).bind(uid, requestKey).first<GenRow>();
  const replay = async (row: GenRow): Promise<AiOk | PFail> => {
    const charged = Number(row.charge_paise);
    if ((row.status === "done" || row.status === "deleted") && row.result_art_id) {
      const art = await artOf(env, uid, row.result_art_id);
      if (art) return { ok: true, body: { gen: { genId: row.id, chargedPaise: charged }, art, balancePaise: (await balanceSummary(env, uid)).availablePaidPaise } };
    }
    if ((row.status === "charging" || row.status === "generating") && Date.now() - Number(row.updated_at) < STALE_MS) return fail(409, "in_progress", "Your picture is still being made. Please wait a moment.");
    if (row.status === "charging" || row.status === "generating") await sweepStaleGens(env, uid);
    const again = await find();
    const refunded = again && again.status === "refunded" ? charged : 0;
    return fail(502, "generation_failed", `We could not make that picture.${refunded ? ` Your ${inr(refunded)} is back in your wallet.` : ""} Please try again.`, { refundedPaise: refunded });
  };
  const existing = await find();
  if (existing) return replay(existing);

  // 3. Free checks BEFORE any charge: prompt safety, then the pictures we will send.
  if (obviousSexualPrompt(prompt)) {
    await merchTrack(env, uid, "merch_ai_generate", { status: "blocked", reason: "obvious" });
    return fail(422, "prompt_blocked", "We cannot make this picture. Please describe something else.", { refundedPaise: 0 });
  }
  let verdict: { safe: boolean };
  try { verdict = await deps.moderatePrompt(env, prompt); } catch (e) { await merchFail(env, e, "ai_moderate", uid); verdict = { safe: true }; }
  if (!verdict.safe) {
    await merchTrack(env, uid, "merch_ai_generate", { status: "blocked", reason: "moderation" });
    return fail(422, "prompt_blocked", "We cannot make this picture. Please describe something else.", { refundedPaise: 0 });
  }
  const warnings: string[] = [];
  const parts: AiPart[] = [];
  let used = 0;
  if (baseArtId) {
    const l = await loadArtPart(env, uid, baseArtId);
    if (!l.ok) return l.reason === "too_big" ? fail(400, "base_too_large", "That picture is too big to change. Please make a new one.", { field: "baseArtId" }) : fail(400, "base_not_found", "We could not find the picture you want to change.", { field: "baseArtId" });
    parts.push(l.part);
  }
  for (const id of refArtIds) {
    const l = await loadArtPart(env, uid, id);
    if (!l.ok) {
      if (l.reason === "not_found") return fail(400, "ref_not_found", "We could not find one of your reference pictures. Pick it again.", { field: "refArtIds" });
      warnings.push("One reference picture was too big, so it was not used.");
      continue;
    }
    parts.push(l.part); used++;
  }
  parts.unshift({ text: buildAiPrompt({ prompt, style, plainBackground, refCount: used, isEdit: !!baseArtId }) });

  // 4. Charge (a fixed amount; 0 = free).
  const genId = `aig_${hex12()}`;
  const chargePaise = cfg.chargePaise;
  const now = Date.now();
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO hf_merch_ai_gens (id, uid, request_key, status, charge_paise, prompt, style, ref_art_ids_json, base_art_id, created_at, updated_at)
     VALUES (?1,?2,?3,'charging',?4,?5,?6,?7,?8,?9,?9)`,
  ).bind(genId, uid, requestKey, chargePaise, prompt, style, JSON.stringify(refArtIds), baseArtId, now).run();
  if (!Number(ins.meta?.changes ?? 0)) { const row = await find(); return row ? replay(row) : fail(409, "in_progress", "Your picture is still being made. Please wait a moment."); }
  const t0 = Date.now();
  await merchTrack(env, uid, "merch_ai_generate", { status: "started", gen_id: genId, charge_paise: chargePaise, refs: used, is_edit: !!baseArtId, style });
  if (chargePaise > 0) {
    let sp: AiSpend;
    try { sp = await spendWalletForAi(env, uid, genId, chargePaise); }
    catch (e) { await merchFail(env, e, "ai_charge", uid, { gen_id: genId }); await refundAndClose(env, uid, { id: genId, chargePaise }, "charge_error"); return fail(503, "wallet_unavailable", "We could not use your wallet right now. Please try again."); }
    if (!sp.ok) {
      await db.prepare("DELETE FROM hf_merch_ai_gens WHERE id=?1 AND status='charging'").bind(genId).run(); // nothing was taken: the key can be used again after topping up
      if (sp.reason === "insufficient") {
        await merchTrack(env, uid, "merch_ai_generate", { status: "insufficient", gen_id: genId, charge_paise: chargePaise, balance_paise: sp.balancePaise });
        return fail(402, "insufficient_funds", `Making a picture costs ${inr(chargePaise)}. Your wallet has ${inr(sp.balancePaise)} of paid money. Add money to continue.`,
          { chargePaise, balancePaise: sp.balancePaise, shortPaise: sp.shortPaise, testCreditNotUsable: sp.testCreditNotUsable });
      }
      if (sp.reason === "debt") return fail(409, "wallet_debt", "Please clear the amount due on your wallet first.");
      return fail(409, "charge_conflict", "We could not take the payment. Please try again.");
    }
  }
  await setStatus(env, genId, "generating", null);

  // 5. Make the picture. ANY failure from here on gives the charge back.
  const closeFail = async (status: number, error: string, base: string, code: string, track: string): Promise<PFail> => {
    const refundedPaise = await refundAndClose(env, uid, { id: genId, chargePaise }, code);
    await merchTrack(env, uid, "merch_ai_generate", { status: refundedPaise > 0 ? "refunded" : "failed", gen_id: genId, charge_paise: chargePaise, refunded_paise: refundedPaise, reason: track, latency_ms: Date.now() - t0 });
    const tail = refundedPaise > 0 ? ` Your ${inr(refundedPaise)} is back in your wallet.` : chargePaise > 0 ? ` Your ${inr(chargePaise)} will be returned to your wallet shortly.` : "";
    return fail(status, error, `${base}${tail}`, { refundedPaise });
  };
  try {
    const m = await deps.callModel(env, parts, aspect);
    if (!m.ok) {
      if (m.blocked) return await closeFail(422, "prompt_blocked", "We cannot make this picture. Please describe something else.", "blocked", m.message);
      await merchFail(env, new Error(`merch_ai_provider: ${m.message}`), "ai_generate", uid, { gen_id: genId, latency_ms: m.ms });
      return await closeFail(502, "generation_failed", "We could not make that picture.", `provider:${m.message}`, "provider");
    }
    // [HF-MERCH-AI-HIRES-1] A picture smaller than ~4000 px on the long side is upscaled on the server (Imagen) so it can fill a T-shirt front sharply.
    // Any upscale problem keeps the original; the reason goes to telemetry. Same charge either way.
    let artBytes = m.bytes; let artMime = m.mime;
    let upInfo: UpscaleOut | null = null;
    if (deps.upscale) {
      try { upInfo = await deps.upscale(env, m.bytes); } catch (e) { upInfo = { ok: false, reason: `error:${String((e as Error)?.message ?? e).slice(0, 80)}`, fromW: 0, fromH: 0, ms: 0 }; }
      if (upInfo.ok) { artBytes = upInfo.bytes; artMime = upInfo.mime; }
      if (upInfo.ok || (upInfo.reason !== "not_needed" && upInfo.reason !== "switched_off")) {
        await merchTrack(env, uid, "merch_art_upscaled", { ok: upInfo.ok, from_w: upInfo.fromW, to_w: upInfo.ok ? upInfo.w : upInfo.fromW, ms: upInfo.ms, stage: "generate", gen_id: genId, image_size: m.imageSize ?? null, ...(upInfo.ok ? { factor: upInfo.factor } : { reason: upInfo.reason }) });
      }
    }
    const fileFor = (mime: string) => `ai-${genId.slice(4)}.${mime === "image/jpeg" ? "jpg" : "png"}`;
    let saved = await deps.saveArt(env, uid, artBytes, artMime, fileFor(artMime));
    // The bigger copy could not be stored (not a safety block): keep the original picture instead.
    if (!saved.ok && saved.error !== "art_blocked" && artBytes !== m.bytes) saved = await deps.saveArt(env, uid, m.bytes, m.mime, fileFor(m.mime));
    if (!saved.ok) {
      if (saved.error === "art_blocked") return await closeFail(422, "art_blocked", "The picture did not pass our safety check, so we did not keep it.", "art_blocked", "art_blocked");
      await merchFail(env, new Error(`merch_ai_save: ${saved.error}`), "ai_save", uid, { gen_id: genId });
      return await closeFail(502, "generation_failed", "We could not make that picture.", `save:${saved.error}`, "save");
    }
    await setStatus(env, genId, "done", null, saved.artId);
    await merchTrack(env, uid, "merch_ai_generate", { status: "done", gen_id: genId, charge_paise: chargePaise, latency_ms: Date.now() - t0, provider_ms: m.ms, bytes: artBytes.byteLength, art_id: saved.artId, image_size: m.imageSize ?? null, w: saved.width, upscaled: !!upInfo?.ok });
    await merchTrack(env, uid, "$ai_generation", { "$ai_model": AI_MODEL, "$ai_provider": "vertex", "$ai_latency": m.ms / 1000, "$ai_span_name": "merch_ai_picture", "$ai_is_error": false, gen_id: genId });
    const art: ArtOut = { artId: saved.artId, url: saved.url, width: saved.width, height: saved.height, checks: saved.checks };
    return { ok: true, body: { gen: { genId, chargedPaise: chargePaise }, art, balancePaise: (await balanceSummary(env, uid)).availablePaidPaise, ...(warnings.length ? { warnings } : {}) } };
  } catch (e) {
    await merchFail(env, e, "ai_generate", uid, { gen_id: genId });
    return await closeFail(502, "generation_failed", "We could not make that picture.", `error:${String((e as Error)?.message ?? e)}`, "exception");
  }
}

// ---------------------------------------------------------------------------
// DELETE ai/pictures/:artId  [HF-MERCH-AI-DELETE-1]
// ---------------------------------------------------------------------------
/** Take an AI picture off the influencer's "earlier pictures" list for good (status 'deleted', so GET ai never lists it again).
 *  The stored file stays: a product already made with it still prints. Idempotent: deleting twice is fine. */
export async function deleteAiPicture(env: Env, uid: string, artId: string): Promise<{ ok: true; removed: number } | PFail> {
  if (!ART_ID.test(artId)) return fail(400, "invalid_art", "That picture id is not valid.");
  if (!(await aiTableOk(env))) return AI_UNAVAILABLE();
  const r = await metaDb(env).prepare("UPDATE hf_merch_ai_gens SET status='deleted', updated_at=?1 WHERE uid=?2 AND result_art_id=?3 AND status='done'")
    .bind(Date.now(), uid, artId).run();
  const removed = Number(r.meta?.changes ?? 0);
  await merchTrack(env, uid, "merch_ai_delete", { art_id: artId, removed });
  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// POST art/:artId/remove-bg
// ---------------------------------------------------------------------------
export async function removeBackground(env: Env, uid: string, artId: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; art: ArtOut } | PFail> {
  const t0 = Date.now();
  const miss = (code: string, message = "We could not remove the background. Try \"Erase plain colour\" instead.") => {
    void merchTrack(env, uid, "merch_bg_remove", { status: "failed", art_id: artId, reason: code, latency_ms: Date.now() - t0 });
    return fail(502, "bg_remove_failed", message);
  };
  if (!ART_ID.test(artId)) return fail(404, "not_found", "That picture was not found.");
  const d = await metaDb(env).prepare("SELECT art_preview_url AS url, art_w AS w, art_h AS h FROM studio_designs WHERE id=?1 AND created_by=?2 AND step='merch'").bind(artId, uid).first<{ url: string | null; w: number | null; h: number | null }>();
  if (!d || !d.url) return fail(404, "not_found", "That picture was not found. Upload it again.");
  try {
    const r = await fetcher(d.url, { cf: { image: { segment: "foreground", format: "png" } }, signal: AbortSignal.timeout(30_000) } as RequestInit);
    if (!r.ok) return miss(`http_${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const info = parseImageInfo(bytes);
    if (!info || info.mime !== "image/png" || info.has_alpha !== true) return miss("not_png_alpha");
    const base = (d.url.split("/").pop() ?? "art").replace(/\.[a-z]+$/i, "").slice(0, 60);
    const saved = await saveMerchArt(env, uid, bytes, "image/png", `${base}-cutout.png`);
    if (!saved.ok) { void merchTrack(env, uid, "merch_bg_remove", { status: "failed", art_id: artId, reason: saved.error, latency_ms: Date.now() - t0 }); return saved.error === "art_blocked" ? saved : fail(502, "bg_remove_failed", "We could not remove the background. Try \"Erase plain colour\" instead."); }
    await merchTrack(env, uid, "merch_bg_remove", { status: "ok", art_id: artId, new_art_id: saved.artId, latency_ms: Date.now() - t0, bytes: bytes.byteLength });
    return { ok: true, art: { artId: saved.artId, url: saved.url, width: saved.width, height: saved.height, checks: saved.checks } };
  } catch (e) {
    await merchFail(env, e, "bg_remove", uid, { art_id: artId });
    return miss("exception");
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
const IST_MS = 19_800_000;
export async function adminAiOverview(env: Env, hostName: (uids: string[]) => Promise<Map<string, string>>): Promise<Record<string, unknown>> {
  const cfg = await aiConfig(env);
  const base = { enabled: cfg.flag, chargeRupees: cfg.chargeRupees };
  if (!(await aiTableOk(env))) return { ...base, tableReady: false, stats: { today: { count: 0, chargedPaise: 0 }, last30: { count: 0, chargedPaise: 0, refundedPaise: 0 } }, recent: [] };
  const db = metaDb(env);
  const now = Date.now();
  const istDay = Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  const [today, l30, ref, rows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(charge_paise),0) AS c FROM hf_merch_ai_gens WHERE status IN ('done','deleted') AND created_at>=?1").bind(istDay).first<{ n: number; c: number }>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(charge_paise),0) AS c FROM hf_merch_ai_gens WHERE status IN ('done','deleted') AND created_at>=?1").bind(now - 30 * 86_400_000).first<{ n: number; c: number }>(),
    db.prepare("SELECT COALESCE(SUM(charge_paise),0) AS c FROM hf_merch_ai_gens WHERE status='refunded' AND created_at>=?1").bind(now - 30 * 86_400_000).first<{ c: number }>(),
    db.prepare(
      `SELECT g.id AS id, g.uid AS uid, g.prompt AS prompt, g.style AS style, g.status AS status, g.charge_paise AS charge, g.error AS error, g.created_at AS created_at, d.art_preview_url AS url
         FROM hf_merch_ai_gens g LEFT JOIN studio_designs d ON d.id=g.result_art_id ORDER BY g.created_at DESC LIMIT 50`,
    ).all<{ id: string; uid: string; prompt: string; style: string | null; status: string; charge: number; error: string | null; created_at: number; url: string | null }>(),
  ]);
  const list = rows.results ?? [];
  const names = await hostName(list.map((r) => r.uid));
  return {
    ...base, tableReady: true,
    stats: { today: { count: Number(today?.n ?? 0), chargedPaise: Number(today?.c ?? 0) }, last30: { count: Number(l30?.n ?? 0), chargedPaise: Number(l30?.c ?? 0), refundedPaise: Number(ref?.c ?? 0) } },
    recent: list.map((r) => ({ genId: r.id, uid: r.uid, sellerName: names.get(r.uid) ?? null, prompt: r.prompt, style: r.style, status: r.status, chargePaise: Number(r.charge), artUrl: r.url ?? null, error: r.error, createdAt: Number(r.created_at) })),
  };
}
