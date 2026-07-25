-- [AVA-MEDIA-JOB-1] Durable AI media job/artifact state machine (Specs/
-- ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md Part VI §36-42, Part VII
-- §43 item 4). worker/src/lib/ai_media_jobs.ts is the only writer.
--
-- D1 BINDING: DB_MEDIA (avatok-media-meta) — the SAME database as
-- worker/migrations/media.sql's `user_media` table, so `source_media_id` /
-- `artifact_media_id` / `ai_media_artifacts.media_id` reference user_media.id
-- WITHOUT a cross-database query (D1 has no cross-database FKs/joins, so
-- putting this in DB_WALLET instead would make every "my files" query a
-- two-round-trip join done in application code for no reason).
--
-- Billing linkage: `reservation_id` mirrors worker/src/lib/ai_billing.ts's
-- reserveAiJob() `ref` (= "aijob:<job_id>"), and job_id IS
-- ai_billing_ledger.op_id (worker/migrations/2026-07-24-ai-billing-ledger.sql,
-- DB_WALLET) — so one job_id ties its D1 job row (this table), its billing
-- ledger row (DB_WALLET), and its WalletDO reservation (ref) together with no
-- extra id to keep in sync. `reservation_id` NULL means no wallet reservation
-- was actually taken for this job (aiWalletMeteringEnabled was off at create
-- time) — media capabilities are otherwise NEVER free (§42/§48). No
-- wallet/balance data lives in THIS table — DB_WALLET / WalletDO remain the
-- sole balance authority (per this issue's instructions: do not add a second
-- wallet table).
--
-- Apply: scripts/cf.sh worker d1 execute DB_MEDIA --remote \
--   --file=migrations/2026-07-25-ai-media-jobs.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules. THE COORDINATOR RUNS
-- THIS — the agent that authored this file does not run migrations.)

CREATE TABLE IF NOT EXISTS ai_media_jobs (
  job_id             TEXT PRIMARY KEY,
  owner_uid          TEXT NOT NULL,
  conv_id            TEXT NOT NULL,
  source_media_id    TEXT,                 -- nullable: some kinds (e.g. image_generate from a bare prompt) have no source media
  kind               TEXT NOT NULL,        -- image_generate | doc_summarize | doc_translate | audio_transcribe | audio_translate
  status             TEXT NOT NULL,        -- queued | running | succeeded | failed | cancelled
  label              TEXT,                 -- short display string only ("Translating to Hindi…") — NEVER prompt/file content
  progress           INTEGER NOT NULL DEFAULT 0,
  -- Deliberate, minimal addition beyond this issue's literal column list: a
  -- target-language CODE (e.g. "hi") is a job PARAMETER needed by
  -- doc_translate/audio_translate to resume/hydrate correctly on reconnect —
  -- it is not prompt/file/transcript content, so it does not violate the
  -- §41/§42 "never store provider prompts/file contents/transcripts/captions"
  -- rule. See the implementing agent's final report for the full rationale.
  target_language    TEXT,
  artifact_media_id  TEXT,                 -- FK-by-convention -> user_media.id (this DB) once status='succeeded'
  error_code         TEXT,                 -- short safe code only (e.g. NOT_IMPLEMENTED, PROVIDER_ERROR, TIMEOUT) — never a raw provider message
  reservation_id     TEXT,                 -- ai_billing.ts reserveAiJob() ref; NULL = unmetered (see header)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
-- job_id is already the PRIMARY KEY (implicitly UNIQUE); this named index
-- exists purely so the constraint is explicit in a schema dump/migration
-- review, per this issue's "unique constraint on job_id" instruction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_media_jobs_job_id ON ai_media_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_media_jobs_owner_status ON ai_media_jobs(owner_uid, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_media_jobs_owner_conv   ON ai_media_jobs(owner_uid, conv_id, created_at);

CREATE TABLE IF NOT EXISTS ai_media_artifacts (
  artifact_id      TEXT PRIMARY KEY,
  owner_uid        TEXT NOT NULL,
  source_media_id  TEXT,                   -- copied from the parent job at completion time, for a join-free lookup
  job_id           TEXT NOT NULL,
  media_id         TEXT NOT NULL,          -- FK-by-convention -> user_media.id (this DB) — the derived artifact's own media row
  mime_type        TEXT,
  file_name        TEXT,
  language         TEXT,                   -- output language code, when the kind produces a translated artifact
  created_at       INTEGER NOT NULL
);
-- (job_id, media_id): the pairing this issue's instructions named as
-- "(job_id, artifact_media_id)" — ai_media_jobs.artifact_media_id IS this
-- table's media_id once linked (completeAiMediaJob() sets both together), so
-- this is that same constraint under the column name that actually exists on
-- THIS table. Makes completeAiMediaJob()'s artifact insert idempotent by
-- construction (INSERT ... ON CONFLICT(job_id, media_id) DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_media_artifacts_job_media ON ai_media_artifacts(job_id, media_id);
CREATE INDEX IF NOT EXISTS idx_ai_media_artifacts_owner ON ai_media_artifacts(owner_uid, created_at DESC);
