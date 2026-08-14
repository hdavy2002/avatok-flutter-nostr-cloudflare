-- Durable dispatch/recovery for image jobs.
-- Prompts are encrypted before storage; plaintext never enters D1 or a queue.

ALTER TABLE ai_media_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_media_jobs_recovery
  ON ai_media_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS ai_media_job_inputs (
  job_id       TEXT PRIMARY KEY,
  owner_uid    TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_media_job_inputs_expiry
  ON ai_media_job_inputs(expires_at);
