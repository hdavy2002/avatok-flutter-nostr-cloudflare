-- [HF-REEL-SKIP-2] HF-REEL-52: reels that phones report cannot play inside the app (Instagram "watch in the app",
-- no video in the embed, YouTube embedding off / removed / private). Once enough distinct reporters agree
-- (flag hfReelUnplayableHideAt) the reel leaves the feed, saved videos and profiles for everyone, for 30 days.
-- reel_id covers both network reels (hfrl_) and invite reels (hfiv_). reporter = sha256 of the uid or IP, never raw.
CREATE TABLE IF NOT EXISTS hf_reel_unplayable (
  reel_id TEXT PRIMARY KEY,
  platform TEXT,
  reason TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hf_reel_unplayable_reports (
  reel_id TEXT NOT NULL,
  reporter TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (reel_id, reporter)
);
