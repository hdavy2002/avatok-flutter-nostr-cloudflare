-- Partial index for the 6-hourly cron cleanup, which scans user_media for stale
-- 'pending' rows. Indexing only pending/rejected rows keeps the index tiny (the
-- vast majority of rows are 'live' or 'skipped') while covering the cron query.
CREATE INDEX IF NOT EXISTS idx_media_pending
  ON user_media(moderation_status, created_at)
  WHERE moderation_status IN ('pending', 'rejected');
