-- [AVA-SPAM-1] Community spam reputation pool (AvaDial spam shield, Phase 2a).
-- Spec: Specs/PLAN-2026-07-12-home-ava-tok-services-shell.md §4.4 (D1 + Cache API +
-- R2 architecture — NOT KV; deterministic versioned scoring; AI only classifies
-- free-text reasons). Everything ships DARK behind the `spamShield` flag
-- (worker/src/routes/config.ts DEFAULTS, default false) — while OFF, routes 403 and
-- these tables are simply unused.
--
-- NAMING NOTE: a DIFFERENT, pre-existing table `spam_reports` already lives in this
-- DB for the AI-messenger stranger-safety gate (migrations/spam_reports.sql — copies
-- reported message envelopes for moderation). That table is UNRELATED to PSTN number
-- reputation. To avoid clobbering it, the PSTN reputation tables here are prefixed
-- `spam_number_*` / `spam_reporter_trust`.
--
-- Apply (DB_META): scripts/cf.sh worker d1 execute avatok-meta --remote --file=migrations/2026-07-12-spam-reputation.sql
-- Run against DB_META. Idempotent (CREATE ... IF NOT EXISTS); safe to run once.
-- Worker guards every read/write in try/catch, so shipping the code before this
-- migration lands simply keeps the (already 403'd) feature dark — no errors.

-- One LIVE report per reporter per number (re-report UPDATES via the UNIQUE key).
-- e164 is kept alongside the hash for the scoring job / admin audit; lookups and the
-- on-device bloom key on e164_hash (sha256 hex of the normalized E.164) so raw PII
-- never travels on the read path.
CREATE TABLE IF NOT EXISTS spam_number_reports (
  id              TEXT NOT NULL,                 -- report id (uuid)
  e164_hash       TEXT NOT NULL,                 -- sha256(normalizePhone(number)) hex
  e164            TEXT NOT NULL,                 -- normalized +CC number (audit/scoring)
  reporter_uid    TEXT NOT NULL,                 -- who filed (canonical account uid)
  verdict         TEXT NOT NULL,                 -- 'spam' | 'not_spam'
  reason_category TEXT,                          -- scam|telemarketer|robocall|... (AI-classified from reason_text)
  reason_text     TEXT,                          -- optional free-text reason
  created_ms      INTEGER NOT NULL,
  PRIMARY KEY (id)
);
-- One live report per (number, reporter): re-report overwrites the prior verdict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_spam_number_reports_hash_reporter
  ON spam_number_reports (e164_hash, reporter_uid);
CREATE INDEX IF NOT EXISTS idx_spam_number_reports_hash
  ON spam_number_reports (e164_hash);
CREATE INDEX IF NOT EXISTS idx_spam_number_reports_reporter
  ON spam_number_reports (reporter_uid, created_ms);

-- Published, deterministic score per number (rebuilt nightly by runSpamScoring).
-- The read path (GET /api/spam/lookup/:e164) hits this table by hash and is
-- edge-cached (Cache API, ~24h TTL) so D1 only sees cold numbers.
CREATE TABLE IF NOT EXISTS spam_number_scores (
  e164_hash       TEXT NOT NULL,                 -- PK: sha256(E.164) hex
  e164            TEXT,                          -- normalized number (may be null for seeded/imported)
  score           INTEGER NOT NULL DEFAULT 0,    -- 0..100 (deterministic weighted formula)
  label           TEXT NOT NULL DEFAULT 'none',  -- 'red' | 'caution' | 'none'
  report_count    INTEGER NOT NULL DEFAULT 0,    -- distinct spam reporters counted at scoring time
  formula_version TEXT NOT NULL,                 -- e.g. 'v1' — every red verdict replayable from inputs + version
  updated_ms      INTEGER NOT NULL,
  PRIMARY KEY (e164_hash)
);
CREATE INDEX IF NOT EXISTS idx_spam_number_scores_label
  ON spam_number_scores (label);

-- Reporter trust weights. New accounts start LOW (0.3) so brigading barely moves a
-- score; trust rises with agreement history (recomputed nightly).
CREATE TABLE IF NOT EXISTS spam_reporter_trust (
  uid        TEXT NOT NULL,                       -- reporter account uid
  trust      REAL NOT NULL DEFAULT 0.3,           -- 0.05..1.0
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (uid)
);
