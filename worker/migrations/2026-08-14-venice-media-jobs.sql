-- [VENICE-VID-1 / VENICE-MUS-1] Durable job state machine for Venice AI
-- video/music generation. Specs/VENICE-AI-MEDIA-PLAN-2026-08-14.md.
--
-- WHY A SEPARATE TABLE FROM ai_media_jobs (worker/migrations/2026-07-25-ai-media-jobs.sql):
-- `ai_media_jobs.kind` is a closed TypeScript union (AiMediaJobKind,
-- worker/src/lib/ai_media_jobs.ts) exhaustively switched over by
-- CAPABILITY_BY_KIND / MODALITY_BY_KIND / MODEL_BY_KIND / DEFAULT_ESTIMATE /
-- KIND_HANDLERS. Adding 'venice_video_generate'/'venice_music_generate' there
-- would require editing worker/src/lib/ai_media_jobs.ts and
-- worker/src/queues/ai_media.ts's KIND_HANDLERS map — ai_media_jobs.ts is a
-- different agent's file ownership this wave (parallel [VENICE-IMG-1] work).
-- This table is deliberately a separate, small, purpose-built state machine
-- (worker/src/lib/venice_media_jobs.ts is the only writer) so this wave never
-- has to touch that file. Billing still goes through the SAME shared
-- worker/src/lib/ai_billing.ts reserveAiJob()/settleAiJob()/releaseAiJob() —
-- only the row/table is separate, not the money authority.
--
-- D1 BINDING: DB_MEDIA (avatok-media-meta) — same database as
-- ai_media_jobs/user_media, so a future consolidation can join without a
-- cross-database query.
--
-- PRIVACY (§41/§42, mirrored from ai_media_jobs.ts): this table NEVER stores
-- the user's generation PROMPT — only ids, kind, status, the Venice queue id
-- (needed to poll), safe numeric/boolean parameters (duration, has_source_image),
-- a short display label, and billing linkage. The prompt is used once, inline,
-- at submission time (lib/venice_media.ts's runVeniceVideo/runVeniceMusic) and
-- is never persisted — a redelivered POLL message only ever needs venice_queue_id,
-- never the prompt, so this is safe under at-least-once queue redelivery.
--
-- Apply: scripts/cf.sh worker d1 execute DB_MEDIA --remote \
--   --file=migrations/2026-08-14-venice-media-jobs.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules. THE COORDINATOR RUNS
-- THIS — the agent that authored this file does not run migrations.)

CREATE TABLE IF NOT EXISTS venice_media_jobs (
  job_id             TEXT PRIMARY KEY,
  owner_uid          TEXT NOT NULL,
  conv_id            TEXT NOT NULL,
  kind               TEXT NOT NULL,        -- venice_video_generate | venice_music_generate
  status             TEXT NOT NULL,        -- submitting | polling | succeeded | failed | cancelled
  venice_queue_id    TEXT,                 -- Venice's own queue id (POST /video|audio/queue -> id); set once submission succeeds
  is_private         INTEGER NOT NULL DEFAULT 1,  -- 0/1: mirrors postAvaMessage's private flag for final delivery
  tier               TEXT NOT NULL DEFAULT 'free', -- [VENICE-TIER-1] hardcoded 'free' at the call site today
  has_source_image   INTEGER NOT NULL DEFAULT 0,   -- 1 = video_i2v (source_image_url was supplied), 0 = video_t2v; unused for music
  duration_seconds   INTEGER,              -- music only (60-210, clamped); NULL for video
  label              TEXT,                 -- short display string only ("Making your video…") — NEVER the prompt
  capability         TEXT NOT NULL,        -- ai_billing.ts capability string, e.g. media_video_generate
  model              TEXT NOT NULL,        -- veniceRoute(...).model at submit time
  reservation_id     TEXT,                 -- ai_billing.ts reserveAiJob() ref; NULL = unmetered
  artifact_media_id  TEXT,                 -- FK-by-convention -> user_media.id (this DB) once status='succeeded'
  error_code         TEXT,                 -- short safe code only — never a raw provider message
  attempts           INTEGER NOT NULL DEFAULT 0,   -- poll attempts, drives backoff
  deadline_at        INTEGER NOT NULL,     -- hard poll deadline (created_at + ~10min video / ~5min music); past this -> fail
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_venice_media_jobs_owner_status ON venice_media_jobs(owner_uid, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_venice_media_jobs_owner_conv   ON venice_media_jobs(owner_uid, conv_id, created_at);
CREATE INDEX IF NOT EXISTS idx_venice_media_jobs_queue_id     ON venice_media_jobs(venice_queue_id);
