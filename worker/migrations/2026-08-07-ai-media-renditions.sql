-- [AVA-IMG-TIERS-1 / WS-10] Two-tier images: a fast small PREVIEW posted into
-- the thread immediately, and a 2K FULL rendition generated on demand when the
-- user taps download.
--
-- Specs/AVA-V2-IMPLEMENTATION-2026-08-07.md WS-10.
--
-- D1 BINDING: DB_MEDIA (avatok-media-meta) — the same database as
-- worker/migrations/2026-07-25-ai-media-jobs.sql, whose two tables this
-- extends. worker/src/lib/ai_media_jobs.ts remains the only writer.
--
-- WHY A SCHEMA CHANGE IS UNAVOIDABLE HERE.
-- `ai_media_jobs.artifact_media_id` is single-valued, so a job can point at
-- exactly one artifact. `ai_media_artifacts` already permits several rows per
-- job (unique on (job_id, media_id)) but carried NO column saying what each
-- row IS, and nothing in the codebase ever read more than one. A second
-- rendition therefore had nowhere to live that a reader could find it.
--
-- It also cannot be derived at the edge. Cloudflare's /cdn-cgi/image/...
-- transform only runs on avatok.ai hosts; generated images are ALWAYS private
-- (resolveArtifactSensitivity(env, null) -> 'private'), so they are served
-- from a SigV4-presigned <account>.r2.cloudflarestorage.com URL, where the
-- transform does not exist and where inserting a path segment would break the
-- signature. The second rendition is a real, separately generated object.
--
-- ⚠️ DO NOT repurpose `user_media.thumbnail_url` for the full-res URL. It is
-- client-visible (returned in media.ts's LIB_COLS) and the naming would be
-- exactly backwards — a column called "thumbnail" holding the 2K original.
--
-- Apply: scripts/cf.sh worker d1 execute DB_MEDIA --remote \
--   --file=migrations/2026-08-07-ai-media-renditions.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules. THE COORDINATOR RUNS
-- THIS — the agent that authored this file does not run migrations.)

-- ---------------------------------------------------------------------------
-- 1. The rendition discriminator.
--
-- 'primary' = the artifact the job itself produced (for an image_generate job
--             under the two-tier flag, that is the fast small PREVIEW; for
--             every job created before this migration it is simply "the
--             artifact", which is why that is the backfilled default).
-- 'full'    = the on-demand high-resolution rendition of the SAME image,
--             produced by an image_upgrade job and cross-linked back onto the
--             ORIGINAL job's id so "give me the 2K of job X" is one indexed
--             lookup rather than a walk through upgrade_of_job_id.
--
-- NOT NULL DEFAULT 'primary' is what makes this migration safe to run against
-- a live table: every existing row is correctly labelled by the default, with
-- no backfill statement and no window where the column is NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_media_artifacts ADD COLUMN rendition TEXT NOT NULL DEFAULT 'primary';

-- The provider resolution tier this artifact was actually produced at — the
-- string sent to (and accepted by) the provider, e.g. '1K' or '2K'. Recorded
-- so a reader can tell the two renditions apart by fact rather than by
-- convention, and so a later tier change is visible in the data. Nullable:
-- rows written before this migration genuinely do not know (they predate the
-- resolution parameter being threaded through at all).
ALTER TABLE ai_media_artifacts ADD COLUMN resolution TEXT;

-- One row per (job, rendition). This is the constraint that makes the upgrade
-- path idempotent BY CONSTRUCTION: a retried/redelivered upgrade can never
-- attach a second 'full' rendition to the same job.
--
-- Safe on existing data: today there is at most one artifact row per job, and
-- the ALTER above labels every one of them 'primary', so no existing pair
-- collides.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_media_artifacts_job_rendition
  ON ai_media_artifacts(job_id, rendition);

-- ---------------------------------------------------------------------------
-- 2. The upgrade job's back-pointer.
--
-- An image_upgrade job is a real, separately-billed AiMediaJob (its own
-- reservation, its own settle, its own terminal state) whose source is the
-- preview artifact. This column records which image_generate job it upgrades,
-- so the upgrade endpoint can answer "has this image already been upgraded,
-- or is an upgrade already in flight?" with one indexed read instead of
-- reserving a second charge for work that is already happening.
--
-- NULL for every job that is not an upgrade — which is every job that exists
-- today, hence no backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_media_jobs ADD COLUMN upgrade_of_job_id TEXT;

-- Supports the "is there already an upgrade for this preview?" lookup on the
-- request path. Partial index: only upgrade jobs carry a non-NULL value, so
-- this stays tiny relative to the table.
CREATE INDEX IF NOT EXISTS idx_ai_media_jobs_upgrade_of
  ON ai_media_jobs(upgrade_of_job_id)
  WHERE upgrade_of_job_id IS NOT NULL;
