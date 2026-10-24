// [HF-MERCH-AI-HIRES-1 2026-10-24] Sharper merch pictures: the Vertex Imagen upscaler, used (a) right after an AI picture is made when it is
// smaller than a full print area needs, and (b) by the studio's free "Make it sharper" button (POST art/:artId/upscale).
// Why: Printrove's T-shirt front is 15.6 x 19.6 in and the studio blocks anything under 150 DPI, so a 2048 px picture (131 DPI across 15.6 in)
// could never fill the shirt. Target: about 4000 px on the long side (~200 DPI across the full area).
// Vertex facts (checked 2026-10-24, docs.cloud.google.com .../image/upscale-image): model imagen-4.0-upscale-preview, POST {loc}/publishers/google/models/
// <model>:predict, body { instances:[{ prompt, image:{ bytesBase64Encoded } }], parameters:{ mode:"upscale", upscaleConfig:{ upscaleFactor:"x2"|"x3"|"x4" },
// outputOptions:{ mimeType, compressionQuality } } }, answer predictions[0].bytesBase64Encoded. Output (input x factor) must be at most 17 megapixels.
// Imagen is served from regional endpoints, so this always calls us-central1 (the Gemini calls stay on the global endpoint).
// Never fails a generation: any upscale problem keeps the original picture and records why (telemetry merch_art_upscaled).
import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { readConfig } from "../routes/config";
import { rateLimit } from "../money";
import { sha256Hex } from "../util";
import { vertexMediaRequest } from "./vertex";
import { IMAGE_EXT, parseImageInfo } from "./studio_logic";
import { MERCH_ART_MAX_BYTES, putMerchPublic, type PFail } from "./hf_merch_products";
import { merchFail, merchTrack } from "./hf_merch_notify";

export const UPSCALE_MODEL_DEFAULT = "imagen-4.0-upscale-preview";
export const UPSCALE_LOCATION = "us-central1";
/** Long side we aim for: ~205 DPI across the 19.6 in tall T-shirt front, ~256 DPI across its 15.6 in width. */
export const UPSCALE_TARGET_LONG_PX = 4000;
/** Imagen's output cap: input pixels x factor^2 must stay at or under 17 megapixels. */
export const UPSCALE_MAX_OUTPUT_PX = 17_000_000;
/** Bigger inputs are not sent (the image goes inline in the request body). */
export const UPSCALE_INPUT_MAX_BYTES = 10 * 1024 * 1024;
export const UPSCALE_TIMEOUT_MS = 60_000;
/** Free "Make it sharper" presses per influencer per day. */
export const UPSCALE_DAILY_LIMIT = 10;
const ART_ID = /^dsn-[a-f0-9]{8}$/;
const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): PFail => ({ ok: false, status, error, message, extra });
const hex8 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

export async function upscaleConfig(env: Env): Promise<{ enabled: boolean; model: string }> {
  const c = (await readConfig(env)) as unknown as Record<string, unknown>;
  const model = typeof c.hfMerchUpscaleModel === "string" && /^[a-z0-9@._-]{3,80}$/i.test(c.hfMerchUpscaleModel) ? c.hfMerchUpscaleModel : UPSCALE_MODEL_DEFAULT;
  return { enabled: c.hfMerchUpscaleEnabled !== false, model };
}

/**
 * The upscale factor for a w x h picture: the smallest of x2 / x3 / x4 that reaches the target long side within the 17 MP cap,
 * else the biggest one that fits the cap. Null when the picture is already big enough or no factor fits.
 */
export function upscaleFactorFor(w: number, h: number): 2 | 3 | 4 | null {
  if (!(w > 0 && h > 0)) return null;
  if (Math.max(w, h) >= UPSCALE_TARGET_LONG_PX) return null;
  const fits = ([2, 3, 4] as const).filter((f) => w * h * f * f <= UPSCALE_MAX_OUTPUT_PX);
  if (!fits.length) return null;
  return fits.find((f) => Math.max(w, h) * f >= UPSCALE_TARGET_LONG_PX) ?? fits[fits.length - 1];
}

function b64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const bytesOfB64 = (b64: string): Uint8Array => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

export type UpscaleOut =
  | { ok: true; bytes: Uint8Array; mime: "image/png" | "image/jpeg"; w: number; h: number; fromW: number; fromH: number; factor: number; ms: number }
  | { ok: false; reason: string; fromW: number; fromH: number; ms: number };

/** One call to the Vertex upscaler. `keepAlpha` asks for a PNG (a cut-out picture); otherwise a high-quality JPEG keeps the file small. */
export async function callUpscaleModel(env: Env, bytes: Uint8Array, factor: number, o: { model: string; keepAlpha: boolean; timeoutMs?: number }): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  if (!env.VERTEX_PROJECT) return { ok: false, reason: "vertex_not_configured" };
  const url = `https://${UPSCALE_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.VERTEX_PROJECT}/locations/${UPSCALE_LOCATION}/publishers/google/models/${o.model}:predict`;
  const r = await vertexMediaRequest(env, url, {
    instances: [{ prompt: "Upscale the image", image: { bytesBase64Encoded: b64Of(bytes) } }],
    parameters: {
      mode: "upscale",
      upscaleConfig: { upscaleFactor: `x${factor}` },
      outputOptions: o.keepAlpha ? { mimeType: "image/png" } : { mimeType: "image/jpeg", compressionQuality: 92 },
    },
  }, { timeoutMs: o.timeoutMs ?? UPSCALE_TIMEOUT_MS });
  const data = r.out?.predictions?.[0]?.bytesBase64Encoded;
  if (!r.ok || typeof data !== "string" || !data) return { ok: false, reason: `vertex_${r.status}: ${String(r.out?.error?.message ?? "no image returned").slice(0, 140)}` };
  try { return { ok: true, bytes: bytesOfB64(data) }; } catch { return { ok: false, reason: "bad_base64" }; }
}

export type UpscaleDeps = { callModel: typeof callUpscaleModel };
export const DEFAULT_UPSCALE_DEPS: UpscaleDeps = { callModel: callUpscaleModel };

/**
 * Make `bytes` bigger for print. Never throws. Returns ok:false with a reason ("not_needed", "too_many_pixels", a provider error…)
 * whenever the original should be kept. The result is checked: a readable PNG/JPEG, really bigger, same shape, within the art size limit.
 */
export async function upscaleForPrint(env: Env, bytes: Uint8Array, o: { model: string; timeoutMs?: number }, deps: UpscaleDeps = DEFAULT_UPSCALE_DEPS): Promise<UpscaleOut> {
  const t0 = Date.now();
  const info = parseImageInfo(bytes);
  const fromW = info?.w ?? 0, fromH = info?.h ?? 0;
  const no = (reason: string): UpscaleOut => ({ ok: false, reason, fromW, fromH, ms: Date.now() - t0 });
  if (!info || (info.mime !== "image/png" && info.mime !== "image/jpeg")) return no("unreadable_input");
  if (Math.max(fromW, fromH) >= UPSCALE_TARGET_LONG_PX) return no("not_needed");
  const factor = upscaleFactorFor(fromW, fromH);
  if (!factor) return no("too_many_pixels");
  if (bytes.byteLength > UPSCALE_INPUT_MAX_BYTES) return no("input_too_big");
  const keepAlpha = info.mime === "image/png" && info.has_alpha === true;
  const timeoutMs = o.timeoutMs ?? UPSCALE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      deps.callModel(env, bytes, factor, { model: o.model, keepAlpha, timeoutMs }),
      new Promise<{ ok: false; reason: string }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs + 2_000); }),
    ]);
    if (!r.ok) return no(r.reason);
    const out = parseImageInfo(r.bytes);
    if (!out || (out.mime !== "image/png" && out.mime !== "image/jpeg")) return no("unreadable_output");
    if (out.w <= fromW || out.h <= fromH) return no("not_bigger");
    if (Math.abs(out.w / out.h - fromW / fromH) > 0.02) return no("shape_changed");
    if (keepAlpha && out.has_alpha !== true) return no("alpha_lost");
    if (r.bytes.byteLength > MERCH_ART_MAX_BYTES) return no("output_too_big");
    return { ok: true, bytes: r.bytes, mime: out.mime, w: out.w, h: out.h, fromW, fromH, factor, ms: Date.now() - t0 };
  } catch (e) {
    return no(`error:${String((e as Error)?.message ?? e).slice(0, 120)}`);
  } finally { if (timer) clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// POST art/:artId/upscale — the studio's free "Make it sharper" button
// ---------------------------------------------------------------------------
export type SharperArt = { artId: string; url: string; width: number; height: number; checks: { ok: boolean; dpiAtFullWidth: number; warnings: string[] } };
type SourceRow = { id: string; name: string | null; art_key: string | null; art_w: number | null; art_h: number | null; art_mime: string | null; art_checks_json: string | null };

/**
 * Makes a NEW, bigger design row for the same influencer from one of their pictures. The source row is never changed (it may be locked or on a product).
 * The new row carries the source's checks (moderation included: it is the same picture, only bigger) plus upscaled_from.
 */
export async function upscaleMerchArt(env: Env, uid: string, artId: string, deps: UpscaleDeps = DEFAULT_UPSCALE_DEPS): Promise<{ ok: true; art: SharperArt; fromW: number; toW: number } | PFail> {
  if (!ART_ID.test(artId)) return fail(404, "not_found", "That picture was not found.");
  const cfg = await upscaleConfig(env);
  if (!cfg.enabled) return fail(403, "upscale_off", "Making pictures sharper is switched off right now.");
  const db = metaDb(env);
  const src = await db.prepare("SELECT id, name, art_key, art_w, art_h, art_mime, art_checks_json FROM studio_designs WHERE id=?1 AND created_by=?2 AND step='merch' AND art_key IS NOT NULL")
    .bind(artId, uid).first<SourceRow>();
  if (!src || !src.art_key) return fail(404, "not_found", "That picture was not found. Add it again.");
  const w = Number(src.art_w ?? 0), h = Number(src.art_h ?? 0);
  if (Math.max(w, h) >= UPSCALE_TARGET_LONG_PX) return fail(409, "already_sharp", "This picture is already sharp enough to fill the print area.");
  if (!upscaleFactorFor(w, h)) return fail(409, "cannot_sharpen", "This picture is already as big as we can make it. Make it a little smaller on the product.");
  const limited = await rateLimit(env, `merch:upscale:${uid}`, UPSCALE_DAILY_LIMIT, 86_400);
  if (limited) return fail(429, "rate_limited", `You can make ${UPSCALE_DAILY_LIMIT} pictures sharper a day. Please try again tomorrow.`);
  const obj = await env.DIGITAL.get(src.art_key);
  if (!obj) return fail(404, "not_found", "That picture was not found. Add it again.");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const up = await upscaleForPrint(env, bytes, { model: cfg.model }, deps);
  await merchTrack(env, uid, "merch_art_upscaled", { ok: up.ok, from_w: up.fromW, to_w: up.ok ? up.w : up.fromW, ms: up.ms, stage: "button", art_id: artId, ...(up.ok ? { factor: up.factor } : { reason: up.reason }) });
  if (!up.ok) {
    if (up.reason === "alpha_lost") return fail(422, "upscale_alpha", "We cannot make a cut-out picture sharper. Make the picture sharper first, then remove its background.");
    if (up.reason === "input_too_big") return fail(400, "upscale_too_big", "This picture file is too big to make sharper.");
    if (!/^vertex_4/.test(up.reason)) await merchFail(env, new Error(`merch_upscale: ${up.reason}`), "art_upscale", uid, { art_id: artId });
    return fail(502, "upscale_failed", "We could not make this picture sharper right now. Please try again in a little while, or make it smaller on the product.");
  }
  try {
    const art = await saveUpscaledCopy(env, uid, src, up);
    return { ok: true, art, fromW: up.fromW, toW: up.w };
  } catch (e) {
    await merchFail(env, e, "art_upscale_save", uid, { art_id: artId });
    return fail(502, "upscale_failed", "We could not save the sharper picture. Please try again.");
  }
}

async function saveUpscaledCopy(env: Env, uid: string, src: SourceRow, up: Extract<UpscaleOut, { ok: true }>): Promise<SharperArt> {
  const id = `dsn-${hex8()}`;
  const sha8 = (await sha256Hex(up.bytes)).slice(0, 8);
  const key = `merch/${uid}/${id}/art-${sha8}.${IMAGE_EXT[up.mime]}`;
  await env.DIGITAL.put(key, up.bytes, { httpMetadata: { contentType: up.mime }, customMetadata: { file_name: encodeURIComponent(`sharper-${src.id}.${IMAGE_EXT[up.mime]}`) } });
  const url = await putMerchPublic(env, uid, `${id}/art-`, up.bytes, up.mime);
  const info = parseImageInfo(up.bytes);
  const now = Date.now();
  const patch = JSON.stringify({ w: up.w, h: up.h, bytes: up.bytes.byteLength, mime: up.mime, has_alpha: info?.has_alpha ?? null, upscaled_from: src.id, upscale_factor: up.factor });
  await metaDb(env).prepare(
    `INSERT INTO studio_designs (id, name, status, step, art_key, art_w, art_h, art_bytes, art_mime, art_checks_json, art_preview_url, products_json, version, colours_json, created_by, created_at, updated_at)
     VALUES (?1,?2,'draft','merch',?3,?4,?5,?6,?7,json_patch(COALESCE(?8,'{}'),?9),?10,'[]',1,'[]',?11,?12,?12)`,
  ).bind(id, src.name ?? "Merch art", key, up.w, up.h, up.bytes.byteLength, up.mime, src.art_checks_json, patch, url, uid, now).run();
  const moderation = (() => { try { return (JSON.parse(src.art_checks_json ?? "{}") as { moderation?: string }).moderation; } catch { return undefined; } })();
  const warnings: string[] = [];
  if (moderation !== "ok") warnings.push("This image will be checked by our team before it goes on sale.");
  return { artId: id, url, width: up.w, height: up.h, checks: { ok: true, dpiAtFullWidth: Math.round(up.w / 15.6), warnings } };
}
