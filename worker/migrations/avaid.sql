-- Phase 1 (v5.2 §26) — AvaID: identity verification (AWS Rekognition Face
-- Liveness), Tier-2 gating, and the 30-day-grace account-deletion request log.
-- All in DB_META (binding DB_META = avatok-meta). Selfie video bytes live in the
-- LOCKED avatok-verification R2 bucket (never public); only the key is stored here.

-- Current verification state per identity (uid). One row per user.
CREATE TABLE IF NOT EXISTS verification_status (
  uid             TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'unverified', -- 'unverified'|'pending'|'verified'|'rejected'
  method           TEXT,                               -- 'rekognition_liveness'
  confidence       REAL,                               -- 0..100 (Rekognition confidence)
  session_id       TEXT,                               -- last Rekognition liveness session id
  selfie_video_key TEXT,                               -- key in avatok-verification (locked R2)
  verified_at      INTEGER,                            -- ms epoch when status became 'verified'
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verif_status_status ON verification_status(status);

-- Per-attempt audit + rate limiting (max 3 attempts / 24h, spec §10.4).
CREATE TABLE IF NOT EXISTS verification_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  session_id  TEXT,
  result      TEXT NOT NULL DEFAULT 'pending',         -- 'pending'|'pass'|'fail'|'error'
  confidence  REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verif_attempts_uid ON verification_attempts(uid, created_at);

-- Account-deletion requests (right-to-erasure, §10.5). 30-day grace, then the
-- account-deletions queue consumer runs the 15-store cascade. Cron enqueues
-- matured requests; user can cancel within the grace window.
CREATE TABLE IF NOT EXISTS deletion_requests (
  uid          TEXT PRIMARY KEY,
  clerk_user_id TEXT,
  pubkey_hex    TEXT,                                   -- for relay-event cleanup (cron backstop)
  requested_at  INTEGER NOT NULL,
  scheduled_at  INTEGER NOT NULL,                       -- requested_at + 30 days
  status        TEXT NOT NULL DEFAULT 'pending',        -- 'pending'|'cancelled'|'processing'|'done'|'error'
  processed_at  INTEGER,
  stores_done   TEXT                                    -- JSON array of completed store names
);
CREATE INDEX IF NOT EXISTS idx_deletion_status_sched ON deletion_requests(status, scheduled_at);
