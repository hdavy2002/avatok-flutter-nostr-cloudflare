-- Creator analytics + listing images (2026-06-11).
-- DB_META (avatok-meta).
--
-- 1. users.birth_year — OPTIONAL, self-declared, used ONLY to compute a coarse
--    age group (18-24, 25-34, …) on analytics events. Never expose raw.
-- 2. avavoice_agents.images — listing photos (JSON array of public CDN URLs,
--    1–5). AvaLive/AvaConsult listings already have listings.cover_media.
-- 3. listing_views — server-truth detail-view log powering the creator
--    insights dashboard (views by day / country / age group, conversion).
--    Low-write (one row per detail view); PostHog mirrors every row for admin.

ALTER TABLE users ADD COLUMN birth_year INTEGER;

ALTER TABLE avavoice_agents ADD COLUMN images TEXT;

CREATE TABLE IF NOT EXISTS listing_views (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,          -- 'listing' (AvaLive/AvaConsult) | 'voice_agent' (AvaVoice)
  subject_id   TEXT NOT NULL,
  creator_id   TEXT NOT NULL,
  viewer_uid   TEXT,                   -- NULL = guest
  country      TEXT,                   -- ISO-3166 alpha-2 from request.cf
  city         TEXT,
  region       TEXT,
  age_group    TEXT,                   -- '18-24' … '65+' (from users.birth_year, optional)
  source       TEXT,                   -- 'explore'|'search'|'live_now'|'channel'|'deeplink'|…
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lviews_subject ON listing_views(subject_kind, subject_id, ts);
CREATE INDEX IF NOT EXISTS idx_lviews_creator ON listing_views(creator_id, ts);
