-- [HF-WIRE-14] Embeds only (HF-REEL-32): we cache details of a video, never the file. DB_META. CREATE only (no ALTER on hf_reels).
-- Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-20-hf-reel-details.sql
-- Title lives in hf_reels.caption; likes / comments / views / thumb_url / published_at already sit on hf_reels. hf_reels.video_url is no longer written (stays NULL).
-- The daily cron refreshes these details from the YouTube Data API.
CREATE TABLE IF NOT EXISTS hf_reel_details (
  reel_id TEXT PRIMARY KEY,                       -- hf_reels.id
  description TEXT,                               -- video description, cut to 1000 characters
  updated_at INTEGER NOT NULL
);
