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
  claimSongCover, finishSongCover, claimVeniceMediaDelivery,
  claimVeniceDeliveryNotification, finishVeniceDeliveryNotification,
  type VeniceMediaJobKind, type VeniceMediaJobRecord,
} from "../lib/venice_media_jobs";
import { veniceRetrieveVideo, veniceRetrieveAudio, veniceRoute, veniceGenerateImage, classifyVeniceError } from "../lib/venice";
import { registerArtifactMedia, presignDigitalReadUrl } from "../routes/media";
import { reserveAiJob, settleAiJob, releaseAiJob } from "../lib/ai_billing";
import { moderate, moderateGeneratedImage } from "../lib/moderation";
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
 * message's `kind`. Polling is safe under Queue at-least-once delivery; the
 * finished artifact crosses an atomic polling -> delivering lease before any
 * settlement or chat notification, so duplicate queue messages cannot deliver
 * the same song/video twice.
 */
export async function runVeniceMediaJobMessage(env: Env, msg: VeniceMediaQueueMsg): Promise<void> {
  const jobId = String(msg?.job_id || "");
  if (!jobId) return;
  const job = await getVeniceMediaJob(env, jobId);
  if (!job) return;
  // Resume a crash after the artifact was durably staged but before settlement.
  if (job.status === "delivering" && job.artifact_media_id) {
    await finalizeVeniceMediaDelivery(env, job);
    return;
  }
  // A successful row may still need its independently leased chat notification
  // or best-effort song cover after a prior Worker died.
  if (job.status === "succeeded") {
    await notifyVeniceMediaDelivery(env, job);
    if ((job.kind === "venice_music_generate" || job.kind === "venice_video_generate") && job.cover_status !== "succeeded" && job.cover_status !== "failed") {
      const coverTerminal = await generateSongCover(env, job);
      if (!coverTerminal) await enqueueVeniceMediaPoll(env, job.job_id, job.kind, 30);
    }
    return;
  }
  // Not yet submitted (queue id unset) or another non-pollable terminal state.
  if (job.status !== "polling" || !job.venice_queue_id) return;

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
      await failTerminal(env, job, classifyVeniceError(e), "poll_exception");
    }
    return;
  }

  if (result.bytes && result.bytes.byteLength > 0) {
    // Bytes in hand — that IS completion, whatever the status string says.
    await deliverVeniceMedia(env, job, result.bytes, result.mime);
    return;
  }
  if (isFailureStatus(result.status)) {
    await failTerminal(env, job, /auth|key|forbid/i.test(result.status) ? "provider_auth" : /capacity|balance|quota/i.test(result.status) ? "provider_capacity" : "provider_unavailable", `venice_status:${result.status}`);
    return;
  }
  // Still JSON/pending (QUEUED, PROCESSING, or anything unrecognized) —
  // re-enqueue within the deadline.
  await enqueueVeniceMediaPoll(env, jobId, job.kind, nextDelaySeconds(attempt));
}

/** Mark the job failed (releasing, never billing, the reservation) and post a
 *  compatibility failure envelope carrying the same job metadata. Current
 *  clients hydrate/update the single failed job card and suppress the legacy
 *  bubble; old clients still show the apology text. */
async function failTerminal(env: Env, job: VeniceMediaJobRecord, errorCode: string, reason: string): Promise<void> {
  const failed = await failVeniceMediaJob(env, { jobId: job.job_id, errorCode, reason });
  if (!failed.ok || !failed.transitioned) return;
  const text = job.kind === "venice_video_generate"
    ? "I couldn't finish that video — please try again."
    : "I couldn't finish that track — please try again.";
  await postAvaMessage(env, {
    ownerUid: job.owner_uid, conv: job.conv_id, text, private: job.is_private,
    source: job.kind === "venice_video_generate" ? "video" : "music",
    meta: { job_id: job.job_id, media_job_kind: job.kind },
    client_id: `venice-failure:${job.job_id}`,
  }).catch(() => {});
  void track(env, job.owner_uid, "venice_media_job_terminal_failed_notified", "avaai", {
    job_id: job.job_id, kind: job.kind, error_code: errorCode, reason, attempts: job.attempts,
  });
}

/** Best-effort square cover sidecar for completed songs. The song remains
 * playable if cover generation, storage, or its separate one-Token reserve
 * fails. A stable operation id makes reserve/settle idempotent. */
async function generateSongCover(env: Env, job: VeniceMediaJobRecord): Promise<boolean> {
  if (job.kind !== "venice_music_generate" && job.kind !== "venice_video_generate") return true;
  if (!(await claimSongCover(env, job.job_id))) {
    const current = await getVeniceMediaJob(env, job.job_id);
    return current?.cover_status === "succeeded" || current?.cover_status === "failed";
  }
  const opId = `song-cover:${job.job_id}`;
  const capability = "media_song_cover_generate";
  const model = veniceRoute("image", "free").model;
  const email = await emailFor(env, job.owner_uid).catch(() => null);
  const reservation = await reserveAiJob(env, {
    uid: job.owner_uid, opId, capability, modality: "image", model,
    maxInputTokens: 0, maxOutputTokens: 0, units: { images: 1 },
    flatPriceTokens: 1, email,
  });
  if (!reservation.ok) {
    await finishSongCover(env, job.job_id, null).catch(() => {});
    void track(env, job.owner_uid, "venice_song_cover_failed", "avaai", {
      job_id: job.job_id, reason: reservation.error || "reserve_failed",
    });
    return true;
  }

  try {
    const title = job.song_title || "Untitled track";
    const description = job.song_description || "A focused original track shaped by the requested sound and mood.";
    const prompt = job.kind === "venice_video_generate"
      ? `Full-frame cinematic thumbnail image for a short video titled "${title}". ${description} Show one clear representative moment, edge-to-edge composition, no borders, no text, no letters, no logos, no watermark.`
      : `Square album cover artwork for a song titled "${title}". Study this song's description as the creative brief: ${description} Translate its genre, rhythm, cultural setting, instruments, emotional tone, and lyrical imagery into a vivid, specific scene. If it suggests Caribbean reggae, dancehall, or island funk, use unmistakable warm Caribbean color, movement, tropical texture, and a lively street or beach atmosphere rather than a generic music graphic. Cinematic, polished, emotionally expressive, no text, no letters, no logos, no watermark.`;
    const promptVerdict = await moderate(env, { text: prompt, field: "venice_image_prompt" });
    if (!promptVerdict.safe) throw new Error("cover_prompt_blocked");
    const seedWords = new Uint32Array(1);
    crypto.getRandomValues(seedWords);
    const { b64 } = await veniceGenerateImage(env as any, model, prompt, {
      aspectRatio: "1:1", format: "png", seed: 1 + (seedWords[0] % 999_999_999),
    });
    const bin = atob(b64);
    const coverBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) coverBytes[i] = bin.charCodeAt(i);
    const outputVerdict = await moderateGeneratedImage(env, job.owner_uid, coverBytes);
    if (outputVerdict.blocked) throw new Error("cover_output_blocked");
    const stored = await registerArtifactMedia(env, {
      uid: job.owner_uid, bytes: coverBytes, mimeType: "image/png",
      fileName: `ava-${job.kind === "venice_video_generate" ? "video-thumbnail" : "song-cover"}-${job.job_id.slice(0, 8)}.png`,
      category: "image", sensitivity: "private",
    });
    const settled = await settleAiJob(env, reservation, {
      opId, uid: job.owner_uid, capability, modality: "image",
      modelRequested: model, modelActual: model, usage: { images: 1 },
      flatChargeTokens: 1, email,
    });
    if (!settled.ok) throw new Error("cover_settlement_failed");
    await finishSongCover(env, job.job_id, stored.id);
    await postAvaMessage(env, {
      ownerUid: job.owner_uid, conv: job.conv_id, text: job.kind === "venice_video_generate" ? "Video thumbnail ready." : "Song artwork ready.",
      source: job.kind === "venice_video_generate" ? "video" : "music", private: job.is_private,
      meta: { job_id: job.job_id, media_job_kind: job.kind },
      client_id: `venice-cover:${job.job_id}`,
    }).catch(() => {});
    void track(env, job.owner_uid, job.kind === "venice_video_generate" ? "venice_video_thumbnail_completed" : "venice_song_cover_completed", "avaai", {
      job_id: job.job_id, cover_media_id: stored.id, charged_tokens: settled.charged_tokens,
    });
    return true;
  } catch (e) {
    await releaseAiJob(env, reservation, {
      uid: job.owner_uid, opId, capability, reason: "song_cover_failed",
    }).catch(() => {});
    await finishSongCover(env, job.job_id, null).catch(() => {});
    void trackException(env, e, {
      uid: job.owner_uid, route: "queues.venice_media.generateSongCover", handled: true,
      extra: { job_id: job.job_id },
    });
    return true;
  }
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
  let deliveryUrl: string | null = null;
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
    deliveryUrl = r.url ?? await presignDigitalReadUrl(env, r.key);
    if (!deliveryUrl) {
      await failTerminal(env, job, "artifact_unavailable", "private_artifact_url_unavailable");
      return;
    }
  } catch (e) {
    void trackException(env, e, {
      uid: job.owner_uid, route: "queues.venice_media", handled: true,
      extra: { job_id: job.job_id, kind: job.kind, stage: "store" },
    });
    const msg = String((e as any)?.message ?? e ?? "");
    await failTerminal(env, job, /insufficient_balance/.test(msg) ? "insufficient_balance" : "provider_unavailable", "store_failed");
    return;
  }

  // Only the winner of this atomic state transition may settle or notify.
  if (!(await claimVeniceMediaDelivery(env, job.job_id, stored.id))) return;
  const claimed = await getVeniceMediaJob(env, job.job_id);
  if (!claimed) throw new Error("venice_delivery_claim_lost");
  await finalizeVeniceMediaDelivery(env, claimed, deliveryUrl ?? undefined);
}

async function artifactUrlFor(env: Env, mediaId: string | null): Promise<string | undefined> {
  if (!mediaId) return undefined;
  const row = await env.DB_MEDIA.prepare(
    "SELECT key, visibility, storage FROM user_media WHERE id=?1",
  ).bind(mediaId).first<{ key: string; visibility: string; storage: string }>();
  if (!row) return undefined;
  if (row.storage === "digital" || row.visibility === "private") {
    return (await presignDigitalReadUrl(env, row.key)) ?? undefined;
  }
  return `${env.BLOSSOM_BASE_URL}/${row.key}`;
}

async function finalizeVeniceMediaDelivery(
  env: Env, job: VeniceMediaJobRecord, knownUrl?: string,
): Promise<void> {
  if (!job.artifact_media_id) throw new Error("venice_delivery_artifact_missing");
  const completed = await completeVeniceMediaJob(env, {
    jobId: job.job_id, artifactMediaId: job.artifact_media_id,
    // Venice supplies no per-call cost, so completion settles the exact fixed
    // retail tariff persisted with the reservation (10 music / 45 video at
    // current defaults) rather than releasing the reservation as unknown.
    settlement: { modelActual: job.model, usage: { avSeconds: job.duration_seconds ?? undefined } },
  });
  if (!completed.ok) throw new Error(`venice_delivery_${completed.error}`);
  await notifyVeniceMediaDelivery(env, completed.job, knownUrl);
  if (completed.job.kind === "venice_music_generate" || completed.job.kind === "venice_video_generate") {
    await enqueueVeniceMediaPoll(env, completed.job.job_id, completed.job.kind);
  }
}

async function notifyVeniceMediaDelivery(
  env: Env, job: VeniceMediaJobRecord, knownUrl?: string,
): Promise<void> {
  if (job.delivery_status === "sent") return;
  if (!(await claimVeniceDeliveryNotification(env, job.job_id))) return;
  try {
    // Mint rather than persist private URLs; their credentials expire in 900s.
    const mediaRef = knownUrl ?? await artifactUrlFor(env, job.artifact_media_id);
    if (!mediaRef) throw new Error("private_artifact_url_unavailable");
    const caption = job.kind === "venice_video_generate" ? "Here's your video ✨" : "Here's your track ✨";
    const posted = await postAvaMessage(env, {
      ownerUid: job.owner_uid, conv: job.conv_id, text: caption, media_ref: mediaRef,
      source: job.kind === "venice_video_generate" ? "video" : "music",
      private: job.is_private, meta: { job_id: job.job_id, media_job_kind: job.kind },
      client_id: `venice-delivery:${job.job_id}`,
    });
    if (!posted.ok) throw new Error(`venice_delivery_post_failed:${posted.error || "unknown"}`);
    await finishVeniceDeliveryNotification(env, job.job_id, true);

    const email = await emailFor(env, job.owner_uid).catch(() => null);
    await trackUser(env, job.owner_uid, email, "venice_media_delivered", "avaai", {
      job_id: job.job_id, kind: job.kind, tier: job.tier, private: job.is_private,
      attempts: job.attempts, model: job.model, has_source_image: job.has_source_image,
      duration_seconds: job.duration_seconds,
    }).catch(() => {});
  } catch (e) {
    await finishVeniceDeliveryNotification(env, job.job_id, false).catch(() => {});
    throw e;
  }
}
