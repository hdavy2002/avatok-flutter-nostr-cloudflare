-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- One UNLISTED YouTube video per event (owner decision 2026-09-25): the same id serves
-- live and replay. Set by an admin; returned by /api/me/events ONLY to a caller who
-- holds a seat on the listing — never in the public catalog.
CREATE TABLE IF NOT EXISTS event_videos (
  listing_id       TEXT PRIMARY KEY,
  youtube_video_id TEXT NOT NULL,
  source_url       TEXT,
  updated_at       INTEGER NOT NULL,
  admin_uid        TEXT
);
