// [AVA-MEDIA-JOB-1] Canonical server job/state-machine for durable AI media
// jobs (image generation, document summarize/translate, audio transcribe/
// translate). Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md
// Part VI §36-42 (media-jobs diagnosis/contract), Part VII §43 item 1, §48.
//
// SCOPE OF THIS WAVE ([AVA-MEDIA-JOB-1] only): the job/message state machine,
// D1 schema, HTTP surface (routes/ai_media_jobs.ts) and queue plumbing
// (queues/ai_media.ts). The actual per-kind provider pipelines (image
// generation, PDF summarize/translate, audio STT/translate) are migrated
// onto this backbone by the FOLLOW-ON issues named in queues/ai_media.ts's
// KIND_HANDLERS ([AVA-IMAGE-UX-1] / [AVA-DOC-ARTIFACT-1] /
// [AVA-AUDIO-ARTIFACT-1] — §50 items 2-4). Until then, every created job is
// claimed and fails cleanly with error_code NOT_IMPLEMENTED, releasing its
// wallet reservation — it never charges and never hangs.
//
// BILLING (§48): this file NEVER decides a price and NEVER touches WalletDO
// directly. Every reservation/settlement/release goes through
// worker/src/lib/ai_billing.ts's canonical reserveAiJob()/settleAiJob()/
// releaseAiJob() (owned by [AI-WALLET-SPENDABLE-2] — do not duplicate that
// logic here). Media capabilities are NEVER free (§42/§48) — none of the
// CAPABILITY_BY_KIND values below are in ai_billing.ts's FREE_CAPABILITIES
// set, so every createAiMediaJob() call reserves (subject to the global
// aiWalletMeteringEnabled flag, exactly like every other reserveAiJob caller).
//
// PRIVACY (§41/§42): this table (and its queue messages, queues/ai_media.ts)
// NEVER stores provider prompts, file contents, transcripts, captions,
// intimate labels or raw media URLs — only ids, kind, status, a short display
// label, a target-language code, and safe billing linkage.
//
// D1 BINDING: DB_MEDIA (avatok-media-meta) — the SAME database as
// `user_media` (worker/migrations/media.sql), so artifact rows reference
// source/derived media without a cross-database query. See
// worker/migrations/2026-07-25-ai-media-jobs.sql.
import type { Env } from "../types";
import {
  reserveAiJob, settleAiJob, releaseAiJob,
  type AiModality, type UsageUnits, type ReserveAiJobResult,
} from "./ai_billing";
import { track, trackException } from "../hooks";

export type AiMediaJobKind =
  | "image_generate"
  | "doc_summarize"
  | "doc_translate"
  | "audio_transcribe"
  | "audio_translate";

export type AiMediaJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AiMediaJobRecord {
  job_id: string;
  owner_uid: string;
  conv_id: string;
  source_media_id: string | null;
  kind: AiMediaJobKind;
  status: AiMediaJobStatus;
  label: string | null;
  progress: number;
  target_language: string | null;
  artifact_media_id: string | null;
  error_code: string | null;
  reservation_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const VALID_KINDS = new Set<AiMediaJobKind>([
  "image_generate", "doc_summarize", "doc_translate", "audio_transcribe", "audio_translate",
]);

// ---------------------------------------------------------------------------
// Capability/modality/model routing per kind — the single place that decides
// which ai_billing.ts price-catalog lane a job kind bills against at RESERVE
// time. Never one of ai_billing.ts's FREE_CAPABILITIES ("chat_ava",
// "chat_thread") — see file header.
// ---------------------------------------------------------------------------
const CAPABILITY_BY_KIND: Record<AiMediaJobKind, string> = {
  image_generate: "media_image_generate",
  doc_summarize: "media_doc_summarize",
  doc_translate: "media_doc_translate",
  audio_transcribe: "media_audio_transcribe",
  audio_translate: "media_audio_translate",
};
export const MODALITY_BY_KIND: Record<AiMediaJobKind, AiModality> = {
  image_generate: "image",
  doc_summarize: "text",
  doc_translate: "text",
  audio_transcribe: "audio",
  audio_translate: "audio",
};
// Representative RESERVE-time model per kind (Part II §11c catalog). The
// ACTUAL model used is read from the provider call site at settle time
// (settlement.modelActual) — this is only the reserve-time sizing lookup.
export const MODEL_BY_KIND: Record<AiMediaJobKind, string> = {
  image_generate: "openai/gpt-5-image-mini",
  doc_summarize: "mistralai/mistral-nemo",
  doc_translate: "mistralai/mistral-nemo",
  audio_transcribe: "openai/whisper-large-v3",
  audio_translate: "openai/whisper-large-v3",
};

export interface AiMediaJobEstimate {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  images?: number;
  avSeconds?: number;
}

// Conservative RESERVE-time defaults per kind, used when the caller doesn't
// supply its own estimate (e.g. doesn't yet know a doc's page count). §66:
// image generation over-reserves deliberately — ai_billing.ts's own
// IMAGE_OUTPUT_TOKEN_RESERVE_CEILING is applied on top of `images` when
// modality==='image', and unused headroom is refunded automatically at
// settle, never eaten as under-reserved platform loss.
const DEFAULT_ESTIMATE: Record<AiMediaJobKind, AiMediaJobEstimate> = {
  image_generate: { maxInputTokens: 200, maxOutputTokens: 0, images: 1 },
  doc_summarize: { maxInputTokens: 40_000, maxOutputTokens: 1_500 },
  doc_translate: { maxInputTokens: 40_000, maxOutputTokens: 40_000 },
  audio_transcribe: { maxInputTokens: 0, maxOutputTokens: 4_000, avSeconds: 600 },
  audio_translate: { maxInputTokens: 0, maxOutputTokens: 6_000, avSeconds: 600 },
};

// Hard ceilings on a CALLER-supplied estimate override, so a client can never
// force an unbounded reservation.
const MAX_TOKENS_CEILING = 300_000;
const MAX_IMAGES_CEILING = 4;
const MAX_AV_SECONDS_CEILING = 4 * 3600; // 4 hours

function clampEstimate(kind: AiMediaJobKind, e?: AiMediaJobEstimate): { inputTokens: number; outputTokens: number; images?: number; avSeconds?: number } {
  const d = DEFAULT_ESTIMATE[kind];
  const inputTokens = Math.max(0, Math.min(MAX_TOKENS_CEILING, Math.trunc(e?.maxInputTokens ?? d.maxInputTokens ?? 0)));
  const outputTokens = Math.max(0, Math.min(MAX_TOKENS_CEILING, Math.trunc(e?.maxOutputTokens ?? d.maxOutputTokens ?? 0)));
  const images = d.images != null || e?.images != null
    ? Math.max(0, Math.min(MAX_IMAGES_CEILING, Math.trunc(e?.images ?? d.images ?? 0)))
    : undefined;
  const avSeconds = d.avSeconds != null || e?.avSeconds != null
    ? Math.max(0, Math.min(MAX_AV_SECONDS_CEILING, Math.trunc(e?.avSeconds ?? d.avSeconds ?? 0)))
    : undefined;
  return { inputTokens, outputTokens, images, avSeconds };
}

function now(): number { return Date.now(); }

function rowToRecord(r: any): AiMediaJobRecord {
  return {
    job_id: r.job_id, owner_uid: r.owner_uid, conv_id: r.conv_id,
    source_media_id: r.source_media_id ?? null, kind: r.kind, status: r.status,
    label: r.label ?? null, progress: Number(r.progress ?? 0),
    target_language: r.target_language ?? null,
    artifact_media_id: r.artifact_media_id ?? null, error_code: r.error_code ?? null,
    reservation_id: r.reservation_id ?? null,
    created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    completed_at: r.completed_at != null ? Number(r.completed_at) : null,
  };
}

async function fetchJob(env: Env, jobId: string): Promise<AiMediaJobRecord | null> {
  const r = await env.DB_MEDIA.prepare("SELECT * FROM ai_media_jobs WHERE job_id=?1").bind(jobId).first<any>();
  return r ? rowToRecord(r) : null;
}

// ---------------------------------------------------------------------------
// Authorization helpers — read-only checks against EXISTING tables (DB_META
// conversation_members, DB_MEDIA user_media). No schema changes to either.
// Fail CLOSED (deny) on any read error — these gate a paid action.
// ---------------------------------------------------------------------------
async function isConvMember(env: Env, conv: string, uid: string): Promise<boolean> {
  if (!conv) return false;
  // Mirrors routes/ava_image.ts's membersOf(): a 1:1 DM conv id encodes both
  // participants directly and may have no conversation_members rows at all.
  if (conv.startsWith("dm_")) {
    const parts = conv.slice(3).split("__");
    return parts.length === 2 && parts.includes(uid);
  }
  try {
    const r = await env.DB_META.prepare(
      "SELECT 1 FROM conversation_members WHERE conv_id=?1 AND uid=?2",
    ).bind(conv, uid).first();
    return !!r;
  } catch { return false; }
}

async function mediaOwnedBy(env: Env, mediaId: string, uid: string): Promise<"ok" | "not_found" | "forbidden"> {
  try {
    const r = await env.DB_MEDIA.prepare("SELECT uid FROM user_media WHERE id=?1").bind(mediaId).first<{ uid: string }>();
    if (!r) return "not_found";
    return r.uid === uid ? "ok" : "forbidden";
  } catch { return "not_found"; }
}

// ---------------------------------------------------------------------------
// createAiMediaJob — validates owner/conversation/media scope, reserves
// billing (ai_billing.ts), inserts the placeholder row. Idempotent by job_id.
// ---------------------------------------------------------------------------
export interface CreateAiMediaJobInput {
  ownerUid: string;
  convId: string;
  kind: AiMediaJobKind;
  sourceMediaId?: string | null;
  label?: string | null;
  targetLanguage?: string | null;
  estimate?: AiMediaJobEstimate;
  /** Caller-supplied id makes create() idempotent (a retried POST replays the
   * same job instead of double-reserving). Server generates one if omitted. */
  jobId?: string;
  email?: string | null;
}

export type CreateAiMediaJobResult =
  | { ok: true; job: AiMediaJobRecord }
  | { ok: false; error: string; status: number; needed?: number; balance?: number };

export async function createAiMediaJob(env: Env, input: CreateAiMediaJobInput): Promise<CreateAiMediaJobResult> {
  const ownerUid = String(input.ownerUid || "").trim();
  const convId = String(input.convId || "").trim();
  if (!ownerUid) return { ok: false, error: "owner_required", status: 400 };
  if (!convId) return { ok: false, error: "conv_required", status: 400 };
  if (!VALID_KINDS.has(input.kind)) return { ok: false, error: "invalid_kind", status: 400 };

  if (!(await isConvMember(env, convId, ownerUid))) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const sourceMediaId = input.sourceMediaId ? String(input.sourceMediaId).trim() : null;
  if (sourceMediaId) {
    const owned = await mediaOwnedBy(env, sourceMediaId, ownerUid);
    if (owned === "not_found") return { ok: false, error: "source_media_not_found", status: 404 };
    if (owned === "forbidden") return { ok: false, error: "forbidden", status: 403 };
  }

  const jobId = String(input.jobId || crypto.randomUUID());

  // Idempotent create: a replay with the same job_id returns the existing row
  // untouched rather than re-reserving/re-inserting.
  const existing = await fetchJob(env, jobId);
  if (existing) {
    if (existing.owner_uid !== ownerUid) return { ok: false, error: "forbidden", status: 403 };
    return { ok: true, job: existing };
  }

  const usage = clampEstimate(input.kind, input.estimate);
  const reservation = await reserveAiJob(env, {
    uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[input.kind],
    modality: MODALITY_BY_KIND[input.kind], model: MODEL_BY_KIND[input.kind],
    maxInputTokens: usage.inputTokens, maxOutputTokens: usage.outputTokens,
    units: { images: usage.images, avSeconds: usage.avSeconds },
    email: input.email ?? null,
  });
  if (!reservation.ok) {
    return {
      ok: false, error: reservation.error || "reserve_failed",
      status: reservation.error === "AI_INSUFFICIENT_TOKENS" ? 402 : 502,
      needed: reservation.needed, balance: reservation.balance,
    };
  }

  const ts = now();
  const label = input.label ? String(input.label).slice(0, 200) : null;
  const targetLanguage = input.targetLanguage ? String(input.targetLanguage).slice(0, 40) : null;
  // NULL = no wallet reservation was actually taken for this job (metering
  // was off / capability turned out free). Every OTHER function below treats
  // a NULL reservation_id as "nothing to settle/release" — never a wallet call.
  const reservationId = reservation.metered ? reservation.ref : null;

  try {
    await env.DB_MEDIA.prepare(
      `INSERT INTO ai_media_jobs
         (job_id, owner_uid, conv_id, source_media_id, kind, status, label, progress, target_language, artifact_media_id, error_code, reservation_id, created_at, updated_at, completed_at)
       VALUES (?1,?2,?3,?4,?5,'queued',?6,0,?7,NULL,NULL,?8,?9,?9,NULL)`,
    ).bind(jobId, ownerUid, convId, sourceMediaId, input.kind, label, targetLanguage, reservationId, ts).run();
  } catch (e) {
    // The row insert failed AFTER a successful reservation — release it so we
    // never leave a dangling hold with no job row to ever settle/fail it.
    await releaseAiJob(env, reservation, { uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[input.kind], reason: "job_row_insert_failed" }).catch(() => {});
    void trackException(env, e, { uid: ownerUid, route: "ai_media_jobs.createAiMediaJob", handled: true, extra: { job_id: jobId, kind: input.kind } });
    return { ok: false, error: "internal_error", status: 500 };
  }

  void track(env, ownerUid, "ai_media_job_created", "ai_media_jobs", { job_id: jobId, kind: input.kind, conv_id: convId, metered: reservation.metered });
  const job = await fetchJob(env, jobId);
  return { ok: true, job: job! };
}

// ---------------------------------------------------------------------------
// claimAiMediaJob — atomic queued -> running. Conditional UPDATE + `changes`
// check (never read-then-write), so two concurrent claim attempts (at-least-
// once queue redelivery) can never both "win".
// ---------------------------------------------------------------------------
export type ClaimAiMediaJobResult =
  | { ok: true; job: AiMediaJobRecord }
  | { ok: false; error: "not_found" | "already_claimed" };

export async function claimAiMediaJob(env: Env, jobId: string): Promise<ClaimAiMediaJobResult> {
  const ts = now();
  const res = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='running', updated_at=?2 WHERE job_id=?1 AND status='queued'",
  ).bind(jobId, ts).run();
  if ((res.meta?.changes ?? 0) > 0) {
    const job = await fetchJob(env, jobId);
    return job ? { ok: true, job } : { ok: false, error: "not_found" };
  }
  const existing = await fetchJob(env, jobId);
  if (!existing) return { ok: false, error: "not_found" };
  // Already running or already terminal — safe no-op for an at-least-once
  // redelivery; the caller (queues/ai_media.ts) just acks and moves on.
  return { ok: false, error: "already_claimed" };
}

/** running -> queued, for a RETRYABLE provider failure — lets the queue's
 * automatic redelivery re-claim the job instead of leaving it stuck 'running'
 * forever (claimAiMediaJob's predicate only matches status='queued'). */
export async function requeueAiMediaJob(env: Env, jobId: string): Promise<boolean> {
  const res = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='queued', updated_at=?2 WHERE job_id=?1 AND status='running'",
  ).bind(jobId, now()).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// completeAiMediaJob — atomic running -> succeeded + artifact link + settle
// (ai_billing.ts settleAiJob, exactly once by job_id). Idempotent: a replay
// against an already-succeeded job returns the existing row untouched.
// ---------------------------------------------------------------------------
export interface CompleteAiMediaJobArtifact {
  mediaId: string;
  mimeType?: string | null;
  fileName?: string | null;
  language?: string | null;
}
export interface CompleteAiMediaJobSettlement {
  modelActual: string;
  usage: UsageUnits;
  /** Prefer this straight from the provider's own reported cost (micro-USD) — ai_billing.ts's settleAiJob treats it as ground truth over the catalog estimate. */
  providerCostUsdMicro?: number;
}
export interface CompleteAiMediaJobInput {
  jobId: string;
  artifact: CompleteAiMediaJobArtifact;
  settlement: CompleteAiMediaJobSettlement;
  email?: string | null;
}
export type CompleteAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function completeAiMediaJob(env: Env, input: CompleteAiMediaJobInput): Promise<CompleteAiMediaJobResult> {
  const job = await fetchJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "succeeded") return { ok: true, job }; // idempotent replay

  const ts = now();
  const artifactId = crypto.randomUUID();

  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='succeeded', artifact_media_id=?2, progress=100, completed_at=?3, updated_at=?3 WHERE job_id=?1 AND status='running'",
  ).bind(input.jobId, input.artifact.mediaId, ts).run();

  if ((upd.meta?.changes ?? 0) === 0) {
    // Raced with another completion/failure/cancel — resolve from current state.
    const cur = await fetchJob(env, input.jobId);
    if (cur?.status === "succeeded") return { ok: true, job: cur };
    return { ok: false, error: cur ? `invalid_state:${cur.status}` : "not_found" };
  }

  try {
    await env.DB_MEDIA.prepare(
      `INSERT INTO ai_media_artifacts (artifact_id, owner_uid, source_media_id, job_id, media_id, mime_type, file_name, language, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(job_id, media_id) DO NOTHING`,
    ).bind(
      artifactId, job.owner_uid, job.source_media_id, input.jobId, input.artifact.mediaId,
      input.artifact.mimeType ?? null, input.artifact.fileName ?? null, input.artifact.language ?? null, ts,
    ).run();
  } catch (e) {
    // The job is already marked succeeded (the deliverable is real) — an
    // artifact-index write failure must never unwind that; log for repair.
    void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.completeAiMediaJob", handled: true, extra: { job_id: input.jobId } });
  }

  // Settle exactly once by job_id — best-effort; a billing-bookkeeping
  // failure never unwinds an already-delivered artifact (mirrors ai_billing.ts's
  // own "never fail the user's ALREADY-COMPLETED answer over our own
  // bookkeeping gap" stance, §65).
  if (job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await settleAiJob(env, reservation, {
      opId: input.jobId, uid: job.owner_uid, capability: CAPABILITY_BY_KIND[job.kind], modality: MODALITY_BY_KIND[job.kind],
      modelRequested: MODEL_BY_KIND[job.kind], modelActual: input.settlement.modelActual, usage: input.settlement.usage,
      providerCostUsdMicro: input.settlement.providerCostUsdMicro, email: input.email ?? null,
    }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.completeAiMediaJob", method: "settleAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }

  void track(env, job.owner_uid, "ai_media_job_completed", "ai_media_jobs", { job_id: input.jobId, kind: job.kind, status: "succeeded" });
  const finalRow = await fetchJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// failAiMediaJob — records a SAFE error code, releases/refunds the
// reservation (ai_billing.ts releaseAiJob). Idempotent: a replay against an
// already-terminal job returns the existing row untouched, never a double
// release.
// ---------------------------------------------------------------------------
export interface FailAiMediaJobInput {
  jobId: string;
  /** Short, safe code only (e.g. NOT_IMPLEMENTED, PROVIDER_ERROR, TIMEOUT, MODERATION_BLOCKED) — NEVER a raw provider message (§41/§42). */
  errorCode: string;
  reason: string; // free-form for telemetry only, e.g. "provider_error" | "timeout" | "moderation_block" | "worker_timeout"
}
export type FailAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function failAiMediaJob(env: Env, input: FailAiMediaJobInput): Promise<FailAiMediaJobResult> {
  const job = await fetchJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "failed" || job.status === "cancelled" || job.status === "succeeded") {
    return { ok: true, job }; // idempotent — already terminal
  }
  const ts = now();
  const errorCode = String(input.errorCode || "unknown_error").slice(0, 64);
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='failed', error_code=?2, updated_at=?3 WHERE job_id=?1 AND status IN ('queued','running')",
  ).bind(input.jobId, errorCode, ts).run();

  if ((upd.meta?.changes ?? 0) > 0 && job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await releaseAiJob(env, reservation, {
      uid: job.owner_uid, opId: input.jobId, capability: CAPABILITY_BY_KIND[job.kind], reason: input.reason || errorCode,
    }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "ai_media_jobs.failAiMediaJob", method: "releaseAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }
  void track(env, job.owner_uid, "ai_media_job_failed", "ai_media_jobs", { job_id: input.jobId, kind: job.kind, error_code: errorCode, reason: input.reason });
  const finalRow = await fetchJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// cancelAiMediaJob — owner-authorized cancellation. Idempotent.
// ---------------------------------------------------------------------------
export type CancelAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function cancelAiMediaJob(env: Env, jobId: string, ownerUid: string): Promise<CancelAiMediaJobResult> {
  const job = await fetchJob(env, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.owner_uid !== ownerUid) return { ok: false, error: "forbidden" };
  if (job.status === "cancelled" || job.status === "succeeded" || job.status === "failed") {
    return { ok: true, job }; // idempotent
  }
  const ts = now();
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE ai_media_jobs SET status='cancelled', updated_at=?2 WHERE job_id=?1 AND status IN ('queued','running')",
  ).bind(jobId, ts).run();

  if ((upd.meta?.changes ?? 0) > 0 && job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await releaseAiJob(env, reservation, { uid: ownerUid, opId: jobId, capability: CAPABILITY_BY_KIND[job.kind], reason: "client_cancel" }).catch(() => {});
  }
  void track(env, ownerUid, "ai_media_job_cancelled", "ai_media_jobs", { job_id: jobId, kind: job.kind });
  const finalRow = await fetchJob(env, jobId);
  return { ok: true, job: finalRow! };
}

// ---------------------------------------------------------------------------
// getAiMediaJob / listAiMediaJobs — account-scoped reconnect/hydration reads.
// ---------------------------------------------------------------------------
export type GetAiMediaJobResult = { ok: true; job: AiMediaJobRecord } | { ok: false; error: string };

export async function getAiMediaJob(env: Env, jobId: string, ownerUid: string): Promise<GetAiMediaJobResult> {
  const job = await fetchJob(env, jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.owner_uid !== ownerUid) return { ok: false, error: "forbidden" };
  return { ok: true, job };
}

export interface ListAiMediaJobsInput {
  ownerUid: string;
  convId?: string;
  statuses?: AiMediaJobStatus[];
  limit?: number;
}

export async function listAiMediaJobs(env: Env, input: ListAiMediaJobsInput): Promise<AiMediaJobRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const clauses = ["owner_uid=?1"];
  const binds: unknown[] = [input.ownerUid];
  if (input.convId) { clauses.push(`conv_id=?${binds.length + 1}`); binds.push(input.convId); }
  if (input.statuses && input.statuses.length) {
    const placeholders = input.statuses.map((_, i) => `?${binds.length + 1 + i}`).join(",");
    clauses.push(`status IN (${placeholders})`);
    binds.push(...input.statuses);
  }
  const sql = `SELECT * FROM ai_media_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`;
  try {
    const r = await env.DB_MEDIA.prepare(sql).bind(...binds).all<any>();
    return (r.results || []).map(rowToRecord);
  } catch { return []; }
}
