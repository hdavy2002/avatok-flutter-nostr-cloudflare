-- Phase 8 — AvaVerse dashboard + AvaInbox universal inbox. DB: avatok-meta (DB_META).
--
-- AvaInbox is a VIEW over the existing conversations table — the `context` tag
-- is the ONLY backend addition (dm | event:<listingId> | channel:<creatorId> |
-- consult:<bookingId> | system). No new message store (rulebook: InboxDO is the
-- message core).
ALTER TABLE conversations ADD COLUMN context TEXT;

-- Review replies — creator's single public reply under a review (Phase 8).
ALTER TABLE reviews ADD COLUMN reply TEXT;
ALTER TABLE reviews ADD COLUMN reply_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_reviews_unreplied ON reviews(creator_id, created_at DESC) WHERE reply IS NULL;

-- Daily PostHog-derived audience snapshot so the dashboard opens instantly
-- (<1 s acceptance criterion). Written write-through by /api/verse/summary
-- when stale (>24 h); heavy HogQL queries never block a warm open.
CREATE TABLE IF NOT EXISTS verse_snapshots (
  uid        TEXT PRIMARY KEY,
  day        TEXT NOT NULL,          -- YYYY-MM-DD (UTC) the snapshot was computed
  data       TEXT NOT NULL,          -- JSON: {views, opens, joins, top_countries:[{code,n}]}
  updated_at INTEGER NOT NULL
);
