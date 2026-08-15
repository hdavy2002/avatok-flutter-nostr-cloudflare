-- Persist the server-selected music route so queue recovery cannot revive a
-- malformed or legacy job without knowing whether it is vocal or instrumental.
ALTER TABLE venice_media_jobs ADD COLUMN music_mode TEXT;
CREATE INDEX IF NOT EXISTS idx_venice_media_jobs_music_mode
  ON venice_media_jobs(kind, music_mode, status);
