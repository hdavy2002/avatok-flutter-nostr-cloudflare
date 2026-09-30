-- [SAATHUM-FREEVID-BASE-1 2026-10-01] Who watched which event video. DB: avatok-meta (DB_META).
-- CREATE-only file (CLAUDE.md rule 6). Apply with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-01-freevid-views.sql
-- NOT APPLIED by the implementing agent. Idempotent.
--
-- One row per (event, viewer). Written by POST /api/saathum/watch/:id/view when a
-- signed-in viewer presses Play (free AND paid events). The same moment also goes to
-- PostHog as `saathum_video_view` (with email) — this table is the copy the admin
-- Analytics page reads, so it never depends on a PostHog query key.
CREATE TABLE IF NOT EXISTS event_video_views (
  listing_id TEXT NOT NULL,
  uid        TEXT NOT NULL,
  first_at   INTEGER NOT NULL,   -- epoch ms, first Play
  last_at    INTEGER NOT NULL,   -- epoch ms, most recent Play
  plays      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (listing_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_event_video_views_first ON event_video_views(first_at);
