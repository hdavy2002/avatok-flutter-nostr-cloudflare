// [AVA-MEDIA-JOB-1] Authenticated HTTP surface for the durable AI media job
// state machine (worker/src/lib/ai_media_jobs.ts). See that file's header for
// the full design rationale, and worker/src/queues/ai_media.ts for the
// background consumer this create() enqueues onto.
//
//   POST /api/ai/jobs                  { conv, kind, source_media_id?, label?, target_language?, estimate?, job_id? } -> { ok, job }
//   GET  /api/ai/jobs/:job_id          -> { ok, job }
//   POST /api/ai/jobs/:job_id/cancel   -> { ok, job }
//   GET  /api/ai/jobs?conv=...&status=&limit= -> { ok, jobs: [...] }
//
// AuthZ: every read/write requires requireUser() AND an ownership/membership
// check inside ai_media_jobs.ts — this route file never trusts a client-
// supplied uid/conv/media_id/job_id without that check running first. Every
// response returns ONLY safe job metadata (id, kind, status, label, progress,
// artifact/source media ids, timestamps, error code) — never provider
// prompts, file contents, transcripts or captions (§41/§42).
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { emailFor } from "../lib/identity";
import {
  createAiMediaJob, getAiMediaJob, cancelAiMediaJob, listAiMediaJobs,
  type AiMediaJobKind, type AiMediaJobStatus,
} from "../lib/ai_media_jobs";
import { enqueueAiMediaJob } from "../queues/ai_media";

const VALID_KINDS = new Set<AiMediaJobKind>([
  "image_generate", "doc_summarize", "doc_translate", "audio_transcribe", "audio_translate",
]);
const VALID_STATUSES = new Set<AiMediaJobStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);

// POST /api/ai/jobs
export async function aiMediaJobsCreate(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const cfg = await readConfig(env);
  if (cfg.aiEnabled === false) return json({ error: "ai disabled", flag: "aiEnabled" }, 503);

  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const conv = String(b?.conv ?? "").trim();
  const kind = String(b?.kind ?? "").trim() as AiMediaJobKind;
  if (!conv) return json({ error: "conv required" }, 400);
  if (!VALID_KINDS.has(kind)) return json({ error: "invalid kind" }, 400);

  const email = await emailFor(env, ctxUser.uid);
  const result = await createAiMediaJob(env, {
    ownerUid: ctxUser.uid,
    convId: conv,
    kind,
    sourceMediaId: b?.source_media_id ? String(b.source_media_id).trim() : null,
    label: b?.label != null ? String(b.label) : null,
    targetLanguage: b?.target_language != null ? String(b.target_language) : null,
    estimate: b?.estimate ? {
      maxInputTokens: Number.isFinite(Number(b.estimate.max_input_tokens)) ? Number(b.estimate.max_input_tokens) : undefined,
      maxOutputTokens: Number.isFinite(Number(b.estimate.max_output_tokens)) ? Number(b.estimate.max_output_tokens) : undefined,
      images: Number.isFinite(Number(b.estimate.images)) ? Number(b.estimate.images) : undefined,
      avSeconds: Number.isFinite(Number(b.estimate.av_seconds)) ? Number(b.estimate.av_seconds) : undefined,
    } : undefined,
    jobId: b?.job_id ? String(b.job_id).trim() : undefined,
    email,
  });

  if (!result.ok) {
    return json({ error: result.error, needed: result.needed, balance: result.balance }, result.status);
  }

  // Only enqueue a freshly-created job — a replayed idempotent create() that
  // returned an already-running/terminal job must never re-enqueue work.
  if (result.job.status === "queued") {
    await enqueueAiMediaJob(env, ctx, result.job.job_id, result.job.kind);
  }
  return json({ ok: true, job: result.job });
}

// GET /api/ai/jobs/:job_id
export async function aiMediaJobsGet(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const id = String(jobId || "").trim();
  if (!id) return json({ error: "job_id required" }, 400);
  const r = await getAiMediaJob(env, id, ctxUser.uid);
  if (!r.ok) return json({ error: r.error }, r.error === "forbidden" ? 403 : 404);
  return json({ ok: true, job: r.job });
}

// POST /api/ai/jobs/:job_id/cancel
export async function aiMediaJobsCancel(req: Request, env: Env, jobId: string): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const id = String(jobId || "").trim();
  if (!id) return json({ error: "job_id required" }, 400);
  const r = await cancelAiMediaJob(env, id, ctxUser.uid);
  if (!r.ok) return json({ error: r.error }, r.error === "forbidden" ? 403 : 404);
  return json({ ok: true, job: r.job });
}

// GET /api/ai/jobs?conv=...&status=queued,running&limit=50
export async function aiMediaJobsList(req: Request, env: Env): Promise<Response> {
  const ctxUser = await requireUser(req, env);
  if (isFail(ctxUser)) return json({ error: ctxUser.error }, ctxUser.status);
  const url = new URL(req.url);
  const conv = String(url.searchParams.get("conv") ?? "").trim();
  if (!conv) return json({ error: "conv required" }, 400);
  const statusParam = String(url.searchParams.get("status") ?? "").trim();
  const statuses = statusParam
    ? statusParam.split(",").map((s) => s.trim()).filter((s): s is AiMediaJobStatus => VALID_STATUSES.has(s as AiMediaJobStatus))
    : undefined;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const jobs = await listAiMediaJobs(env, { ownerUid: ctxUser.uid, convId: conv, statuses, limit });
  return json({ ok: true, jobs });
}
