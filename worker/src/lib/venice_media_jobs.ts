// [VENICE-VID-1 / VENICE-MUS-1] Durable job state machine for Venice AI
// video/music generation. Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md.
//
// A SEPARATE, small state machine from worker/src/lib/ai_media_jobs.ts —
// deliberately. `AiMediaJobKind` there is a closed TypeScript union
// exhaustively switched over by several `Record<AiMediaJobKind, ...>` maps
// (CAPABILITY_BY_KIND, MODALITY_BY_KIND, MODEL_BY_KIND, DEFAULT_ESTIMATE) and
// its queue dispatcher (queues/ai_media.ts's KIND_HANDLERS). Extending that
// union to add 'venice_video_generate'/'venice_music_generate' would mean
// editing worker/src/lib/ai_media_jobs.ts, which is a different agent's file
// ownership this wave (parallel [VENICE-IMG-1] work on the SAME file). This
// module is the coherent alternative: its own D1 table
// (worker/migrations/2026-08-14-venice-media-jobs.sql, table
// `venice_media_jobs`, DB_MEDIA binding — same database as ai_media_jobs, so a
// future consolidation can join without a cross-database query), but it still
// bills through the SAME shared money authority
// (worker/src/lib/ai_billing.ts's reserveAiJob()/settleAiJob()/releaseAiJob())
// — only the job ROW is separate, never the wallet.
//
// PRIVACY (§41/§42, mirrored from ai_media_jobs.ts): this table NEVER stores
// the user's generation PROMPT. It only exists because Venice video/music are
// ASYNC (queue → poll over minutes, unlike image's one-shot sync call), so a
// job must survive across queue redeliveries that can arrive long after the
// originating request closure is gone. The prompt is used exactly once,
// inline, at submission time (lib/venice_media.ts's runVeniceVideo/
// runVeniceMusic) to call Venice's queue endpoint; only the returned
// `venice_queue_id` — never the prompt — is persisted, so a redelivered POLL
// message can always safely resume (it only ever needs the queue id to ask
// Venice "is it done yet").
import type { Env } from "../types";
import {
  reserveAiJob, settleAiJob, releaseAiJob,
  type AiModality, type UsageUnits, type ReserveAiJobResult,
} from "./ai_billing";
import { track, trackException } from "../hooks";

export type VeniceMediaJobKind = "venice_video_generate" | "venice_music_generate";
export type VeniceMediaJobStatus = "submitting" | "polling" | "succeeded" | "failed" | "cancelled";

export const MODALITY_BY_VENICE_KIND: Record<VeniceMediaJobKind, AiModality> = {
  venice_video_generate: "video",
  venice_music_generate: "audio",
};

export interface VeniceMediaJobRecord {
  job_id: string;
  owner_uid: string;
  conv_id: string;
  kind: VeniceMediaJobKind;
  status: VeniceMediaJobStatus;
  venice_queue_id: string | null;
  is_private: boolean;
  tier: "free" | "paid";
  has_source_image: boolean;
  duration_seconds: number | null;
  label: string | null;
  capability: string;
  model: string;
  reservation_id: string | null;
  artifact_media_id: string | null;
  error_code: string | null;
  attempts: number;
  deadline_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function now(): number { return Date.now(); }

function rowToRecord(r: any): VeniceMediaJobRecord {
  return {
    job_id: r.job_id, owner_uid: r.owner_uid, conv_id: r.conv_id,
    kind: r.kind, status: r.status,
    venice_queue_id: r.venice_queue_id ?? null,
    is_private: Number(r.is_private) === 1,
    tier: r.tier === "paid" ? "paid" : "free",
    has_source_image: Number(r.has_source_image) === 1,
    duration_seconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
    label: r.label ?? null,
    capability: r.capability, model: r.model,
    reservation_id: r.reservation_id ?? null,
    artifact_media_id: r.artifact_media_id ?? null,
    error_code: r.error_code ?? null,
    attempts: Number(r.attempts ?? 0),
    deadline_at: Number(r.deadline_at),
    created_at: Number(r.created_at), updated_at: Number(r.updated_at),
    completed_at: r.completed_at != null ? Number(r.completed_at) : null,
  };
}

export async function getVeniceMediaJob(env: Env, jobId: string): Promise<VeniceMediaJobRecord | null> {
  try {
    const r = await env.DB_MEDIA.prepare("SELECT * FROM venice_media_jobs WHERE job_id=?1").bind(jobId).first<any>();
    return r ? rowToRecord(r) : null;
  } catch (e) {
    void trackException(env, e, { route: "venice_media_jobs.getVeniceMediaJob", handled: true, extra: { job_id: jobId } });
    return null;
  }
}

// [§66] Deliberately conservative — Venice's models are not (yet) in
// ai_billing.ts's AI_PRICE_CATALOG (a different agent's file ownership), so
// `rateFor()` falls back to AI_DEFAULT_RATE for the RESERVE-time estimate.
// That default carries no avSecondMicroUsd/imageOutputPerM term, so an
// avSeconds-only usage estimate would under-reserve to near-zero; a small
// fixed input/output token estimate keeps the reservation non-trivial without
// this file inventing a price ai_billing.ts doesn't own. Settlement (below)
// still reports honestly via cost_source:'unknown' when no provider cost is
// available, same as the existing Venice image path.
const RESERVE_INPUT_TOKENS = 300;
const RESERVE_OUTPUT_TOKENS = 0;

export interface CreateVeniceMediaJobInput {
  ownerUid: string;
  convId: string;
  kind: VeniceMediaJobKind;
  capability: string;
  model: string;
  isPrivate: boolean;
  tier: "free" | "paid";
  hasSourceImage?: boolean;
  durationSeconds?: number | null;
  label?: string | null;
  deadlineMs: number; // absolute epoch ms this job must resolve by
  email?: string | null;
  jobId?: string;
  // [VENICE-TOKENS-1] Flat tariff in tokens (cfg.veniceVideoTokens /
  // cfg.veniceMusicTokens, set by the caller). When present, reserveAiJob()
  // reserves exactly this amount instead of the catalog estimate.
  flatPriceTokens?: number | null;
}

export type CreateVeniceMediaJobResult =
  | { ok: true; job: VeniceMediaJobRecord; reservation: ReserveAiJobResult }
  | { ok: false; error: string; needed?: number; balance?: number };

/**
 * Reserve wallet spend + insert the placeholder row. Mirrors
 * ai_media_jobs.ts's createAiMediaJob() shape (reserve-then-insert, release on
 * a row-insert failure) so the two job systems fail the same way even though
 * they are separate tables.
 */
export async function createVeniceMediaJob(env: Env, input: CreateVeniceMediaJobInput): Promise<CreateVeniceMediaJobResult> {
  const ownerUid = String(input.ownerUid || "").trim();
  const convId = String(input.convId || "").trim();
  if (!ownerUid || !convId) return { ok: false, error: "owner_and_conv_required" };

  const jobId = String(input.jobId || crypto.randomUUID());
  const usage: UsageUnits = { inputTokens: RESERVE_INPUT_TOKENS, outputTokens: RESERVE_OUTPUT_TOKENS };
  const reservation = await reserveAiJob(env, {
    uid: ownerUid, opId: jobId, capability: input.capability,
    modality: MODALITY_BY_VENICE_KIND[input.kind], model: input.model,
    maxInputTokens: usage.inputTokens!, maxOutputTokens: usage.outputTokens!,
    units: { avSeconds: input.durationSeconds ?? undefined },
    email: input.email ?? null,
    // [VENICE-TOKENS-1] flat tariff wins over the catalog estimate when set.
    flatPriceTokens: input.flatPriceTokens ?? undefined,
  });
  if (!reservation.ok) {
    return { ok: false, error: reservation.error || "reserve_failed", needed: reservation.needed, balance: reservation.balance };
  }

  const ts = now();
  const reservationId = reservation.metered ? reservation.ref : null;
  try {
    await env.DB_MEDIA.prepare(
      `INSERT INTO venice_media_jobs
         (job_id, owner_uid, conv_id, kind, status, venice_queue_id, is_private, tier, has_source_image,
          duration_seconds, label, capability, model, reservation_id, artifact_media_id, error_code,
          attempts, deadline_at, created_at, updated_at, completed_at)
       VALUES (?1,?2,?3,?4,'submitting',NULL,?5,?6,?7,?8,?9,?10,?11,?12,NULL,NULL,0,?13,?14,?14,NULL)`,
    ).bind(
      jobId, ownerUid, convId, input.kind, input.isPrivate ? 1 : 0, input.tier,
      input.hasSourceImage ? 1 : 0, input.durationSeconds ?? null, input.label ? String(input.label).slice(0, 200) : null,
      input.capability, input.model, reservationId, input.deadlineMs, ts,
    ).run();
  } catch (e) {
    await releaseAiJob(env, reservation, { uid: ownerUid, opId: jobId, capability: input.capability, reason: "job_row_insert_failed" }).catch(() => {});
    void trackException(env, e, { uid: ownerUid, route: "venice_media_jobs.createVeniceMediaJob", handled: true, extra: { job_id: jobId, kind: input.kind } });
    return { ok: false, error: "internal_error" };
  }

  void track(env, ownerUid, "venice_media_job_created", "avaai", {
    job_id: jobId, kind: input.kind, conv_id: convId, metered: reservation.metered, tier: input.tier,
  });
  const job = await getVeniceMediaJob(env, jobId);
  return job ? { ok: true, job, reservation } : { ok: false, error: "internal_error" };
}

/** submitting -> polling, with Venice's own queue id attached. Conditional
 *  UPDATE so a duplicate attach (should never happen — one submission per
 *  job) is a safe no-op rather than a double-write. */
export async function attachVeniceQueueId(env: Env, jobId: string, veniceQueueId: string): Promise<boolean> {
  try {
    const res = await env.DB_MEDIA.prepare(
      "UPDATE venice_media_jobs SET status='polling', venice_queue_id=?2, updated_at=?3 WHERE job_id=?1 AND status='submitting'",
    ).bind(jobId, veniceQueueId, now()).run();
    return (res.meta?.changes ?? 0) > 0;
  } catch (e) {
    void trackException(env, e, { route: "venice_media_jobs.attachVeniceQueueId", handled: true, extra: { job_id: jobId } });
    return false;
  }
}

/** Record one more poll attempt. Best-effort, never throws — a counter write
 *  must not be able to fail the poll itself. */
export async function bumpVeniceMediaJobAttempt(env: Env, jobId: string): Promise<number> {
  try {
    await env.DB_MEDIA.prepare(
      "UPDATE venice_media_jobs SET attempts=attempts+1, updated_at=?2 WHERE job_id=?1 AND status='polling'",
    ).bind(jobId, now()).run();
    const row = await env.DB_MEDIA.prepare("SELECT attempts FROM venice_media_jobs WHERE job_id=?1").bind(jobId).first<{ attempts: number }>();
    return Number(row?.attempts ?? 0);
  } catch {
    return 0;
  }
}

export interface CompleteVeniceMediaJobInput {
  jobId: string;
  artifactMediaId: string;
  settlement: { modelActual: string; usage: UsageUnits; providerCostUsdMicro?: number };
  email?: string | null;
}
export type CompleteVeniceMediaJobResult = { ok: true; job: VeniceMediaJobRecord } | { ok: false; error: string };

/** polling -> succeeded + settle (ai_billing.ts settleAiJob, exactly once by
 *  job_id). Idempotent: a replay against an already-succeeded job is a no-op. */
export async function completeVeniceMediaJob(env: Env, input: CompleteVeniceMediaJobInput): Promise<CompleteVeniceMediaJobResult> {
  const job = await getVeniceMediaJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "succeeded") return { ok: true, job }; // idempotent replay

  const ts = now();
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE venice_media_jobs SET status='succeeded', artifact_media_id=?2, completed_at=?3, updated_at=?3 WHERE job_id=?1 AND status='polling'",
  ).bind(input.jobId, input.artifactMediaId, ts).run();
  if ((upd.meta?.changes ?? 0) === 0) {
    const cur = await getVeniceMediaJob(env, input.jobId);
    if (cur?.status === "succeeded") return { ok: true, job: cur };
    return { ok: false, error: cur ? `invalid_state:${cur.status}` : "not_found" };
  }

  if (job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await settleAiJob(env, reservation, {
      opId: input.jobId, uid: job.owner_uid, capability: job.capability, modality: MODALITY_BY_VENICE_KIND[job.kind],
      modelRequested: job.model, modelActual: input.settlement.modelActual, usage: input.settlement.usage,
      providerCostUsdMicro: input.settlement.providerCostUsdMicro, email: input.email ?? null,
    }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "venice_media_jobs.completeVeniceMediaJob", method: "settleAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }

  void track(env, job.owner_uid, "venice_media_job_completed", "avaai", { job_id: input.jobId, kind: job.kind, status: "succeeded" });
  const finalRow = await getVeniceMediaJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}

export interface FailVeniceMediaJobInput {
  jobId: string;
  errorCode: string; // short safe code only — never a raw provider message
  reason: string;
}
export type FailVeniceMediaJobResult = { ok: true; job: VeniceMediaJobRecord } | { ok: false; error: string };

/** -> failed, releasing (never billing) the reservation. Idempotent: a replay
 *  against an already-terminal job is a no-op, never a double release. */
export async function failVeniceMediaJob(env: Env, input: FailVeniceMediaJobInput): Promise<FailVeniceMediaJobResult> {
  const job = await getVeniceMediaJob(env, input.jobId);
  if (!job) return { ok: false, error: "not_found" };
  if (job.status === "failed" || job.status === "cancelled" || job.status === "succeeded") {
    return { ok: true, job }; // idempotent
  }
  const ts = now();
  const errorCode = String(input.errorCode || "unknown_error").slice(0, 64);
  const upd = await env.DB_MEDIA.prepare(
    "UPDATE venice_media_jobs SET status='failed', error_code=?2, updated_at=?3 WHERE job_id=?1 AND status IN ('submitting','polling')",
  ).bind(input.jobId, errorCode, ts).run();

  if ((upd.meta?.changes ?? 0) > 0 && job.reservation_id) {
    const reservation: ReserveAiJobResult = { ok: true, metered: true, reserved_tokens: 0, ref: job.reservation_id };
    await releaseAiJob(env, reservation, { uid: job.owner_uid, opId: input.jobId, capability: job.capability, reason: input.reason || errorCode }).catch((e) => {
      void trackException(env, e, { uid: job.owner_uid, route: "venice_media_jobs.failVeniceMediaJob", method: "releaseAiJob", handled: true, extra: { job_id: input.jobId } });
    });
  }
  void track(env, job.owner_uid, "venice_media_job_failed", "avaai", { job_id: input.jobId, kind: job.kind, error_code: errorCode, reason: input.reason });
  const finalRow = await getVeniceMediaJob(env, input.jobId);
  return { ok: true, job: finalRow! };
}
