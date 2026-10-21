-- Reel bookmarks are separate from the existing saved-host list. IDs cover network and invite reels.
CREATE TABLE IF NOT EXISTS hf_reel_bookmarks (
  uid TEXT NOT NULL,
  reel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, reel_id)
);
CREATE INDEX IF NOT EXISTS hf_reel_bookmarks_user_time ON hf_reel_bookmarks(uid, created_at DESC);
