-- [HF-REEL-ENGAGE-API-1] Likes and comments on every reel (HF-REEL-53..57). DB_META. CREATE only.
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-24-hf-reel-engage.sql
-- reel_id is an hfrl_... (hf_reels) or hfiv_... (hf_invite_reels) id. Flag hfReelEngageEnabled stays off until this is applied.
CREATE TABLE IF NOT EXISTS hf_reel_likes (
  reel_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reel_id, uid)
);
CREATE INDEX IF NOT EXISTS hf_reel_likes_uid ON hf_reel_likes(uid);

CREATE TABLE IF NOT EXISTS hf_reel_comments (
  id TEXT PRIMARY KEY,                            -- hfrc_<20 hex>
  reel_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  parent_id TEXT,                                 -- hfrc_... or an imported comment id (<platform>:<id>); one level deep
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',         -- visible|hidden|deleted
  reports INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_reel_comments_reel ON hf_reel_comments(reel_id, status, created_at);
CREATE INDEX IF NOT EXISTS hf_reel_comments_uid ON hf_reel_comments(uid);

CREATE TABLE IF NOT EXISTS hf_reel_comment_reports (
  comment_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, uid)
);

-- Our side only (the platform's numbers stay in hf_reels / hf_invite_reels). Re-counted in the same batch() as every like / comment write.
CREATE TABLE IF NOT EXISTS hf_reel_counts (
  reel_id TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Comments pulled from YouTube (replaced on every refresh, deleted after 30 days without one).
CREATE TABLE IF NOT EXISTS hf_reel_ext_comments (
  id TEXT PRIMARY KEY,                            -- <platform>:<platform comment id>
  reel_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  author_name TEXT,
  author_avatar TEXT,
  author_url TEXT,
  body TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_reel_ext_comments_reel ON hf_reel_ext_comments(reel_id, published_at);
