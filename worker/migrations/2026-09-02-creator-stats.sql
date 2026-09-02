-- [LIST-CONTENT-2] creator_stats (derived, cached) + listing_highlights +
-- listing_questions. DB: avatok-meta (DB_META). CREATE-only file — no ALTERs,
-- so d1_apply_alters.py does not apply here; use the raw path below.
--
-- Source: Specs/SPEC-2026-09-02-LISTING-TRUST-AND-VIBE.md §4.2 and §4.4, and
-- Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.4 ("derived-only,
-- never a form field"). Companion issue [LIST-STATS-1] (§6, "new 4b") wires the
-- refresh job and badge rules on top of this table — this file only lands the
-- schema, dark.
--
-- creator_stats — ONE ROW PER CREATOR, filled by a worker cron or an on-write
-- refresh (not part of this migration). Cards and pages READ this row; nothing
-- computes shows_hosted/on_time_pct/etc. on request. This is what backs the
-- trust-ladder rows 2-4 (§1: "has he done this before", "does he show up",
-- "do people come back") and the PAKKA HOST / WAPSI KING / BAWAAL badges (§5).
--
-- listing_highlights — <=3 per listing (enforced at the route, not here), cut
-- by the creator from a recorded session or uploaded. Also serves the AI
-- "sample voice" clip (kind='voice', duration_s <= 30) referenced in the AI
-- card/page anatomy (§2.3, §3.3).
--
-- listing_questions — the "Ask the host" pre-purchase question (§4.5): one
-- question per user per listing (UNIQUE(listing_id, asker_id)), routed to the
-- creator's inbox, answer shown to the asker only, promotable into
-- `content_faq` (an existing `attrs` key) with one tap via
-- `promoted_to_faq`. Companion issue [LIST-ASK-1] (§6, "new 5c") wires the
-- route/UI on top of this table.
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.
--
-- APPLY (idempotent via IF NOT EXISTS; safe to re-run):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-creator-stats.sql
--   ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-creator-stats.sql

CREATE TABLE IF NOT EXISTS creator_stats (
  creator_id        TEXT PRIMARY KEY,
  shows_hosted      INTEGER NOT NULL DEFAULT 0,
  hours_live        REAL NOT NULL DEFAULT 0,
  on_time_pct       REAL,
  cancel_rate       REAL,
  comeback_pct      REAL,
  avg_response_min  INTEGER,
  sessions_done     INTEGER NOT NULL DEFAULT 0,
  sold_out_count    INTEGER NOT NULL DEFAULT 0,
  first_session_at  INTEGER,
  last_session_at   INTEGER,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_highlights (
  id           TEXT PRIMARY KEY,
  listing_id   TEXT NOT NULL,
  session_id   TEXT,
  kind         TEXT NOT NULL DEFAULT 'clip',  -- clip|voice
  r2_key       TEXT NOT NULL,
  thumb_key    TEXT,
  duration_s   INTEGER,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_highlights_listing ON listing_highlights(listing_id, sort);

CREATE TABLE IF NOT EXISTS listing_questions (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL,
  creator_id        TEXT NOT NULL,
  asker_id          TEXT NOT NULL,
  question          TEXT NOT NULL,
  answer            TEXT,
  answered_at       INTEGER,
  promoted_to_faq   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  UNIQUE(listing_id, asker_id)
);
CREATE INDEX IF NOT EXISTS idx_listing_questions_creator ON listing_questions(creator_id, answered_at);
