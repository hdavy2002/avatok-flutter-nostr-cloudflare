import type { Env } from "../types";
import { failAiMediaJob } from "../lib/ai_media_jobs";
import { loadQueuedImageInput, purgeExpiredQueuedImageInputs } from "../lib/ai_media_inputs";
import {
  claimMediaRecoveryLease,
  failMediaJob,
  listMediaJobsForRecovery,
  listVideoThumbnailJobsForRecovery,
  reopenVideoCover,
} from "../lib/media_jobs";
import { enqueueMediaPoll } from "./media";
import { track, trackException } from "../hooks";

const QUEUED_STALE_MS = 2 * 60 * 1000;
const RUNNING_STALE_MS = 3 * 60 * 1000;
const MAX_RESTARTS = 3;
const MEDIA_STALE_MS = 3 * 60 * 1000;
const MAX_MEDIA_POLL_ATTEMPTS = 40;
const BATCH_LIMIT = 100;

/**
 * Reconciles the image pipeline every cron tick. Queue delivery is normally
 * enough; this is the safety net for dropped messages, isolate eviction and
 * worker deploys. It is bounded, idempotent, and never charges a second time.
 */
export async function recoverAiMediaJobs(env: Env): Promise<{
  requeued: number;
  failed: number;
  purged: number;
  mediaRequeued: number;
  mediaFailed: number;
}> {
  const now = Date.now();
  let requeued = 0;
  let failed = 0;
  let mediaRequeued = 0;
  let mediaFailed = 0;

  const queued = await env.DB_MEDIA.prepare(
    `SELECT job_id, owner_uid FROM ai_media_jobs
     WHERE kind='image_generate' AND status='queued' AND updated_at<?1
     ORDER BY updated_at LIMIT ?2`,
  ).bind(now - QUEUED_STALE_MS, BATCH_LIMIT).all<{ job_id: string; owner_uid: string }>();
  for (const row of queued.results || []) {
    try {
      const input = await loadQueuedImageInput(env, row.job_id, row.owner_uid);
      if (!input) {
        const result = await failAiMediaJob(env, { jobId: row.job_id, errorCode: "INPUT_EXPIRED", reason: "image_input_missing" });
        if (result.ok) failed++;
        continue;
      }
      await env.Q_AI_MEDIA.send({ job_id: row.job_id, kind: "image_generate" });
      await env.DB_MEDIA.prepare("UPDATE ai_media_jobs SET updated_at=?2 WHERE job_id=?1 AND status='queued'").bind(row.job_id, now).run();
      requeued++;
    } catch (e) {
      void trackException(env, e, { route: "ai_media_recovery.queued", handled: true, extra: { job_id: row.job_id } });
    }
  }

  const running = await env.DB_MEDIA.prepare(
    `SELECT job_id, owner_uid, attempt_count FROM ai_media_jobs
     WHERE kind='image_generate' AND status='running' AND updated_at<?1
     ORDER BY updated_at LIMIT ?2`,
  ).bind(now - RUNNING_STALE_MS, BATCH_LIMIT).all<{ job_id: string; owner_uid: string; attempt_count: number }>();
  for (const row of running.results || []) {
    try {
      const input = await loadQueuedImageInput(env, row.job_id, row.owner_uid);
      if (input && Number(row.attempt_count || 0) < MAX_RESTARTS) {
        const changed = await env.DB_MEDIA.prepare(
          "UPDATE ai_media_jobs SET status='queued', progress=0, updated_at=?2 WHERE job_id=?1 AND status='running'",
        ).bind(row.job_id, now).run();
        if ((changed.meta?.changes ?? 0) > 0) {
          await env.Q_AI_MEDIA.send({ job_id: row.job_id, kind: "image_generate" });
          requeued++;
          void track(env, row.owner_uid, "ai_media_job_requeued", "ai_media_jobs", { job_id: row.job_id, reason: "stale_running", attempt_count: row.attempt_count });
        }
      } else {
        const result = await failAiMediaJob(env, { jobId: row.job_id, errorCode: input ? "WORKER_TIMEOUT" : "INPUT_EXPIRED", reason: input ? "stale_running_max_restarts" : "image_input_missing" });
        if (result.ok) failed++;
      }
    } catch (e) {
      void trackException(env, e, { uid: row.owner_uid, route: "ai_media_recovery.running", handled: true, extra: { job_id: row.job_id } });
    }
  }

  const purged = await purgeExpiredQueuedImageInputs(env).catch(() => 0);

  // Venice video/music jobs have their own durable table because the provider
  // work is asynchronous. The queue consumer has a hard deadline, but this
  // sweep is the second line of defence when a delayed poll message is lost,
  // the Worker is evicted, or submission never transitions to polling.
  const mediaJobs = await listMediaJobsForRecovery(env, now, now - MEDIA_STALE_MS, BATCH_LIMIT);
  for (const job of mediaJobs) {
    try {
      if (job.kind === "music_generate" && !job.music_mode) {
        const result = await failMediaJob(env, {
          jobId: job.job_id,
          errorCode: "MUSIC_ROUTE_UNVERIFIED",
          reason: "watchdog_rejects_legacy_music_route",
        });
        if (result.ok && result.transitioned) mediaFailed++;
        void track(env, job.owner_uid, "media_job_watchdog_rejected", "avaai", {
          job_id: job.job_id, kind: job.kind, reason: "unverified_music_route",
        });
        continue;
      }
      if (job.status === "submitting") {
        const result = await failMediaJob(env, {
          jobId: job.job_id,
          errorCode: "provider_submission_stalled",
          reason: "stale_submission_watchdog",
        });
        if (result.ok && result.transitioned) {
          mediaFailed++;
          void track(env, job.owner_uid, "media_job_watchdog_failed", "avaai", {
            job_id: job.job_id, kind: job.kind, reason: "stale_submission", attempts: job.attempts,
          });
        }
        continue;
      }

      // Once provider bytes have been durably staged, the provider deadline no
      // longer applies. Always requeue final settlement/notification recovery;
      // the stable billing operation id makes this safe and idempotent.
      if (job.status === "delivering") {
        const leased = await claimMediaRecoveryLease(
          env, job.job_id, now - MEDIA_STALE_MS, now,
        );
        if (!leased) continue;
        await enqueueMediaPoll(env, job.job_id, job.kind);
        mediaRequeued++;
        continue;
      }

      if (now >= job.deadline_at || job.attempts >= MAX_MEDIA_POLL_ATTEMPTS) {
        const result = await failMediaJob(env, {
          jobId: job.job_id,
          errorCode: "PROVIDER_TIMEOUT",
          reason: now >= job.deadline_at ? "watchdog_deadline_exceeded" : "watchdog_poll_attempt_limit",
        });
        if (result.ok && result.transitioned) {
          mediaFailed++;
          void track(env, job.owner_uid, "media_job_watchdog_failed", "avaai", {
            job_id: job.job_id, kind: job.kind,
            reason: now >= job.deadline_at ? "deadline_exceeded" : "poll_attempt_limit",
            attempts: job.attempts,
          });
        }
        continue;
      }

      const leased = await claimMediaRecoveryLease(
        env, job.job_id, now - MEDIA_STALE_MS, now,
      );
      if (!leased) continue;
      await enqueueMediaPoll(env, job.job_id, job.kind);
      mediaRequeued++;
      void track(env, job.owner_uid, "media_job_watchdog_requeued", "avaai", {
        job_id: job.job_id, kind: job.kind, attempts: job.attempts,
      });
    } catch (e) {
      void trackException(env, e, {
        uid: job.owner_uid, route: "ai_media_recovery.venice", handled: true,
        extra: { job_id: job.job_id, kind: job.kind },
      });
    }
  }

  const thumbnailJobs = await listVideoThumbnailJobsForRecovery(env, now - MEDIA_STALE_MS, BATCH_LIMIT);
  for (const job of thumbnailJobs) {
    try {
      // [VIDEO-AUDIT-1] A 'failed' cover must be reopened first: claimSongCover
      // only accepts 'pending'/stale-'generating', so requeueing a failed row
      // would silently do nothing. Bounded by the retry window in the query.
      if (job.cover_status === "failed" && !(await reopenVideoCover(env, job.job_id))) continue;
      await env.Q_AI_MEDIA.send({ job_id: job.job_id, kind: job.kind });
      mediaRequeued++;
      void track(env, job.owner_uid, "media_video_thumbnail_watchdog_requeued", "avaai", { job_id: job.job_id, kind: job.kind, cover_status: job.cover_status });
    } catch (e) {
      void trackException(env, e, { uid: job.owner_uid, route: "ai_media_recovery.video_thumbnail", handled: true, extra: { job_id: job.job_id } });
    }
  }

  // This heartbeat is the operational watchdog: an absent event means the
  // scheduled recovery itself is unhealthy, not merely that one video failed.
  void track(env, "system", "media_watchdog_scan", "avaai", {
    active_jobs: mediaJobs.length, thumbnail_jobs: thumbnailJobs.length,
    requeued: mediaRequeued, failed: mediaFailed,
  });

  if (requeued || failed || purged || mediaRequeued || mediaFailed) {
    console.log("[ai-media-recovery]", JSON.stringify({
      requeued, failed, purged, mediaRequeued, mediaFailed,
    }));
  }
  return { requeued, failed, purged, mediaRequeued, mediaFailed };
}
