// [VENICE-VID-1 / VENICE-MUS-1] Poll consumer + producer for Venice AI video/
// music generation jobs — Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md.
//
// QUEUE REUSE, DELIBERATE: this shares the EXISTING Q_AI_MEDIA queue
// ("ai-media-jobs", self-consumed by this worker — worker/src/index.ts's
// queue() dispatches every message on that queue name to
// queues/ai_media.ts's runAiMediaJobMessage(), which now discriminates
// venice_* kinds to THIS file's runVeniceMediaJobMessage() before touching
// the ai_media_jobs table — see that file's comment at the top of
// runAiMediaJobMessage). A dedicated queue was considered and rejected:
// provisioning one needs a new wrangler.toml [[queues]] block + a new Env
// binding (worker/src/types.ts), both infra/deploy steps outside this pass's
// scope ("no git, no wrangler, no deploys"). Reusing the already-bound,
// already-self-consumed Q_AI_MEDIA needs zero infra changes — and its Env
// type (`Queue<{ job_id: string; kind: string }>`) already carries `kind` as
// a plain string, not the closed `AiMediaJobKind` union, so this was already
// safe to widen.
//
// STATE: worker/src/lib/venice_media_jobs.ts's OWN small D1 table
// (venice_media_jobs) — see that file's header for why it is not a new kind
// on ai_media_jobs.ts's closed AiMediaJobKind union.
import type { Env } from "../types";
import {
  getVeniceMediaJob, bumpVeniceMediaJobAttempt, completeVeniceMediaJob, failVeniceMediaJob,
  type VeniceMediaJobKind, type VeniceMediaJobRecord,
} from "../lib/venice_media_jobs";
import { veniceRetrieveVideo, veniceRetrieveAudio } from "../lib/venice";
import { registerArtifactMedia, presignDigitalReadUrl } from "../routes/media";
import { postAvaMessage } from "../routes/ava_thread";
import { track, trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";

export interface VeniceMediaQueueMsg {
  job_id: string;
  kind: VeniceMediaJobKind;
}

export function isVeniceMediaKind(kind: unknown): kind is VeniceMediaJobKind {
  return kind === "venice_video_generate" || kind === "venice_music_generate";
}

/** Queue-only producer — mirrors queues/ai_media.ts's enqueueAiMediaJob() on
 *  the SAME Q_AI_MEDIA queue (see file header for why no new binding). */
export async function enqueueVeniceMediaPoll(
  env: Env, jobId: string, kind: VeniceMediaJobKind, delaySeconds = 0,
): Promise<void> {
  await env.Q_AI_MEDIA.send(
    { job_id: jobId, kind },
    delaySeconds > 0 ? { delaySeconds } : undefined,
  );
}

// Backoff schedule for "still processing, ask again later" — Venice gave no
// ETA in any response shape lib/venice.ts's veniceRetrieveVideo/Audio expose,
// so this is a fixed ramp (8s, 14s, 20s, ... capped 45s) rather than a
// provider-informed delay.
const POLL_BACKOFF_BASE_S = 8;
const POLL_BACKOFF_STEP_S = 6;
const POLL_BACKOFF_MAX_S = 45;
function nextDelaySeconds(attempt: number): number {
  return Math.min(POLL_BACKOFF_MAX_S, POLL_BACKOFF_BASE_S + attempt * POLL_BACKOFF_STEP_S);
}

// Venice's queue status vocabulary isn't pinned down anywhere in this repo —
// matched loosely so a status string this code hasn't seen before defaults to
// "still pending" (re-enqueue) rather than a false terminal failure/success.
// [VENICE-API-SHAPE-1] Success is signalled by the retrieve response carrying
// the RAW MEDIA BYTES (lib/venice.ts's dual-shape veniceRetrieveMedia), so
// bytes-present is the unambiguous success signal; the status string only
// matters while the response is still JSON.
function isFailureStatus(status: string): boolean {
  return /fail|error|cancel|reject|denied/i.test(status);
}

/**
 * The queue consumer entrypoint for venice_* kinds — called from
 * queues/ai_media.ts's runAiMediaJobMessage() once it discriminates the
 * message's `kind`. Never claims/locks the job (single-poller-at-a-time isn't
 * needed: only this consumer ever re-enqueues a job's next poll, so at most
 * one message per job is in flight at a time by construction) — it just reads
 * current state, asks Venice, and either delivers, fails, or re-enqueues.
 */
export async function runVeniceMediaJobMessage(env: Env, msg: VeniceMediaQueueMsg): Promise<void> {
  const jobId = String(msg?.job_id || "");
  if (!jobId) return;
  const job = await getVeniceMediaJob(env, jobId);
  // Terminal already / not yet submitted (venice_queue_id unset) / row
  // missing — every case is a safe no-op under at-least-once queue delivery.
  if (!job || job.status !== "polling" || !job.venice_queue_id) return;

  if (Date.now() >= job.deadline_at) {
    await failTerminal(env, job, "provider_timeout", "deadline_exceeded");
    return;
  }
  const attempt = await bumpVeniceMediaJobAttempt(env, jobId);

  let result: { status: string; bytes?: Uint8Array; mime?: string };
  try {
    // [VENICE-API-SHAPE-1] retrieve REQUIRES the model alongside queue_id.
    result = job.kind === "venice_video_generate"
      ? await veniceRetrieveVideo(env as any, job.venice_queue_id, job.model)
      : await veniceRetrieveAudio(env as any, job.venice_queue_id, job.model);
  } catch (e) {
    void trackException(env, e, {
      uid: job.owner_uid, route: "queues.venice_media", handled: true,
      extra: { job_id: jobId, kind: job.kind, attempt, stage: "retrieve" },
    });
    // A network/timeout hiccup on the RETRIEVE call is not itself a Venice
    // failure verdict — retry within the deadline rather than failing the job
    // over our own transient error.
    if (Date.now() + 2000 < job.deadline_at) {
      await enqueueVeniceMediaPoll(env, jobId, job.kind, nextDelaySeconds(attempt));
    } else {
      await failTerminal(env, job, "provider_unavailable", "poll_exception");
    }
    return;
  }

  if (result.bytes && result.bytes.byteLength > 0) {
    // Bytes in hand — that IS completion, whatever the status string says.
    await deliverVeniceMedia(env, job, result.bytes, result.mime);
    return;
  }
  if (isFailureStatus(result.status)) {
    await failTerminal(env, job, "provider_unavailable", `venice_status:${result.status}`);
    return;
  }
  // Still JSON/pending (QUEUED, PROCESSING, or anything unrecognized) —
  // re-enqueue within the deadline.
  await enqueueVeniceMediaPoll(env, jobId, job.kind, nextDelaySeconds(attempt));
}

/** Mark the job failed (releasing, never billing, the reservation) and post a
 *  plain in-thread apology. Unlike routes/ava_image.ts's fulfil(), which
 *  deliberately does NOT post a new message on failure (a job-hydrated client
 *  renders Retry from the job's own state), video/music have no client job
 *  card yet — so silence here would leave the user with only the earlier
 *  "it'll appear here in a few minutes" ack and no resolution, ever. Posting a
 *  short failure note is the deliberate, documented deviation from the image
 *  pattern for this reason. */
async function failTerminal(env: Env, job: VeniceMediaJobRecord, errorCode: string, reason: string): Promise<void> {
  await failVeniceMediaJob(env, { jobId: job.job_id, errorCode, reason });
  const text = job.kind === "venice_video_generate"
    ? "I couldn't finish that video — please try again."
    : "I couldn't finish that track — please try again.";
  await postAvaMessage(env, {
    ownerUid: job.owner_uid, conv: job.conv_id, text, private: job.is_private,
    source: job.kind === "venice_video_generate" ? "video" : "music",
  }).catch(() => {});
  void track(env, job.owner_uid, "venice_media_job_terminal_failed_notified", "avaai", {
    job_id: job.job_id, kind: job.kind, error_code: errorCode, reason, attempts: job.attempts,
  });
}

/**
 * Download the finished artifact from Venice's URL, store it through the SAME
 * shared content-addressed artifact path every AI media artifact uses
 * (registerArtifactMedia), settle the job, and deliver it into the thread —
 * the async counterpart to routes/ava_image.ts's fulfil() success path.
 */
async function deliverVeniceMedia(env: Env, job: VeniceMediaJobRecord, bytes: Uint8Array, mime?: string): Promise<void> {
  // [VENICE-SAFE-1] OUTPUT-GATE SCOPE NOTE (v1). The image path
  // (routes/ava_image.ts's generateImageVenice) runs moderateGeneratedImage()
  // on the finished BYTES before delivery — a real backstop behind the prompt
  // gate. There is no equivalent here for VIDEO: Venice's /video/retrieve
  // response (lib/venice.ts's veniceRetrieveVideo) carries no thumbnail/
  // preview frame to scan cheaply, and this Worker has no primitive to decode
  // a video frame (no ffmpeg/codec access in the Workers runtime). So today's
  // enforcement for video is PROMPT-GATE + Venice's own provider-side
  // safe_mode ONLY — reported as a known gap, not silently assumed covered.
  // TODO(VENICE-VID-OUTPUT-GATE-1): revisit if Venice ever returns a preview
  // frame, or add an async frame-extract step before a video job is
  // considered final. Music has no comparable visual-NSFW risk, so no output
  // gate is expected for it either.
  // [VENICE-API-SHAPE-1] No separate download step — the retrieve response IS
  // the media (raw bytes; live capture showed video/mp4 and audio/flac).
  const mimeType = (mime && mime.split(";")[0].trim())
    || (job.kind === "venice_video_generate" ? "video/mp4" : "audio/flac");
  const ext = mimeType.includes("flac") ? "flac"
    : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3"
    : job.kind === "venice_video_generate" ? "mp4" : "mp3";
  const fileName = `ava-${job.kind === "venice_video_generate" ? "video" : "music"}-${job.job_id.slice(0, 8)}.${ext}`;
  let stored: { id: string; key: string };
  try {
    const r = await registerArtifactMedia(env, {
      uid: job.owner_uid, bytes, mimeType, fileName,
      // [§41] Same default as generated images
      // (lib/ai_media_jobs.ts's resolveArtifactSensitivity(env, null)): a
      // bare-prompt generation has no known-public source, so it lands in
      // the private DIGITAL bucket, not the public blossom CDN.
      sensitivity: "private",
    });
    stored = { id: r.id, key: r.key };
  } catch (e) {
    void trackException(env, e, {
      uid: job.owner_uid, route: "queues.venice_media", handled: true,
      extra: { job_id: job.job_id, kind: job.kind, stage: "store" },
    });
    const msg = String((e as any)?.message ?? e ?? "");
    await failTerminal(env, job, /insufficient_balance/.test(msg) ? "insufficient_balance" : "provider_unavailable", "store_failed");
    return;
  }

  await completeVeniceMediaJob(env, {
    jobId: job.job_id, artifactMediaId: stored.id,
    // No per-call cost is available from Venice's video/audio retrieve
    // response (same gap the image path notes — "Venice's sync image
    // response carries no per-call usage/cost fields today"), so this settles
    // with cost_source:'unknown' (ai_billing.ts charges 0 and alerts
    // AI_PRICE_UNKNOWN) until Venice models are added to AI_PRICE_CATALOG —
    // a different agent's file ownership (lib/ai_billing.ts) this wave.
    settlement: { modelActual: job.model, usage: { avSeconds: job.duration_seconds ?? undefined } },
  });

  // [B3-style contract, mirrors ai_media_jobs.ts] Mint the delivery URL fresh
  // right here rather than persisting one — a private artifact's presigned
  // URL expires in 900s, so a stored one would go stale in old chat history.
  const mediaRef = (await presignDigitalReadUrl(env, stored.key)) ?? undefined;
  const caption = job.kind === "venice_video_generate" ? "Here's your video ✨" : "Here's your track ✨";
  await postAvaMessage(env, {
    ownerUid: job.owner_uid, conv: job.conv_id, text: caption, media_ref: mediaRef,
    source: job.kind === "venice_video_generate" ? "video" : "music",
    private: job.is_private, meta: { job_id: job.job_id },
  });

  const email = await emailFor(env, job.owner_uid).catch(() => null);
  await trackUser(env, job.owner_uid, email, "venice_media_delivered", "avaai", {
    job_id: job.job_id, kind: job.kind, tier: job.tier, private: job.is_private,
    attempts: job.attempts, model: job.model, has_source_image: job.has_source_image,
    duration_seconds: job.duration_seconds,
  }).catch(() => {});
}
