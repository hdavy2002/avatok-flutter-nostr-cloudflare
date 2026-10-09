// [HF-HOST-PLATFORM-1] Host profile generation endpoints (flag hostOnboardingEnabled).
//   POST /api/hosts/generate         -> { jobId }   (starts HostMediaWorkflow; max 3 attempts)
//   GET  /api/hosts/generate/status  -> { status, stages, error? }
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { trackUser, trackException } from "../hooks";
import { BRAND } from "../lib/brand";
import { emailFor } from "../lib/identity";
import { readConfig } from "./config";

const APP = BRAND.slug;
export const HF_MAX_GEN_ATTEMPTS = 3;
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const STAGES = ["text", "images", "voice", "conversation", "safety"] as const;

async function start(req: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const uid = u.uid;
  if (!env.HOST_MEDIA) return err(503, "generation_unavailable");

  const host = await env.DB_META.prepare(
    "SELECT status, display_name, about, languages_json, topics_json, conversation_lang, avatar_id, voice_sample_r2, gen_attempts, agreements_at FROM hf_hosts WHERE uid=?1",
  ).bind(uid).first<{
    status: string; display_name: string | null; about: string | null; languages_json: string; topics_json: string; conversation_lang: string | null;
    avatar_id: string | null; voice_sample_r2: string | null; gen_attempts: number; agreements_at: number | null;
  }>();
  if (!host) return err(409, "profile_incomplete", { missing: ["profile"] });
  if (host.status === "generating") return err(409, "already_generating");
  if (!["draft", "pending_host", "pending_review", "rejected"].includes(host.status)) return err(409, "not_allowed_in_status", { status: host.status });
  if (Number(host.gen_attempts) >= HF_MAX_GEN_ATTEMPTS) return err(429, "attempts_exhausted", { max: HF_MAX_GEN_ATTEMPTS });

  const [kyc, selfie, payout] = await Promise.all([
    env.DB_META.prepare("SELECT verified_at FROM hf_kyc WHERE uid=?1").bind(uid).first<{ verified_at: number | null }>().catch(() => null),
    env.DB_META.prepare("SELECT review_status FROM hf_selfie WHERE uid=?1 ORDER BY created_at DESC LIMIT 1").bind(uid).first<{ review_status: string }>().catch(() => null),
    env.DB_META.prepare("SELECT name_match FROM hf_payout WHERE uid=?1").bind(uid).first<{ name_match: number }>().catch(() => null),
  ]);
  const missing: string[] = [];
  if (!kyc?.verified_at) missing.push("aadhaar");
  // pending is accepted: the admin reviews the selfie before the host can go live
  if (!selfie || !["pending", "approved"].includes(selfie.review_status)) missing.push("selfie");
  if (!payout || payout.name_match !== 1) missing.push("payout");
  if (!host.avatar_id) missing.push("avatar");
  if (!host.display_name?.trim()) missing.push("displayName");
  if (!host.about?.trim()) missing.push("about");
  if (!host.conversation_lang) missing.push("conversationLang");
  let langs: unknown[] = []; let topics: unknown[] = [];
  try { langs = JSON.parse(host.languages_json || "[]"); topics = JSON.parse(host.topics_json || "[]"); } catch { /* empty */ }
  if (!Array.isArray(langs) || !langs.length) missing.push("languages");
  if (!Array.isArray(topics) || !topics.length) missing.push("topics");
  if (!host.voice_sample_r2) missing.push("voice");
  if (!host.agreements_at) missing.push("agreements");
  if (missing.length) return err(409, "profile_incomplete", { missing });

  const now = Date.now();
  const jobId = crypto.randomUUID();
  const stages = JSON.stringify(Object.fromEntries(STAGES.map((s) => [s, "waiting"])));
  // claim the attempt atomically: only one request can flip the status to 'generating'
  const claim = await env.DB_META.prepare(
    "UPDATE hf_hosts SET status='generating', gen_attempts=gen_attempts+1, updated_at=?2 WHERE uid=?1 AND status<>'generating' AND gen_attempts<?3",
  ).bind(uid, now, HF_MAX_GEN_ATTEMPTS).run();
  if (!claim.meta?.changes) return err(409, "already_generating");
  try {
    await env.DB_META.prepare(
      "INSERT INTO hf_media_jobs (id, uid, kind, instance_id, status, stage, stages_json, created_at, updated_at) VALUES (?1,?2,'host_media',?1,'queued','text',?3,?4,?4)",
    ).bind(jobId, uid, stages, now).run();
    await env.HOST_MEDIA.create({ id: jobId, params: { uid, jobId } });
  } catch (e) {
    await env.DB_META.batch([
      env.DB_META.prepare("UPDATE hf_hosts SET status=?2, gen_attempts=MAX(gen_attempts-1,0), updated_at=?3 WHERE uid=?1").bind(uid, host.status, now),
      env.DB_META.prepare("UPDATE hf_media_jobs SET status='failed', error='start_failed', updated_at=?2 WHERE id=?1").bind(jobId, now),
    ]).catch(() => {});
    await trackException(env, e, { uid, route: "/api/hosts/generate", handled: true, app_name: APP, extra: { area: "hf_host_media", step: "start" } });
    return err(502, "start_failed");
  }
  const p = emailFor(env, uid).catch(() => null).then((email) =>
    trackUser(env, uid, email, "hf_host_generate_started", APP, { area: "hf_host_media", job_id: jobId, attempt: Number(host.gen_attempts) + 1 })).catch(() => {});
  if (ctx) ctx.waitUntil(p);
  return json({ jobId });
}

async function status(req: Request, env: Env): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return err(u.status, u.error);
  const job = await env.DB_META.prepare(
    "SELECT id, status, stages_json, error, updated_at FROM hf_media_jobs WHERE uid=?1 AND kind='host_media' ORDER BY created_at DESC LIMIT 1",
  ).bind(u.uid).first<{ id: string; status: string; stages_json: string | null; error: string | null; updated_at: number }>();
  if (!job) return json({ status: "none", stages: Object.fromEntries(STAGES.map((s) => [s, "waiting"])) });
  let stages: Record<string, string> = {};
  try { stages = JSON.parse(job.stages_json || "{}"); } catch { /* empty */ }
  for (const s of STAGES) stages[s] = stages[s] ?? "waiting";
  // a job that has not moved for 15 minutes is reported as failed so the app does not spin forever
  const stale = (job.status === "queued" || job.status === "running") && Date.now() - job.updated_at > 15 * 60_000;
  return json({ jobId: job.id, status: stale ? "failed" : job.status, stages, ...(job.error || stale ? { error: job.error ?? "timed_out" } : {}) });
}

export async function hfHostGenerateRoute(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  const isStart = p === "/api/hosts/generate" && req.method === "POST";
  const isStatus = p === "/api/hosts/generate/status" && req.method === "GET";
  if (!isStart && !isStatus) return null;
  try {
    if ((await readConfig(env)).hostOnboardingEnabled !== true) return err(404, "not_enabled");
    return isStart ? await start(req, env, ctx) : await status(req, env);
  } catch (e) {
    await trackException(env, e, { route: p, method: req.method, handled: true, app_name: APP, extra: { area: "hf_host_media" } });
    return err(500, "internal_error");
  }
}
