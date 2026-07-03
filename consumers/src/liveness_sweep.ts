// STREAM H (AI Messenger Batch) — [LIVE-GATE-1] abandoned-liveness sweep, PORTED
// into avatok-consumers.
//
// The canonical implementation lives in worker/src/routes/liveness_audit.ts
// (sweepAbandonedLiveness / recordLivenessAudit). That file belongs to the
// avatok-api Worker package (its own tsconfig + `metaDb(env)` shard helper + the
// worker Env type). Importing it across the worker↔consumers package boundary is
// awkward — the two Workers build independently — so we PORT the small, self-
// contained function here. It touches ONLY DB_META (already a consumers binding,
// see deletion.ts which deletes from verification_attempts on the same DB), so the
// port is behaviour-identical and low-risk. Keep the two copies in sync if the
// audit schema changes (they share the liveness_audit + verification_attempts
// tables in avatok-meta).
import type { Env } from "./types";

const ABANDON_STALE_MS = 15 * 60_000; // 15 min — a 'pending' session older than this is abandoned.

/** Canonical R2 prefix (D15): liveness/<uid>/<session>/  (matches worker's auditPrefix). */
const auditPrefix = (uid: string, session: string) => `liveness/${uid}/${session}/`;

/** Insert one 'abandoned' audit row into liveness_audit (DB_META). Best-effort —
 *  a failure here must never break the sweep. Geo/device are null on the cron path
 *  (no originating Request). Mirrors worker recordLivenessAudit's INSERT shape. */
async function recordAbandonedAudit(env: Env, uid: string, provider: "rekognition" | "workersai", r2Prefix: string): Promise<void> {
  try {
    await env.DB_META.prepare(
      `INSERT INTO liveness_audit
        (id, uid, provider, status, confidence, ip, country, city, colo, asn,
         device_model, os, app_version, r2_prefix, created_at)
       VALUES (?1,?2,?3,'abandoned',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?4,?5)`,
    ).bind(crypto.randomUUID(), uid, provider, r2Prefix, Date.now()).run();
  } catch { /* audit is best-effort */ }
}

/**
 * [LIVE-GATE-1] Abandoned-session sweep. Marks verification attempts started but
 * never verified (still 'pending' after 15 min) as 'abandoned' and writes one
 * liveness_audit row per swept session. Idempotent: sessions that already have an
 * 'abandoned' audit row are skipped, so re-running the cron never double-audits.
 * Bounded to 200 rows/run.
 */
export async function sweepAbandonedLiveness(env: Env): Promise<{ swept: number }> {
  const cutoff = Date.now() - ABANDON_STALE_MS;
  let swept = 0;
  try {
    const rows = await env.DB_META.prepare(
      `SELECT va.uid AS uid, va.session_id AS session_id, va.provider AS provider
         FROM verification_attempts va
        WHERE va.result = 'pending' AND va.created_at < ?1
          AND NOT EXISTS (
            SELECT 1 FROM liveness_audit la
             WHERE la.uid = va.uid AND la.status = 'abandoned'
               AND la.r2_prefix = 'liveness/' || va.uid || '/' || va.session_id || '/')
        LIMIT 200`,
    ).bind(cutoff).all<{ uid: string; session_id: string; provider: string }>();
    for (const r of rows.results ?? []) {
      const provider = r.provider === "rekognition" ? "rekognition" : "workersai";
      await recordAbandonedAudit(env, r.uid, provider, auditPrefix(r.uid, r.session_id));
      try {
        await env.DB_META.prepare(
          "UPDATE verification_attempts SET result='abandoned' WHERE uid=?1 AND session_id=?2 AND result='pending'",
        ).bind(r.uid, r.session_id).run();
      } catch { /* best-effort */ }
      swept++;
    }
  } catch { /* best-effort sweep (tables may not exist pre-Stream-H) */ }
  return { swept };
}
