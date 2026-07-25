// [AVA-MEDIA-JOB-1] Background consumer + producer-side enqueue helper for
// the durable AI media job queue. SELF-CONSUMED by this worker (avatok-api),
// the SAME pattern as money-settlements / liveness-verify / contacts-chunk in
// worker/src/index.ts — NOT the separate `consumers/` package, because
// ai_media_jobs.ts needs this worker's D1 (DB_MEDIA) + WalletDO bindings,
// which the consumers/worker split forbids importing across (see
// worker/wrangler.toml's LIVE-QUEUE-1 comment for the identical rationale).
//
// SCOPE OF [AVA-MEDIA-JOB-1]: this file wires the CLAIM -> DISPATCH ->
// COMPLETE/FAIL state machine end-to-end and proves it round-trips
// (reservation taken -> job claimed -> job fails cleanly -> reservation
// released) for all five kinds. The actual provider pipelines (image
// generation, PDF summarize/translate, audio STT/translate) are NOT
// implemented here — migrating them onto this backbone is the explicit scope
// of the follow-on issues named on each KIND_HANDLERS entry below (§50 items
// 2-4 of Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md). Until a
// handler is replaced, every job of that kind fails fast with error_code
// NOT_IMPLEMENTED and its reservation is released — it never hangs and it
// never charges.
//
// QUEUE BINDING (Q_AI_MEDIA / queue "ai-media-jobs"): NOT YET declared in
// wrangler.toml or worker/src/types.ts's Env (out of this issue's file
// ownership — see the implementing agent's HANDOFF). Until the binding
// exists, enqueueAiMediaJob() below falls back to ctx.waitUntil(...) inline
// processing, exactly like the existing LIVENESS_QUEUE fallback
// (worker/src/routes/liveness.ts) — job creation is never blocked on queue
// infra existing yet.
import type { Env } from "../types";
import {
  claimAiMediaJob, completeAiMediaJob, failAiMediaJob, requeueAiMediaJob,
  type AiMediaJobKind, type AiMediaJobRecord,
} from "../lib/ai_media_jobs";
import { trackException } from "../hooks";

export interface AiMediaJobQueueMsg {
  job_id: string;
  kind: AiMediaJobKind;
}

/** Thrown by a kind handler to request a queue-level retry (CF redelivers up
 * to the consumer's configured max_retries). Any OTHER thrown/caught error is
 * treated as terminal — failAiMediaJob() runs once and the message is acked,
 * never retried. */
class RetryableJobError extends Error {}

const PROVIDER_TIMEOUT_MS = 45_000; // outage guard, mirrors this codebase's existing per-step ceiling (Part V §30d)

// ---------------------------------------------------------------------------
// Per-kind handlers. Each is a pure "do the provider work, return the
// artifact + settlement usage" function — completeAiMediaJob()/
// failAiMediaJob() are called ONCE by the dispatcher below, never by a
// handler directly, so "call complete/fail exactly once" holds by
// construction rather than by every handler remembering to do it.
// ---------------------------------------------------------------------------
interface HandlerResult {
  artifact: { mediaId: string; mimeType?: string | null; fileName?: string | null; language?: string | null };
  settlement: {
    modelActual: string;
    usage: { inputTokens?: number; outputTokens?: number; images?: number; imageOutputTokens?: number; ocrPages?: number; avSeconds?: number };
    providerCostUsdMicro?: number;
  };
}

type KindHandler = (env: Env, job: AiMediaJobRecord) => Promise<HandlerResult>;

async function notImplemented(_env: Env, _job: AiMediaJobRecord): Promise<HandlerResult> {
  throw new Error("NOT_IMPLEMENTED");
}

// [AVA-IMAGE-UX-1] migrates routes/ava_image.ts's generateImage()/
// storePublicImage() onto this job (§44) — replace this stub with that call.
const handleImageGenerate: KindHandler = notImplemented;
// [AVA-DOC-ARTIFACT-1] migrates routes/ava_copilot.ts's doc summarize/
// translate onto artifact-producing jobs (§45) — replace these stubs.
const handleDocSummarize: KindHandler = notImplemented;
const handleDocTranslate: KindHandler = notImplemented;
// [AVA-AUDIO-ARTIFACT-1] migrates routes/stt.ts onto transcript/translated-
// audio artifacts (§46) — replace these stubs.
const handleAudioTranscribe: KindHandler = notImplemented;
const handleAudioTranslate: KindHandler = notImplemented;

const KIND_HANDLERS: Record<AiMediaJobKind, KindHandler> = {
  image_generate: handleImageGenerate,
  doc_summarize: handleDocSummarize,
  doc_translate: handleDocTranslate,
  audio_transcribe: handleAudioTranscribe,
  audio_translate: handleAudioTranslate,
};

/** Best-effort producer-side enqueue with an inline-waitUntil fallback —
 * mirrors worker/src/routes/liveness.ts's LIVENESS_QUEUE pattern exactly.
 * `env.Q_AI_MEDIA` is read via an `any` cast because the binding is not yet
 * declared on Env (see file header / HANDOFF) — this keeps the code correct
 * and functional (via the fallback) whether or not the binding exists. */
export async function enqueueAiMediaJob(env: Env, ctx: ExecutionContext | undefined, jobId: string, kind: AiMediaJobKind): Promise<void> {
  try {
    const q = (env as any).Q_AI_MEDIA as Queue | undefined;
    if (q) { await q.send({ job_id: jobId, kind } as AiMediaJobQueueMsg); return; }
  } catch (e) {
    console.error("[ai_media] Q_AI_MEDIA.send failed, falling back to waitUntil:", String(e));
  }
  const run = runAiMediaJobMessage(env, { job_id: jobId, kind }).catch(() => {});
  if (ctx) ctx.waitUntil(run); else await run;
}

/**
 * The queue consumer entrypoint — worker/src/index.ts's queue() dispatches
 * every "ai-media-jobs" message here (and enqueueAiMediaJob()'s ctx.waitUntil
 * fallback calls it directly when the queue binding doesn't exist yet).
 *
 * Claims before work (never runs a provider call against an unclaimed job).
 * On success, calls completeAiMediaJob() exactly once. On a non-retryable
 * failure, calls failAiMediaJob() exactly once and returns normally (message
 * acked, no retry). On a RETRYABLE failure (provider timeout / transient
 * network error), reverts the job to 'queued' and RETHROWS so
 * worker/src/index.ts's existing queue() catch -> msg.retry() path
 * redelivers it (same idiom as money-settlements/liveness-verify there).
 */
export async function runAiMediaJobMessage(env: Env, msg: AiMediaJobQueueMsg): Promise<void> {
  const jobId = String(msg?.job_id || "");
  if (!jobId) return; // malformed message — nothing to do, ack and move on

  const claimed = await claimAiMediaJob(env, jobId);
  if (!claimed.ok) return; // already claimed/terminal — safe no-op (at-least-once redelivery)
  const job = claimed.job;

  const handler = KIND_HANDLERS[job.kind];
  try {
    const result = await Promise.race([
      handler(env, job),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RetryableJobError("provider_timeout")), PROVIDER_TIMEOUT_MS)),
    ]);
    await completeAiMediaJob(env, { jobId, artifact: result.artifact, settlement: result.settlement });
  } catch (e: any) {
    if (e instanceof RetryableJobError) {
      await requeueAiMediaJob(env, jobId);
      void trackException(env, e, { uid: job.owner_uid, route: "queues.ai_media", handled: true, extra: { job_id: jobId, kind: job.kind, retryable: true } });
      throw e; // let index.ts's existing catch -> msg.retry() redeliver
    }
    const errorCode = e?.message === "NOT_IMPLEMENTED" ? "NOT_IMPLEMENTED" : "PROVIDER_ERROR";
    await failAiMediaJob(env, { jobId, errorCode, reason: String(e?.message ?? e).slice(0, 160) });
    void trackException(env, e, { uid: job.owner_uid, route: "queues.ai_media", handled: true, extra: { job_id: jobId, kind: job.kind, retryable: false } });
    // return normally — ack, no retry: the job has a clean terminal state.
  }
}
