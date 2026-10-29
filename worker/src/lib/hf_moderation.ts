// [HF-MOD-2 2026-10-29] AI safety check on uploads (rulebook §22, HF-MOD-3/4/5). Owner decisions:
//   * every check goes through Cloudflare Queues (hf-mod-photo, hf-mod-video); an upload never waits on the AI;
//   * photos (profile, cover, influencer photo, intro poster) -> Clef-flash; Clef's result decides, no admin step;
//   * intro video -> Clef-omni; the admin always decides (Phase 3);
//   * fail closed: a failed / unanswered check is never a pass; a pending photo is never public.
// Files being checked live in the PRIVATE `DIGITAL` bucket under hf-mod/pending/. A passed photo is copied to BLOBS.
import type { Env } from "../types";
import { track, trackException } from "../hooks";
import { BRAND } from "./brand";

const APP = BRAND.slug;
export const MOD_POLICY_VERSION = "v1";
export const MOD_MAX_ATTEMPTS = 5;
export const PHOTO_MODEL = "clef-flash" as const;
export const VIDEO_MODEL = "clef-omni" as const;

export type ModKind = "profile_photo" | "cover_photo" | "host_photo" | "intro_poster" | "intro_video";
export type PhotoKind = Exclude<ModKind, "intro_video">;
export type ModStatus = "queued" | "checking" | "passed" | "flagged" | "needs_look" | "refused" | "failed";
export const PHOTO_KINDS: readonly PhotoKind[] = ["profile_photo", "cover_photo", "host_photo", "intro_poster"];
export const isPhotoKind = (k: string): k is PhotoKind => (PHOTO_KINDS as readonly string[]).includes(k);

// ── policy v1 (thresholds live here and only here) ───────────────────────────────────────────────────────────────
const CONTEXT = "This is a picture uploaded to an Indian app where fans talk to creators. Judge only what is visible.";
export const PHOTO_QUESTIONS: Record<string, string> = {
  nudity: "Is there nudity: an exposed female breast or nipple, exposed genitals or exposed buttocks? Swimwear, gym wear, sarees and normal clothing are NOT nudity.",
  sexual: "Does the picture show a sexual act, a sexual pose or sexually explicit content?",
  minor_sexual: "Does the picture show someone who could be under 18 in a sexual, nude or revealing way?",
  gore: "Does the picture show graphic violence, blood, gore or a serious injury?",
  face: "Is a real person's face clearly visible?",
};
export const VIDEO_QUESTIONS: Record<string, string> = {
  face: "Is a real person's face clearly visible for most of the video?",
  nudity: "At any moment, is there nudity: an exposed female breast or nipple, exposed genitals or exposed buttocks? Swimwear, gym wear and sarees are NOT nudity.",
  sexual: "At any moment, is there a sexual act, a sexual pose or sexually explicit content?",
  minor: "Could anyone shown in the video be under 18?",
  quality: "Is the video too dark, too blurry or too shaky to judge what is shown?",
};
const T = { nudity: 0.7, sexual: 0.7, minor_sexual: 0.5, gore: 0.8, minor: 0.5, face: 0.5, quality: 0.6 };

export type Probs = Record<string, number>;
export interface PhotoDecision { status: "passed" | "refused"; reasons: string[]; noFace: boolean }
export interface VideoDecision { status: "passed" | "flagged" | "needs_look"; reasons: string[]; childSafety: boolean }

const p = (probs: Probs, k: string) => (typeof probs[k] === "number" && Number.isFinite(probs[k]) ? Math.min(1, Math.max(0, probs[k])) : 0);

/** Pure. A photo is refused on nudity / sexual / a minor in a sexual way / gore. No face never refuses (fans may use any picture). */
export function decidePhoto(probs: Probs): PhotoDecision {
  const reasons: string[] = [];
  if (p(probs, "minor_sexual") >= T.minor_sexual) reasons.push("minor_sexual");
  if (p(probs, "nudity") >= T.nudity) reasons.push("nudity");
  if (p(probs, "sexual") >= T.sexual) reasons.push("sexual");
  if (p(probs, "gore") >= T.gore) reasons.push("gore");
  return { status: reasons.length ? "refused" : "passed", reasons, noFace: p(probs, "face") < T.face };
}

/** Pure. A video is never refused here: the admin decides. Flagged > needs a look > passed. */
export function decideVideo(probs: Probs): VideoDecision {
  const reasons: string[] = [];
  const childSafety = p(probs, "minor") >= T.minor;
  if (childSafety) reasons.push("minor");
  if (p(probs, "nudity") >= T.nudity) reasons.push("nudity");
  if (p(probs, "sexual") >= T.sexual) reasons.push("sexual");
  if (reasons.length) return { status: "flagged", reasons, childSafety };
  const look: string[] = [];
  if (p(probs, "face") < T.face) look.push("no_face");
  if (p(probs, "quality") >= T.quality) look.push("poor_quality");
  return look.length ? { status: "needs_look", reasons: look, childSafety: false } : { status: "passed", reasons: [], childSafety: false };
}

/** The sentence the person sees when a photo is refused. Plain, never accusing a minor. */
export function refusalMessage(reasons: string[]): string {
  if (reasons.includes("minor_sexual") || reasons.includes("nudity") || reasons.includes("sexual")) return "This photo can't be used because it shows nudity or sexual content. Please choose another photo.";
  if (reasons.includes("gore")) return "This photo can't be used because it shows violence or injury. Please choose another photo.";
  return "This photo can't be used. Please choose another photo.";
}

/** Retry delay for a queue message: 30 s, 60 s, 120 s, 240 s, 480 s. */
export const retryDelaySeconds = (attempts: number): number => Math.min(480, 30 * 2 ** Math.max(0, attempts - 1));

// ── Clef calls ───────────────────────────────────────────────────────────────────────────────────────────────────
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function readNoulAnswers(answers: any, keys: string[]): Probs | null {
  if (!answers || typeof answers !== "object") return null;
  const out: Probs = {};
  for (const k of keys) {
    const a = answers[k];
    const v = a?.noul ?? a?.probability;
    if (typeof v !== "number" || !Number.isFinite(v)) return null; // a missing answer is never a pass
    out[k] = Math.min(1, Math.max(0, v));
  }
  return out;
}
const questionsOf = (q: Record<string, string>) => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { type: "noul", instructions: `${CONTEXT}\n${v}` }]));

export interface ClefResult { probs: Probs; model: string; inTokens: number; ms: number }

/** One Clef call. Throws on any error or incomplete answer (the queue retries). */
export async function askClef(env: Env, kind: ModKind, bytes: Uint8Array, mime: string): Promise<ClefResult> {
  if (!env.AI) throw new Error("workers_ai_unavailable");
  const video = kind === "intro_video";
  const model = video ? VIDEO_MODEL : PHOTO_MODEL;
  const qs = video ? VIDEO_QUESTIONS : PHOTO_QUESTIONS;
  const media = { content_type: mime, base64: b64(bytes) };
  const input: Record<string, unknown> = { model, state: video ? "An influencer's 10 to 20 second introduction video." : `A ${kind.replace("_", " ")} uploaded by a user.`, questions: questionsOf(qs) };
  if (video) input.videos = [media]; else input.images = [media];
  const t0 = Date.now();
  const res: any = await (env.AI as any).run(`@cf/cloudflare/${model}`, input);
  const ms = Date.now() - t0;
  const probs = readNoulAnswers(res?.answers ?? res?.response?.answers, Object.keys(qs));
  if (!probs) throw new Error("clef_incomplete_answers");
  return { probs, model, inTokens: Number(res?.usage?.input_tokens ?? 0), ms };
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ModJobRow {
  id: string; uid: string; kind: ModKind; subject_id: string; r2_key: string; mime: string; bytes: number; status: ModStatus;
  verdict_json: string | null; policy_version: string; model: string | null; attempts: number; error: string | null;
  created_at: number; updated_at: number; checked_at: number | null;
}
const queueFor = (env: Env, kind: ModKind): Queue | undefined => (kind === "intro_video" ? env.Q_MOD_VIDEO : env.Q_MOD_PHOTO);

/** Create the job (idempotent per subject + policy) and put {job_id} on the right queue. Returns the job id. */
export async function enqueueModeration(env: Env, j: { uid: string; kind: ModKind; subjectId: string; r2Key: string; mime: string; bytes: number }, ctx?: ExecutionContext): Promise<string> {
  const id = "hfmod_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const now = Date.now();
  await env.DB_META.prepare(
    "INSERT INTO hf_moderation_jobs (id,uid,kind,subject_id,r2_key,mime,bytes,status,policy_version,attempts,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8,0,?9,?9) ON CONFLICT(kind,subject_id,policy_version) DO NOTHING",
  ).bind(id, j.uid, j.kind, j.subjectId, j.r2Key, j.mime, j.bytes, MOD_POLICY_VERSION, now).run();
  const row = await env.DB_META.prepare("SELECT id FROM hf_moderation_jobs WHERE kind=?1 AND subject_id=?2 AND policy_version=?3").bind(j.kind, j.subjectId, MOD_POLICY_VERSION).first<{ id: string }>();
  const jobId = row?.id ?? id;
  const q = queueFor(env, j.kind);
  try {
    if (!q) throw new Error("queue_unbound");
    await q.send({ job_id: jobId });
  } catch (e) {
    // The job row stays 'queued'; the cron sweep re-sends it. Never run the AI inline on the request.
    const p = trackException(env, e, { uid: j.uid, route: "hf_moderation:enqueue", handled: true, app_name: APP, extra: { kind: j.kind } }).catch(() => undefined);
    if (ctx) ctx.waitUntil(p);
  }
  return jobId;
}

/** What happens to the thing that was checked. Registered by the routes that own each kind. */
export type ModOutcome = (env: Env, job: ModJobRow, result: { status: ModStatus; reasons: string[] }) => Promise<void>;
const outcomes: Partial<Record<ModKind, ModOutcome>> = {};
export function onModerationResult(kind: ModKind, fn: ModOutcome): void { outcomes[kind] = fn; }

/** Run one job. Throws when the AI must be retried. Returns the final status (or the current one if already done). */
export async function runModerationJob(env: Env, jobId: string, attempt: number): Promise<ModStatus> {
  const job = await env.DB_META.prepare("SELECT * FROM hf_moderation_jobs WHERE id=?1").bind(jobId).first<ModJobRow>();
  if (!job) return "failed";
  if (!["queued", "checking"].includes(job.status)) return job.status; // already decided: a duplicate or a retry
  const now = Date.now();
  // Claim it atomically: a duplicate message running at the same moment finds 0 rows changed and stops.
  // A job left 'checking' by a crashed consumer can be claimed again after 10 minutes.
  const claim: any = await env.DB_META.prepare("UPDATE hf_moderation_jobs SET status='checking', attempts=?2, updated_at=?3 WHERE id=?1 AND (status='queued' OR (status='checking' AND updated_at < ?4))")
    .bind(jobId, attempt, now, now - 10 * 60_000).run();
  if (Number(claim?.meta?.changes ?? 0) === 0) return "checking";
  const obj = await env.DIGITAL.get(job.r2_key);
  if (!obj) return finish(env, job, "failed", [], { error: "file_missing" });
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let r: ClefResult;
  try {
    r = await askClef(env, job.kind, bytes, job.mime);
  } catch (e) {
    void track(env, job.uid, "$ai_generation", APP, { $ai_model: job.kind === "intro_video" ? VIDEO_MODEL : PHOTO_MODEL, $ai_provider: "cloudflare", $ai_span_name: "hf_upload_check", $ai_is_error: true, area: "hf_moderation", kind: job.kind, error: String(e).slice(0, 160), attempt }).catch(() => undefined);
    if (attempt >= MOD_MAX_ATTEMPTS) return finish(env, job, "failed", [], { error: String(e).slice(0, 200) });
    await env.DB_META.prepare("UPDATE hf_moderation_jobs SET status='queued', error=?2, updated_at=?3 WHERE id=?1").bind(jobId, String(e).slice(0, 200), Date.now()).run();
    throw e;
  }
  void track(env, job.uid, "$ai_generation", APP, { $ai_model: r.model, $ai_provider: "cloudflare", $ai_input_tokens: r.inTokens, $ai_output_tokens: 0, $ai_latency: r.ms / 1000, $ai_is_error: false, $ai_span_name: "hf_upload_check", area: "hf_moderation", kind: job.kind }).catch(() => undefined);
  if (job.kind === "intro_video") {
    const d = decideVideo(r.probs);
    return finish(env, job, d.status, d.reasons, { probs: r.probs, model: r.model, inTokens: r.inTokens, ms: r.ms, childSafety: d.childSafety });
  }
  const d = decidePhoto(r.probs);
  return finish(env, job, d.status, d.reasons, { probs: r.probs, model: r.model, inTokens: r.inTokens, ms: r.ms, noFace: d.noFace });
}

async function finish(env: Env, job: ModJobRow, status: ModStatus, reasons: string[], extra: Record<string, unknown>): Promise<ModStatus> {
  const now = Date.now();
  const { error, model, inTokens, ms, ...rest } = extra as any;
  await env.DB_META.prepare("UPDATE hf_moderation_jobs SET status=?2, verdict_json=?3, model=?4, error=?5, checked_at=?6, updated_at=?6 WHERE id=?1")
    .bind(job.id, status, JSON.stringify({ reasons, ...rest }), model ?? null, error ?? null, now).run();
  try {
    await outcomes[job.kind]?.(env, { ...job, status }, { status, reasons });
  } catch (e) {
    await trackException(env, e, { uid: job.uid, route: "hf_moderation:outcome", handled: true, app_name: APP, extra: { kind: job.kind, status } }).catch(() => undefined);
  }
  void track(env, job.uid, job.kind === "intro_video" ? "hf_video_check" : "hf_photo_check", APP, {
    area: "hf_moderation", kind: job.kind, verdict: status, reasons: reasons.join(","), ms_in_queue: now - job.created_at, ms_model: ms ?? null, attempts: job.attempts, policy_version: job.policy_version,
  }).catch(() => undefined);
  return status;
}

/** Queue consumer for hf-mod-photo / hf-mod-video. Each message is {job_id}. */
export async function handleModerationQueue(batch: MessageBatch, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (msg) => {
    const jobId = (msg.body as { job_id?: string })?.job_id;
    if (!jobId) { msg.ack(); return; }
    const attempts = Number((msg as any).attempts ?? 1);
    try {
      await runModerationJob(env, jobId, attempts);
      msg.ack();
    } catch (e) {
      // runModerationJob already marked the job 'failed' at the last attempt; anything else waits and retries.
      if (attempts >= MOD_MAX_ATTEMPTS) msg.ack();
      else msg.retry({ delaySeconds: retryDelaySeconds(attempts) });
    }
  }));
}

/** Cron: re-send jobs stuck in 'queued' (a send that failed) and fail jobs stuck in 'checking' for over 30 minutes. */
export async function sweepModerationJobs(env: Env, now = Date.now()): Promise<{ resent: number; failed: number }> {
  const stuck = (await env.DB_META.prepare("SELECT id, kind FROM hf_moderation_jobs WHERE status='queued' AND updated_at < ?1 ORDER BY created_at LIMIT 200").bind(now - 5 * 60_000).all<{ id: string; kind: ModKind }>()).results ?? [];
  let resent = 0;
  for (const s of stuck) {
    const q = queueFor(env, s.kind);
    if (!q) continue;
    try { await q.send({ job_id: s.id }); resent++; await env.DB_META.prepare("UPDATE hf_moderation_jobs SET updated_at=?2 WHERE id=?1").bind(s.id, now).run(); } catch { /* next sweep */ }
  }
  const dead = (await env.DB_META.prepare("SELECT * FROM hf_moderation_jobs WHERE status='checking' AND updated_at < ?1 LIMIT 100").bind(now - 30 * 60_000).all<ModJobRow>()).results ?? [];
  for (const d of dead) await finish(env, d, "failed", [], { error: "stuck_checking" });
  return { resent, failed: dead.length };
}

/** Admin "Queue" card: counts per status and the average wait of jobs checked in the last hour. */
export async function moderationQueueStats(env: Env, now = Date.now()) {
  const rows = (await env.DB_META.prepare("SELECT kind, status, COUNT(*) AS n FROM hf_moderation_jobs WHERE created_at > ?1 OR status IN ('queued','checking') GROUP BY kind, status").bind(now - 24 * 3600_000).all<{ kind: string; status: string; n: number }>()).results ?? [];
  const avg = await env.DB_META.prepare("SELECT AVG(checked_at - created_at) AS ms FROM hf_moderation_jobs WHERE checked_at > ?1").bind(now - 3600_000).first<{ ms: number | null }>();
  return { counts: rows, avgWaitMs: avg?.ms == null ? null : Math.round(avg.ms) };
}
