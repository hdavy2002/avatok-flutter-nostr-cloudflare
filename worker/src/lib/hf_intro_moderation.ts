// [HF-MOD-3 2026-10-29] Intro video safety check (rulebook HF-MOD-5). Owner decisions:
//   * every intro video is checked by Clef-omni (hf-mod-video queue); the poster by Clef-flash;
//   * the video and poster stay PRIVATE (DIGITAL bucket) until an admin approves; admins and the influencer see them
//     through short-lived signed links; approve copies them to the public bucket for the Reels;
//   * the admin always decides: approve is blocked while the check runs or failed, never allowed on a child-safety
//     flag, and approving any other flag needs a note (saved with the job + admin audit).
// Behind hfIntroModerationEnabled (default off): off = the old public-at-upload behaviour, no AI.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { enqueueModeration, MOD_POLICY_VERSION, type ModJobRow } from "./hf_moderation";

export async function introModerationOn(env: Env): Promise<boolean> {
  try { return (await readConfig(env)).hfIntroModerationEnabled === true; } catch { return false; }
}

// ── signed links for private files ───────────────────────────────────────────────────────────────────────────
const SIGN_KV = "hf_media_sign_key:v1";
let keyMemo: CryptoKey | null = null;
async function signKey(env: Env): Promise<CryptoKey> {
  if (keyMemo) return keyMemo;
  let raw = await env.TOKENS.get(SIGN_KV);
  if (!raw) {
    const b = new Uint8Array(32); crypto.getRandomValues(b);
    raw = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    await env.TOKENS.put(SIGN_KV, raw);
  }
  keyMemo = await crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return keyMemo;
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sig(env: Env, key: string, exp: number): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await signKey(env), new TextEncoder().encode(`${key}|${exp}`)));
}
export const PRIVATE_MEDIA_PREFIX = "/api/hf/media/private/";
/** A link that works for `ttlSec` (default 1 hour) to a file in the private bucket. */
export async function signedMediaUrl(env: Env, origin: string, key: string, ttlSec = 3600, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + ttlSec;
  return `${origin}${PRIVATE_MEDIA_PREFIX}${key.split("/").map(encodeURIComponent).join("/")}?e=${exp}&s=${await sig(env, key, exp)}`;
}

/** GET /api/hf/media/private/<key>?e=&s= — streams a private file (Range supported) while the link is valid. */
export async function privateMediaRoute(req: Request, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith(PRIVATE_MEDIA_PREFIX) || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const url = new URL(req.url);
  const key = p.slice(PRIVATE_MEDIA_PREFIX.length).split("/").map(decodeURIComponent).join("/");
  const exp = Number(url.searchParams.get("e") ?? 0);
  const s = url.searchParams.get("s") ?? "";
  if (!key.startsWith("intro-video/") || key.includes("..")) return new Response("not found", { status: 404 });
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return new Response("link expired", { status: 410 });
  if (s.length !== 64 || s !== (await sig(env, key, exp))) return new Response("forbidden", { status: 403 });
  const range = req.headers.get("range");
  let r2Range: R2Range | undefined;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    if (m[1]) r2Range = { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) };
    else r2Range = { suffix: Number(m[2]) };
  }
  const obj = await env.DIGITAL.get(key, r2Range ? { range: r2Range } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers({ "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=600", "accept-ranges": "bytes", "access-control-allow-origin": "*" });
  if (r2Range && "range" in obj && (obj as any).range) {
    const rr = (obj as any).range as { offset?: number; length?: number; suffix?: number };
    const start = rr.suffix != null ? obj.size - rr.suffix : rr.offset ?? 0;
    const len = rr.suffix != null ? rr.suffix : rr.length ?? obj.size - start;
    h.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
    h.set("content-length", String(len));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers: h });
}

// ── what the admin sees ──────────────────────────────────────────────────────────────────────────────────────
export type IntroAiStatus = "off" | "missing" | "queued" | "checking" | "passed" | "flagged" | "needs_look" | "failed";
export interface IntroAi {
  status: IntroAiStatus; reasons: string[]; childSafety: boolean;
  scores: { face: number; nudity: number; sexual: number; minor: number; quality: number } | null;
  posterReasons: string[];
  where: "start" | "middle" | "end" | null; whereConfidence: number | null;
  checkedAt: number | null; model: string | null; policyVersion: string | null; jobId: string | null;
  override: { by: string; note: string; at: number } | null;
}
type JobRow = ModJobRow & { override_by?: string | null; override_note?: string | null; override_at?: number | null };
const parse = (s: string | null): any => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export async function introAiFor(env: Env, videoId: string, on: boolean): Promise<IntroAi> {
  const empty: IntroAi = { status: on ? "missing" : "off", reasons: [], childSafety: false, scores: null, posterReasons: [], where: null, whereConfidence: null, checkedAt: null, model: null, policyVersion: null, jobId: null, override: null };
  if (!on) return empty;
  const rows = (await env.DB_META.prepare("SELECT * FROM hf_moderation_jobs WHERE (kind='intro_video' AND subject_id=?1) OR (kind='intro_poster' AND subject_id LIKE ?2) ORDER BY created_at DESC LIMIT 6")
    .bind(videoId, `${videoId}:%`).all<JobRow>().catch(() => ({ results: [] as JobRow[] }))).results ?? [];
  const v = rows.find((r) => r.kind === "intro_video");
  const poster = rows.find((r) => r.kind === "intro_poster");
  const pv = parse(poster?.verdict_json ?? null);
  const posterReasons: string[] = poster?.status === "refused" && Array.isArray(pv.reasons) ? pv.reasons : [];
  if (!v) return { ...empty, posterReasons };
  const d = parse(v.verdict_json);
  const pr = d.probs ?? null;
  return {
    status: v.status as IntroAiStatus, reasons: Array.isArray(d.reasons) ? d.reasons : [], childSafety: d.childSafety === true,
    scores: pr ? { face: pr.face ?? 0, nudity: pr.nudity ?? 0, sexual: pr.sexual ?? 0, minor: pr.minor ?? 0, quality: pr.quality ?? 0 } : null,
    posterReasons, where: d.where ?? null, whereConfidence: typeof d.whereConfidence === "number" ? d.whereConfidence : null,
    checkedAt: v.checked_at ?? null, model: v.model ?? null, policyVersion: v.policy_version, jobId: v.id,
    override: v.override_by ? { by: v.override_by, note: v.override_note ?? "", at: v.override_at ?? 0 } : null,
  };
}

export interface IntroVideoLite { id: string; uid: string; r2_key: string; poster_key: string | null; mime: string; bytes: number; storage?: string | null }

/** Start (or restart) the check of an intro video that has none yet, e.g. uploaded before the switch was turned on. */
export async function ensureIntroCheck(env: Env, v: IntroVideoLite): Promise<void> {
  const bucketKey = v.r2_key;
  if (!bucketKey) return;
  if ((v.storage ?? "public") !== "private") {
    // An old public upload: copy it into the private bucket for the check (it is already public, so nothing to hide).
    const o = await env.BLOBS.get(bucketKey);
    if (!o) return;
    await env.DIGITAL.put(bucketKey, await o.arrayBuffer(), { httpMetadata: { contentType: v.mime } });
  }
  await enqueueModeration(env, { uid: v.uid, kind: "intro_video", subjectId: v.id, r2Key: bucketKey, mime: v.mime, bytes: v.bytes });
}

/** Approve gate. null = may approve. */
export function introApproveGate(ai: IntroAi, note: string): { status: number; error: string; message: string } | null {
  if (ai.status === "off") return null;
  if (ai.status === "missing" || ai.status === "queued" || ai.status === "checking") return { status: 409, error: "ai_pending", message: "The AI is still checking this video. Please try again in a minute." };
  if (ai.status === "failed") return { status: 409, error: "ai_failed", message: "The AI could not check this video. Ask the influencer to record it again." };
  if (ai.childSafety) return { status: 409, error: "child_safety", message: "The AI flagged a possible child-safety problem. This application can only be rejected." };
  if (ai.status === "flagged" && note.trim().length < 5) return { status: 409, error: "note_required", message: "The AI flagged this video. Write why it is wrong before approving." };
  return null;
}

/** Copy a private intro video + poster to the public bucket (approval) and mark the row public. */
export async function publishIntroVideo(env: Env, v: IntroVideoLite): Promise<void> {
  if ((v.storage ?? "public") !== "private") {
    // A public upload that was copied in only for the check: drop the private copy.
    for (const k of [v.r2_key, v.poster_key].filter((x): x is string => !!x)) await env.DIGITAL?.delete(k).catch(() => undefined);
    return;
  }
  for (const k of [v.r2_key, v.poster_key].filter((x): x is string => !!x)) {
    const o = await env.DIGITAL.get(k);
    if (!o) throw new Error(`private_file_missing:${k}`);
    await env.BLOBS.put(k, await o.arrayBuffer(), { httpMetadata: { contentType: o.httpMetadata?.contentType ?? "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" } });
  }
  await env.DB_META.prepare("UPDATE hf_intro_videos SET storage='public', updated_at=?2 WHERE id=?1").bind(v.id, Date.now()).run();
  for (const k of [v.r2_key, v.poster_key].filter((x): x is string => !!x)) await env.DIGITAL.delete(k).catch(() => undefined);
}

export { MOD_POLICY_VERSION };
