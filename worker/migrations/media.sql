-- DB_MEDIA — AvaLibrary metadata + perceptual hashes.
-- The bytes live in R2 (public bucket) / Bunny; this is the queryable index.
-- Apply: wrangler d1 execute avatok-media-meta --file=migrations/media.sql

CREATE TABLE IF NOT EXISTS user_media (
  id                TEXT PRIMARY KEY,
  uid              TEXT NOT NULL,
  media_type        TEXT NOT NULL,        -- 'image'|'audio'|'video'
  storage           TEXT NOT NULL,        -- 'blossom'|'bunny'
  visibility        TEXT NOT NULL,        -- 'public'|'private'  (which upload path)
  encrypted         INTEGER NOT NULL DEFAULT 0, -- 1 = client AES-GCM ciphertext (DM media)
  key               TEXT NOT NULL,        -- sha256 (Blossom) or bunny_video_id
  display_url       TEXT NOT NULL,        -- blossom.avatok.ai/<hash> or Bunny URL
  thumbnail_url     TEXT,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  duration_seconds  INTEGER,
  original_app      TEXT,                 -- 'avatweet'|'avagram'|'avachat'|...
  created_at        INTEGER NOT NULL,
  reference_count   INTEGER DEFAULT 0,
  -- 'pending'|'live'|'rejected' for scanned public media;
  -- 'skipped' for private encrypted media (ciphertext is unscannable by design).
  moderation_status TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_media_uid ON user_media(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_key  ON user_media(key);

-- Perceptual hashes for the "gets smarter for free" blocklist (spec §8.3).
CREATE TABLE IF NOT EXISTS user_media_hashes (
  id          TEXT PRIMARY KEY,
  media_id    TEXT NOT NULL,
  uid        TEXT NOT NULL,
  frame_index INTEGER NOT NULL,
  phash       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_hashes_phash ON user_media_hashes(phash);
