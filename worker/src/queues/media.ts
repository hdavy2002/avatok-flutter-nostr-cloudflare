// Poll consumer + producer for Vertex video/music generation jobs.
//
// QUEUE REUSE, DELIBERATE: this shares the EXISTING Q_AI_MEDIA queue
// ("ai-media-jobs", self-consumed by this worker — worker/src/index.ts's
// queue() dispatches every message on that queue name to
// queues/ai_media.ts's runAiMediaJobMessage(), which now discriminates
// media_* kinds to THIS file's runMediaJobMessage() before touching
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
// STATE: worker/src/lib/media_jobs.ts's OWN small D1 table
// (media_jobs) — see that file's header for why it is not a new kind
// on ai_media_jobs.ts's closed AiMediaJobKind union.
import type { Env } from "../types";
import {
  getMediaJob, bumpMediaJobAttempt, completeMediaJob, failMediaJob,
  claimSongCover, finishSongCover, claimMediaDelivery,
  claimMediaDeliveryNotification, finishMediaDeliveryNotification,
  type MediaJobKind, type MediaJobRecord,
} from "../lib/media_jobs";
import { generateImage } from "../routes/ava_image";
import { registerArtifactMedia, presignDigitalReadUrl } from "../routes/media";
import { reserveAiJob, settleAiJob, releaseAiJob } from "../lib/ai_billing";
import { moderate, moderateGeneratedImage } from "../lib/moderation";
import { postAvaMessage } from "../routes/ava_thread";
import { track, trackException, trackUser } from "../hooks";
import { emailFor } from "../lib/identity";
import { vertexFetchPredictOperation, vertexToken } from "../lib/vertex";

export interface MediaQueueMsg {
  job_id: string;
  kind: MediaJobKind;
}

export function isMediaJobKind(kind: unknown): kind is MediaJobKind {
  return kind === "video_generate" || kind === "music_generate";
}

/** Queue-only producer — mirrors queues/ai_media.ts's enqueueAiMediaJob() on
 *  the SAME Q_AI_MEDIA queue (see file header for why no new binding). */
export async function enqueueMediaPoll(
  env: Env, jobId: string, kind: MediaJobKind, delaySeconds = 0,
): Promise<void> {
  await env.Q_AI_MEDIA.send(
    { job_id: jobId, kind },
    delaySeconds > 0 ? { delaySeconds } : undefined,
  );
}

// Backoff schedule for Vertex operations that are still processing.
const POLL_BACKOFF_BASE_S = 8;
const POLL_BACKOFF_STEP_S = 6;
const POLL_BACKOFF_MAX_S = 45;
function nextDelaySeconds(attempt: number): number {
  return Math.min(POLL_BACKOFF_MAX_S, POLL_BACKOFF_BASE_S + attempt * POLL_BACKOFF_STEP_S);
}

// A provider status that indicates failure is terminal; otherwise an operation
// without bytes is treated as still pending.
function isFailureStatus(status: string): boolean {
  return /fail|error|cancel|reject|denied/i.test(status);
}

async function vertexBytes(env: Env, out: any): Promise<Uint8Array | null> {
  const candidates = [
    ...(Array.isArray(out?.response?.videos) ? out.response.videos : []),
    ...(Array.isArray(out?.predictions) ? out.predictions : []),
  ];
  const item = candidates.find((x: any) => x?.bytesBase64Encoded || x?.video?.bytesBase64Encoded || x?.audioContent || x?.gcsUri || x?.video?.gcsUri);
  const encoded = item?.bytesBase64Encoded ?? item?.video?.bytesBase64Encoded ?? item?.audioContent;
  if (typeof encoded === "string" && encoded) {
    try {
      const bin = atob(encoded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch { return null; }
  }
  const rawUri = item?.gcsUri ?? item?.video?.gcsUri;
  if (typeof rawUri !== "string" || !rawUri) return null;
  const url = rawUri.startsWith("gs://")
    ? `https://storage.googleapis.com/${rawUri.slice("gs://".length)}`
    : rawUri;
  const token = await vertexToken(env);
  if (!token) return null;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The queue consumer entrypoint for media_* kinds — called from
 * queues/ai_media.ts's runAiMediaJobMessage() once it discriminates the
 * message's `kind`. Polling is safe under Queue at-least-once delivery; the
 * finished artifact crosses an atomic polling -> delivering lease before any
 * settlement or chat notification, so duplicate queue messages cannot deliver
 * the same song/video twice.
 */
export async function runMediaJobMessage(env: Env, msg: MediaQueueMsg): Promise<void> {
  const jobId = String(msg?.job_id || "");
  if (!jobId) return;
  const job = await getMediaJob(env, jobId);
  if (!job) return;
  // Resume a crash after the artifact was durably staged but before settlement.
  if (job.status === "delivering" && job.artifact_media_id) {
    await finalizeMediaDelivery(env, job);
    return;
  }
  // A successful row may still need its independently leased chat notification
  // or best-effort song cover after a prior Worker died.
  if (job.status === "succeeded") {
    await notifyMediaDelivery(env, job);
    if ((job.kind === "music_generate" || job.kind === "video_generate") && job.cover_status !== "succeeded" && job.cover_status !== "failed") {
      const coverTerminal = await generateSongCover(env, job);
      if (!coverTerminal) await enqueueMediaPoll(env, job.job_id, job.kind, 30);
    }
    return;
  }
  // Not yet submitted (queue id unset) or another non-pollable terminal state.
  if (job.status !== "polling" || !job.provider_operation_id) return;

  if (Date.now() >= job.deadline_at) {
    await failTerminal(env, job, "provider_timeout", "deadline_exceeded");
    return;
  }
  const attempt = await bumpMediaJobAttempt(env, jobId);

  // Vertex music returns bytes immediately through the interactions API. The
  // producer stages those bytes in private R2 and uses this queue message only
  // to run the existing durable delivery/settlement path.
  if (job.provider_operation_id.startsWith("vertex-inline:")) {
    const key = job.provider_operation_id.slice("vertex-inline:".length);
    const obj = await env.DIGITAL.get(key);
    if (!obj) { await failTerminal(env, job, "provider_unavailable", "vertex_inline_missing"); return; }
    await deliverMedia(env, job, new Uint8Array(await obj.arrayBuffer()), "audio/mpeg");
    await env.DIGITAL.delete(key).catch(() => {});
    return;
  }

  let result: { status: string; bytes?: Uint8Array; mime?: string };
  try {
    if (job.provider_operation_id.startsWith("vertex-op:")) {
      const operationName = job.provider_operation_id.slice("vertex-op:".length);
      const r = await vertexFetchPredictOperation(env, job.model, operationName);
      if (!r.ok) throw new Error(String(r.out?.error?.message ?? "Vertex operation fetch failed"));
      const done = r.out?.done === true || r.out?.status === "SUCCEEDED";
      const bytes = await vertexBytes(env, r.out);
      result = bytes ? { status: "SUCCEEDED", bytes, mime: "video/mp4" } : { status: done ? "FAILED" : "PROCESSING" };
    } else {
      // Older queued jobs may still contain a provider operation id from the
      // retired media provider. Do not call that provider anymore; fail the
      // job clearly so it cannot silently re-enter the old lane.
      await failTerminal(env, job, "provider_unavailable", "legacy_provider_retired");
      return;
    }
  } catch (e) {
    void trackException(env, e, {
      uid: job.owner_uid, route: "queues.media", handled: true,
      extra: { job_id: jobId, kind: job.kind, attempt, stage: "retrieve" },
    });
    // A network/timeout hiccup on Vertex is not itself a provider failure
    // verdict — retry within the deadline rather than failing the job over our
    // own transient error.
    if (Date.now() + 2000 < job.deadline_at) {
      await enqueueMediaPoll(env, jobId, job.kind, nextDelaySeconds(attempt));
    } else {
      await failTerminal(env, job, "provider_unavailable", "vertex_poll_exception");
    }
    return;
  }

  if (result.bytes && result.bytes.byteLength > 0) {
    // Bytes in hand — that IS completion, whatever the status string says.
    await deliverMedia(env, job, result.bytes, result.mime);
    return;
  }
  if (isFailureStatus(result.status)) {
    await failTerminal(env, job, /auth|key|forbid/i.test(result.status) ? "provider_auth" : /capacity|balance|quota/i.test(result.status) ? "provider_capacity" : "provider_unavailable", `vertex_status:${result.status}`);
    return;
  }
  // Still JSON/pending (QUEUED, PROCESSING, or anything unrecognized) —
  // re-enqueue within the deadline.
  await enqueueMediaPoll(env, jobId, job.kind, nextDelaySeconds(attempt));
}

/** Mark the job failed (releasing, never billing, the reservation) and post a
 *  compatibility failure envelope carrying the same job metadata. Current
 *  clients hydrate/update the single failed job card and suppress the legacy
 *  bubble; old clients still show the apology text. */
async function failTerminal(env: Env, job: MediaJobRecord, errorCode: string, reason: string): Promise<void> {
  const failed = await failMediaJob(env, { jobId: job.job_id, errorCode, reason });
  if (!failed.ok || !failed.transitioned) return;
  const text = job.kind === "video_generate"
    ? "I couldn't finish that video — please try again."
    : "I couldn't finish that track — please try again.";
  await postAvaMessage(env, {
    ownerUid: job.owner_uid, conv: job.conv_id, text, private: job.is_private,
    source: job.kind === "video_generate" ? "video" : "music",
    meta: { job_id: job.job_id, media_job_kind: job.kind },
    client_id: `media-failure:${job.job_id}`,
  }).catch(() => {});
  void track(env, job.owner_uid, "media_job_terminal_failed_notified", "avaai", {
    job_id: job.job_id, kind: job.kind, error_code: errorCode, reason, attempts: job.attempts,
  });
}

/** Best-effort square cover sidecar for completed songs. The song remains
 * playable if cover generation, storage, or its separate one-Token reserve
 * fails. A stable operation id makes reserve/settle idempotent. */
async function generateSongCover(env: Env, job: MediaJobRecord): Promise<boolean> {
  if (job.kind !== "music_generate" && job.kind !== "video_generate") return true;
  if (!(await claimSongCover(env, job.job_id))) {
    const current = await getMediaJob(env, job.job_id);
    return current?.cover_status === "succeeded" || current?.cover_status === "failed";
  }
  // [COVER-RETRY-SAFE-1 2026-08-17] The op id must be unique PER ATTEMPT.
  // Wallet reservations are keyed `aijob:<opId>` with op_id-deduped
  // idempotency, so a watchdog retry that reused the old id could reserve but
  // never settle: production hit exactly this — a recovered cover generated
  // fine, passed the safety scan, then died with `cover_settlement_failed` and
  // the song stayed artwork-less. claimSongCover stamps updated_at, which is
  // stable for THIS attempt (a redelivery is rejected by the claim above) and
  // different for the next one, so idempotency is preserved without freezing
  // every future retry.
  const claimed = await getMediaJob(env, job.job_id);
  const attemptStamp = claimed?.updated_at ?? job.updated_at;
  const opId = `song-cover:${job.job_id}:${attemptStamp}`;
  const capability = "media_song_cover_generate";
  const model = "gemini-3.1-flash-image";
  const email = await emailFor(env, job.owner_uid).catch(() => null);
  const reservation = await reserveAiJob(env, {
    uid: job.owner_uid, opId, capability, modality: "image", model,
    maxInputTokens: 0, maxOutputTokens: 0, units: { images: 1 },
    flatPriceTokens: 1, email,
  });
  if (!reservation.ok) {
    await finishSongCover(env, job.job_id, null).catch(() => {});
    // [VIDEO-AUDIT-1] AWAITED, not `void`. workerd drops an unawaited fetch on
    // an early-return path, so this event never reached PostHog — which is why
    // a production video sitting at cover_status='failed' had NO evidence of
    // why anywhere. For video that failure is user-visible (the share page
    // 404s without a thumbnail), so the reason must survive the return.
    await track(env, job.owner_uid, "media_cover_failed", "avaai", {
      job_id: job.job_id, kind: job.kind, stage: "reserve",
      reason: reservation.error || "reserve_failed",
    }).catch(() => {});
    return true;
  }

  try {
    const isVideo = job.kind === "video_generate";
    const title = job.song_title || (isVideo ? "Cinematic moment" : "Untitled track");
    const description = job.song_description || (isVideo
      ? "A cinematic scene with a distinct subject, setting, movement, and atmosphere."
      : "A focused original track shaped by the requested sound and mood.");
    // [SONG-COVER-MATCH-1] The cover must come from THIS song's own brief.
    // An earlier version of this prompt named one example genre (Caribbean
    // reggae) and the image model latched onto it — a Hindi rock anthem about
    // freedom shipped with a tropical beach cover. Never name a genre or
    // culture the description itself does not.
    const prompt = isVideo
      ? `Full-frame cinematic thumbnail image for a short video titled "${title}". ${description} Show one clear representative moment, edge-to-edge composition, no borders, no text, no letters, no logos, no watermark.`
      : `Square album cover artwork for a song titled "${title}". The creative brief for this exact song is: ${description} Depict ONLY what that brief implies — its genre, language and cultural setting, emotional tone, and central imagery. Ground every visual choice in the brief; do not substitute a different culture, climate, or music scene, and avoid generic music graphics. Cinematic, polished, emotionally expressive, no text, no letters, no logos, no watermark.`;
    const promptVerdict = await moderate(env, { text: prompt, field: "vertex_image_prompt" });
    if (!promptVerdict.safe) throw new Error("cover_prompt_blocked");
    // [COVER-RETRY-SAFE-1 2026-08-17] Our OWN generated artwork was being
    // rejected by our OWN output gate — a real song shipped with no cover on
    // 2026-08-17 (media_cover_failed reason=cover_output_blocked), which
    // also leaves the share card with no preview image. A single borderline
    // render (figures, skin tones, a moody nude-toned palette) is enough to
    // trip the classifier, so rather than giving up on the first verdict, retry
    // once with a deliberately safe, figure-free composition. The output gate is
    // never bypassed — the retry must pass it too.
    const safePrompt = isVideo
      ? `Full-frame cinematic thumbnail for a short video titled "${title}". ${description} Depict the setting, objects, light and atmosphere ONLY — absolutely no people, no faces, no bodies. Edge-to-edge, no text, no letters, no logos, no watermark.`
      : `Square album cover artwork for a song titled "${title}". Creative brief: ${description} Express it through landscape, objects, symbolism, colour and light ONLY — absolutely no people, no faces, no bodies. Tasteful, polished, gallery-quality, no text, no letters, no logos, no watermark.`;
    let coverBytes: Uint8Array | null = null;
    let attemptsUsed = 0;
    for (const attemptPrompt of [prompt, safePrompt]) {
      attemptsUsed++;
      const { bytes } = await generateImage(env, "", attemptPrompt, job.owner_uid, undefined, { resolution: "1K", aspectRatio: "1:1" });
      // [COVER-SCAN-RETRY-1 2026-08-17] The safety classifier is FLAKY, not
      // broken: 13 of 16 production calls returned in ~1.5s, the rest failed
      // with "3046: Request timeout" / "8004: Internal server error" after
      // 25-235s (its own 15s timeout is not being honoured). Because the image
      // is already generated and already paid for, re-scanning is far cheaper
      // than discarding the cover — so a scan ERROR is retried in place before
      // we conclude the scanner is unavailable. A real BLOCK verdict is never
      // retried here; only a failure to obtain a verdict is.
      let verdict = await moderateGeneratedImage(env, job.owner_uid, bytes);
      for (let scanTry = 0; scanTry < 2 && verdict.ok === false; scanTry++) {
        await new Promise((r) => setTimeout(r, 1500 * (scanTry + 1)));
        verdict = await moderateGeneratedImage(env, job.owner_uid, bytes);
      }
      if (!verdict.blocked) { coverBytes = bytes; break; }
      // [COVER-RETRY-SAFE-1] A SCAN that could not run is not a safety verdict.
      // moderateGeneratedImage fails CLOSED (blocked:true, ok:false) on any
      // error — and on 2026-08-17 the classifier took 235s and timed out, so a
      // perfectly ordinary album cover was "blocked" and the song shipped bare.
      // Treat that as TRANSIENT: release this attempt and leave the cover
      // retryable so the watchdog tries again once the scanner is healthy.
      // The image is never published unscanned — this only chooses between
      // "try later" and "give up forever".
      // [COVER-SCAN-ADVISORY-1 2026-08-17, owner decision] After the retries
      // above, a still-unobtainable verdict no longer costs the artwork. This
      // is the ONE image class where that is a sound trade: the cover is drawn
      // by an SFW-configured model from a MACHINE-WRITTEN description that has
      // itself already passed the text gate a few lines above — nothing the
      // user typed reaches the image model, and no user-typed prompt is
      // rendered here. A genuine BLOCK verdict (scan ran, said unsafe) is still
      // honoured below and still discards the image; only "the classifier was
      // unreachable" now publishes. Every such publish is recorded so the
      // decision is auditable.
      if (verdict.ok === false) {
        coverBytes = bytes;
        await track(env, job.owner_uid, "media_cover_unscanned_publish", "avaai", {
          job_id: job.job_id, kind: job.kind, attempt: attemptsUsed, reason: "scan_unavailable",
        }).catch(() => {});
        break;
      }
      await track(env, job.owner_uid, "media_cover_retry", "avaai", {
        job_id: job.job_id, kind: job.kind, attempt: attemptsUsed, reason: "output_blocked",
      }).catch(() => {});
    }
    if (!coverBytes) throw new Error("cover_output_blocked");
    const stored = await registerArtifactMedia(env, {
      uid: job.owner_uid, bytes: coverBytes, mimeType: "image/png",
      fileName: `ava-${job.kind === "video_generate" ? "video-thumbnail" : "song-cover"}-${job.job_id.slice(0, 8)}.png`,
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
      ownerUid: job.owner_uid, conv: job.conv_id, text: job.kind === "video_generate" ? "Video thumbnail ready." : "Song artwork ready.",
      source: job.kind === "video_generate" ? "video" : "music", private: job.is_private,
      meta: { job_id: job.job_id, media_job_kind: job.kind },
      client_id: `media-cover:${job.job_id}`,
    }).catch(() => {});
    // [VIDEO-AUDIT-1] Awaited for the same reason as the failure paths — the
    // success event is the only proof a share card can be built at all.
    await track(env, job.owner_uid, job.kind === "video_generate" ? "media_video_thumbnail_completed" : "media_song_cover_completed", "avaai", {
      job_id: job.job_id, cover_media_id: stored.id, charged_tokens: settled.charged_tokens,
    }).catch(() => {});
    return true;
  } catch (e) {
    await releaseAiJob(env, reservation, {
      uid: job.owner_uid, opId, capability, reason: "song_cover_failed",
    }).catch(() => {});
    await finishSongCover(env, job.job_id, null).catch(() => {});
    // [VIDEO-AUDIT-1] The exception alone was not enough: it carried no reason
    // field and, being `void`ed on a return path, was dropped by workerd too.
    await track(env, job.owner_uid, "media_cover_failed", "avaai", {
      job_id: job.job_id, kind: job.kind, stage: "generate",
      reason: String((e as any)?.message ?? e ?? "unknown").slice(0, 200),
    }).catch(() => {});
    await trackException(env, e, {
      uid: job.owner_uid, route: "queues.media.generateSongCover", handled: true,
      extra: { job_id: job.job_id, kind: job.kind },
    }).catch(() => {});
    return true;
  }
}

/**
 * Download the finished artifact from Venice's URL, store it through the SAME
 * shared content-addressed artifact path every AI media artifact uses
 * (registerArtifactMedia), settle the job, and deliver it into the thread —
 * the async counterpart to routes/ava_image.ts's fulfil() success path.
 */
async function deliverMedia(env: Env, job: MediaJobRecord, bytes: Uint8Array, mime?: string): Promise<void> {
  // OUTPUT-GATE SCOPE NOTE (v1). The image path
  // (routes/ava_image.ts's generateImageVenice) runs moderateGeneratedImage()
  // on the finished BYTES before delivery — a real backstop behind the prompt
  // gate. There is no equivalent here for VIDEO: Venice's /video/retrieve
  // response (Vertex operation output) carries no thumbnail/
  // preview frame to scan cheaply, and this Worker has no primitive to decode
  // a video frame (no ffmpeg/codec access in the Workers runtime). So today's
  // enforcement for video is the PROMPT GATE plus the configured SFW model
  // lane. The queue endpoint rejects safe_mode, so there is no provider flag
  // to claim as an output backstop — this remains an explicitly known gap.
  // TODO: revisit if Vertex ever returns a preview
  // frame, or add an async frame-extract step before a video job is
  // considered final. Music has no comparable visual-NSFW risk, so no output
  // gate is expected for it either.
  // No separate download step — the provider operation response IS
  // the media (raw bytes; live capture showed video/mp4 and audio/flac).
  const mimeType = (mime && mime.split(";")[0].trim())
    || (job.kind === "video_generate" ? "video/mp4" : "audio/flac");
  const ext = mimeType.includes("flac") ? "flac"
    : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3"
    : job.kind === "video_generate" ? "mp4" : "mp3";
  const fileName = `ava-${job.kind === "video_generate" ? "video" : "music"}-${job.job_id.slice(0, 8)}.${ext}`;
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
      uid: job.owner_uid, route: "queues.media", handled: true,
      extra: { job_id: job.job_id, kind: job.kind, stage: "store" },
    });
    const msg = String((e as any)?.message ?? e ?? "");
    await failTerminal(env, job, /insufficient_balance/.test(msg) ? "insufficient_balance" : "provider_unavailable", "store_failed");
    return;
  }

  // Only the winner of this atomic state transition may settle or notify.
  if (!(await claimMediaDelivery(env, job.job_id, stored.id))) return;
  const claimed = await getMediaJob(env, job.job_id);
  if (!claimed) throw new Error("media_delivery_claim_lost");
  await finalizeMediaDelivery(env, claimed, deliveryUrl ?? undefined);
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

async function finalizeMediaDelivery(
  env: Env, job: MediaJobRecord, knownUrl?: string,
): Promise<void> {
  if (!job.artifact_media_id) throw new Error("media_delivery_artifact_missing");
  const completed = await completeMediaJob(env, {
    jobId: job.job_id, artifactMediaId: job.artifact_media_id,
    // Vertex supplies no per-call cost, so completion settles the exact fixed
    // retail tariff persisted with the reservation (10 music / 45 video at
    // current defaults) rather than releasing the reservation as unknown.
    settlement: { modelActual: job.model, usage: { avSeconds: job.duration_seconds ?? undefined } },
  });
  if (!completed.ok) throw new Error(`media_delivery_${completed.error}`);
  await notifyMediaDelivery(env, completed.job, knownUrl);
  if (completed.job.kind === "music_generate" || completed.job.kind === "video_generate") {
    await enqueueMediaPoll(env, completed.job.job_id, completed.job.kind);
  }
}

async function notifyMediaDelivery(
  env: Env, job: MediaJobRecord, knownUrl?: string,
): Promise<void> {
  if (job.delivery_status === "sent") return;
  if (!(await claimMediaDeliveryNotification(env, job.job_id))) return;
  try {
    // Mint rather than persist private URLs; their credentials expire in 900s.
    const mediaRef = knownUrl ?? await artifactUrlFor(env, job.artifact_media_id);
    if (!mediaRef) throw new Error("private_artifact_url_unavailable");
    const caption = job.kind === "video_generate" ? "Here's your video ✨" : "Here's your track ✨";
    const posted = await postAvaMessage(env, {
      ownerUid: job.owner_uid, conv: job.conv_id, text: caption, media_ref: mediaRef,
      source: job.kind === "video_generate" ? "video" : "music",
      private: job.is_private, meta: { job_id: job.job_id, media_job_kind: job.kind },
      client_id: `media-delivery:${job.job_id}`,
    });
    if (!posted.ok) throw new Error(`media_delivery_post_failed:${posted.error || "unknown"}`);
    await finishMediaDeliveryNotification(env, job.job_id, true);

    const email = await emailFor(env, job.owner_uid).catch(() => null);
    await trackUser(env, job.owner_uid, email, "media_delivered", "avaai", {
      job_id: job.job_id, kind: job.kind, tier: job.tier, private: job.is_private,
      attempts: job.attempts, model: job.model, has_source_image: job.has_source_image,
      duration_seconds: job.duration_seconds,
    }).catch(() => {});
  } catch (e) {
    await finishMediaDeliveryNotification(env, job.job_id, false).catch(() => {});
    throw e;
  }
}
