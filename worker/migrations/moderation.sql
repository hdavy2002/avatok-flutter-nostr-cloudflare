-- DB_MODERATION — global moderation state (needs cross-user access; spec §7.4, §8).
-- Apply: wrangler d1 execute avatok-moderation --file=migrations/moderation.sql

-- Confirmed-bad fingerprints. Every future upload checked against this.
CREATE TABLE IF NOT EXISTS blocked_media_hashes (
  id                     TEXT PRIMARY KEY,
  hash_type              TEXT NOT NULL,   -- 'sha256'|'perceptual'
  hash_value             TEXT NOT NULL,
  category               TEXT NOT NULL,
  source                 TEXT NOT NULL,   -- 'admin_confirmed'|'photodna'|'stopncii'
  original_uploader_npub TEXT,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocked_hash ON blocked_media_hashes(hash_value);

-- Cache of AI scan results so the same blob is never re-scanned (Rulebook §Workers AI).
CREATE TABLE IF NOT EXISTS moderation_results (
  hash       TEXT PRIMARY KEY,           -- sha256 of scanned bytes
  score      REAL,
  label      TEXT,
  model      TEXT,
  scanned_at INTEGER NOT NULL
);

-- User reports (spec §8.6). Priority drives SLA routing.
CREATE TABLE IF NOT EXISTS user_reports (
  id             TEXT PRIMARY KEY,
  reporter_npub  TEXT NOT NULL,
  reported_npub  TEXT NOT NULL,
  content_kind   TEXT NOT NULL,
  content_id     TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL,          -- 'open'|'reviewing'|'resolved'|'dismissed'
  priority       INTEGER NOT NULL,       -- 1=CSAM/NCII … 4=spam
  created_at     INTEGER NOT NULL,
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  outcome        TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON user_reports(status, priority);
CREATE INDEX IF NOT EXISTS idx_reports_target ON user_reports(reported_npub);
