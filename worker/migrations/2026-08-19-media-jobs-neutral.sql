-- Rename the media generation state machine away from the retired provider.
-- The previous migration created venice_media_jobs and may already have live
-- rows, so this is a metadata-preserving rename rather than a new table.

ALTER TABLE venice_media_jobs RENAME TO media_jobs;
ALTER TABLE media_jobs RENAME COLUMN venice_queue_id TO provider_operation_id;

CREATE INDEX IF NOT EXISTS idx_media_jobs_owner_status
  ON media_jobs(owner_uid, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_jobs_owner_conv
  ON media_jobs(owner_uid, conv_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_jobs_operation_id
  ON media_jobs(provider_operation_id);
CREATE INDEX IF NOT EXISTS idx_media_jobs_recovery
  ON media_jobs(status, updated_at, deadline_at);
