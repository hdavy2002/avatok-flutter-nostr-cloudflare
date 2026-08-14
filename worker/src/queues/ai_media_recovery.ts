import type { Env } from "../types";
import { failAiMediaJob } from "../lib/ai_media_jobs";
import { loadQueuedImageInput, purgeExpiredQueuedImageInputs } from "../lib/ai_media_inputs";
import { track, trackException } from "../hooks";

const QUEUED_STALE_MS = 2 * 60 * 1000;
const RUNNING_STALE_MS = 3 * 60 * 1000;
const MAX_RESTARTS = 3;
const BATCH_LIMIT = 100;

/**
 * Reconciles the image pipeline every cron tick. Queue delivery is normally
 * enough; this is the safety net for dropped messages, isolate eviction and
 * worker deploys. It is bounded, idempotent, and never charges a second time.
 */
export async function recoverAiMediaJobs(env: Env): Promise<{ requeued: number; failed: number; purged: number }> {
  const now = Date.now();
  let requeued = 0;
  let failed = 0;

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
  if (requeued || failed || purged) console.log("[ai-media-recovery]", JSON.stringify({ requeued, failed, purged }));
  return { requeued, failed, purged };
}
