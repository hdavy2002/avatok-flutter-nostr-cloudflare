-- AvaMarketplace Messenger delivery V2.
--
-- This migration is additive and intentionally does not alter the legacy
-- mkt_negotiations primary key.  New negotiations get a stable id in the run
-- table; old rows remain readable by the existing state endpoint.

CREATE TABLE IF NOT EXISTS mkt_negotiation_runs (
  negotiation_id   TEXT PRIMARY KEY,
  buyer_id         TEXT NOT NULL,
  seller_id        TEXT NOT NULL,
  listing_id       TEXT NOT NULL,
  content_version  INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  outcome          TEXT,
  agreed_price     INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL,
  approval_status  TEXT NOT NULL DEFAULT 'not_required',
  buyer_max        INTEGER NOT NULL DEFAULT 0,
  must_haves       TEXT NOT NULL DEFAULT '',
  retry_count      INTEGER NOT NULL DEFAULT 0,
  next_retry_at    INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (buyer_id, listing_id, content_version)
);

CREATE INDEX IF NOT EXISTS idx_mkt_runs_buyer_created
  ON mkt_negotiation_runs (buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mkt_runs_listing
  ON mkt_negotiation_runs (listing_id, content_version);
CREATE INDEX IF NOT EXISTS idx_mkt_runs_seller_status
  ON mkt_negotiation_runs (seller_id, status, updated_at);

CREATE TABLE IF NOT EXISTS mkt_negotiation_artifacts (
  negotiation_id       TEXT PRIMARY KEY,
  buyer_id             TEXT NOT NULL,
  seller_id            TEXT NOT NULL,
  listing_id           TEXT NOT NULL,
  content_version      INTEGER NOT NULL,
  artifact_version     INTEGER NOT NULL DEFAULT 1,
  outcome              TEXT NOT NULL,
  approval_status      TEXT NOT NULL DEFAULT 'not_required',
  agreed_price         INTEGER NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL,
  transcript_en        TEXT,
  transcript_i18n      TEXT,
  summary              TEXT,
  audio_key            TEXT UNIQUE,
  audio_sha256         TEXT,
  audio_bytes          INTEGER,
  render_status        TEXT NOT NULL DEFAULT 'queued',
  delivery_status      TEXT NOT NULL DEFAULT 'pending',
  buyer_message_id     TEXT,
  seller_message_id    TEXT,
  result_buyer_message_id  TEXT,
  result_seller_message_id TEXT,
  seller_push_sent_at  INTEGER,
  result_buyer_delivered_at  INTEGER,
  result_seller_delivered_at INTEGER,
  buyer_delivered_at   INTEGER,
  seller_delivered_at  INTEGER,
  render_attempts      INTEGER NOT NULL DEFAULT 0,
  render_claimed_at    INTEGER,
  delivery_attempts    INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mkt_artifacts_audio_key
  ON mkt_negotiation_artifacts (audio_key);
CREATE INDEX IF NOT EXISTS idx_mkt_artifacts_participants
  ON mkt_negotiation_artifacts (buyer_id, seller_id, listing_id);
CREATE INDEX IF NOT EXISTS idx_mkt_artifacts_delivery
  ON mkt_negotiation_artifacts (delivery_status, updated_at);
