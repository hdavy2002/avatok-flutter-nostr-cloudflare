-- [SAATHUM-FREEVIDEOS-API-1 2026-10-01] Free videos — a section separate from events. DB: avatok-meta (DB_META).
-- CREATE-only file (CLAUDE.md rule 6). Apply with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-free-videos.sql
-- NOT APPLIED by the implementing agent. Idempotent.
-- Views reuse event_video_views with listing_id = the free video id ('fv_...', never collides with a listing id).
CREATE TABLE IF NOT EXISTS free_videos (
  id TEXT PRIMARY KEY,                 -- 'fv_' + random
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,              -- satsang|meditation|sermon|bhajan|aarti|festival
  cover_url TEXT,                      -- NULL = use the YouTube thumbnail
  youtube_video_id TEXT NOT NULL,
  source_url TEXT,
  crop_x REAL, crop_y REAL, crop_w REAL, crop_h REAL,
  status TEXT NOT NULL DEFAULT 'draft',-- 'draft' | 'published' | 'archived'
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_live INTEGER NOT NULL DEFAULT 0,  -- refreshed by cron from the YouTube API
  live_checked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
  admin_uid TEXT
);
CREATE INDEX IF NOT EXISTS idx_free_videos_pub ON free_videos(status, sort_order, published_at);
