-- [VENICE-SONG-CARD-1] Rich, share-ready music card metadata and exact
-- fixed-price settlement. Apply to DB_MEDIA before deploying the Worker code
-- that reads/writes these fields.

ALTER TABLE venice_media_jobs ADD COLUMN flat_price_tokens INTEGER;
ALTER TABLE venice_media_jobs ADD COLUMN song_title TEXT;
ALTER TABLE venice_media_jobs ADD COLUMN song_description TEXT;
ALTER TABLE venice_media_jobs ADD COLUMN cover_media_id TEXT;
ALTER TABLE venice_media_jobs ADD COLUMN cover_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE venice_media_jobs ADD COLUMN share_token TEXT;
ALTER TABLE venice_media_jobs ADD COLUMN shared_at INTEGER;
ALTER TABLE venice_media_jobs ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE venice_media_jobs ADD COLUMN delivery_lease_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_venice_media_jobs_share_token
  ON venice_media_jobs(share_token) WHERE share_token IS NOT NULL;
