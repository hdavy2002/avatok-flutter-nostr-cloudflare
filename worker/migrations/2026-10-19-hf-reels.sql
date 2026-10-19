-- [HF-WIRE-4] Hello Fraands Reels app: imported reels (YouTube / Instagram). DB_META. CREATE only.
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-reels.sql
-- Imported reels start hidden (visible=0). The influencer picks which go on the feed (HF-REEL-27, no automatic face check).
CREATE TABLE IF NOT EXISTS hf_reels (
  id TEXT PRIMARY KEY,                            -- hfrl_<20 hex>
  host_uid TEXT NOT NULL,
  channel_id TEXT,                                -- hf_channels.id; NULL for a demo reel
  platform TEXT NOT NULL,                         -- instagram|youtube
  platform_video_id TEXT NOT NULL,                -- YouTube video id / Instagram shortcode
  url TEXT,                                       -- public link to the original
  embed_url TEXT,                                 -- official embed (YouTube /embed/<id>, Instagram /reel/<code>/embed)
  video_url TEXT,                                 -- direct file when the provider gives one (Instagram CDN: signed, EXPIRES, refreshed by the daily import)
  thumb_url TEXT,
  caption TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,                           -- ms
  visible INTEGER NOT NULL DEFAULT 0,             -- 1 = on the feed and the public profile
  is_demo INTEGER NOT NULL DEFAULT 0,             -- 1 = starter content (HF-REEL-12), hidden by hfDemoInfluencersVisible=false
  imported_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hf_reels_video ON hf_reels(channel_id, platform_video_id);
CREATE INDEX IF NOT EXISTS hf_reels_host ON hf_reels(host_uid, visible);
CREATE INDEX IF NOT EXISTS hf_reels_feed ON hf_reels(visible, published_at);
