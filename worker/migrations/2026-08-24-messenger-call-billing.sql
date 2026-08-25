-- Phase 1 Messenger caller-funded billing foundation.
--
-- Target: DB_WALLET / avatok-wallet.
-- WalletDO remains the serialized balance and allowance authority. These D1
-- tables are the immutable/queryable contract and usage audit trail. Provider
-- routes are wired only behind the dark Messenger billing master gate, which
-- remains false in config.ts.
--
-- Do not reuse human_call_usage from WalletDO: that table implements the
-- superseded 200 participant-minute UTC-month, per-seat product.

CREATE TABLE IF NOT EXISTS messenger_call_authorizations (
  authorization_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL,
  payer_uid TEXT NOT NULL,
  callee_uid TEXT NOT NULL,
  media TEXT NOT NULL CHECK (media IN ('audio', 'video')),
  quality_sku TEXT NOT NULL CHECK (quality_sku IN ('audio', 'video_sd', 'video_hd', 'video_2k', 'video_4k')),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'stream')),
  rate_centitokens_per_participant_minute INTEGER NOT NULL CHECK (rate_centitokens_per_participant_minute >= 0),
  price_version INTEGER NOT NULL CHECK (price_version >= 1),
  consent_id TEXT,
  allowance_day TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending_consent', 'authorized', 'connected', 'ended',
    'refused', 'expired', 'cancelled', 'failed', 'funds_exhausted',
    -- Provider end/create compensation is not confirmed. The reservation is
    -- deliberately retained until a webhook/reaper reconciles this row.
    'reconciliation_pending'
  )),
  reservation_ref TEXT,
  reservation_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reservation_tokens >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  connected_at INTEGER,
  ended_at INTEGER,
  terminal_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_messenger_call_auth_payer_created
  ON messenger_call_authorizations(payer_uid, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messenger_call_auth_payer_attempt
  ON messenger_call_authorizations(payer_uid, attempt_id);

CREATE INDEX IF NOT EXISTS idx_messenger_call_auth_callee_created
  ON messenger_call_authorizations(callee_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messenger_call_auth_status_expiry
  ON messenger_call_authorizations(status, expires_at);

CREATE TABLE IF NOT EXISTS messenger_call_usage_ledger (
  tick_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  payer_uid TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'stream')),
  quality_sku TEXT NOT NULL CHECK (quality_sku IN ('audio', 'video_sd', 'video_hd', 'video_2k', 'video_4k')),
  interval_start_ms INTEGER NOT NULL,
  interval_end_ms INTEGER NOT NULL,
  participant_count INTEGER NOT NULL CHECK (participant_count = 2),
  participant_seconds INTEGER NOT NULL CHECK (participant_seconds > 0),
  free_participant_seconds INTEGER NOT NULL CHECK (free_participant_seconds >= 0),
  paid_participant_seconds INTEGER NOT NULL CHECK (paid_participant_seconds >= 0),
  charged_centitoken_seconds INTEGER NOT NULL CHECK (charged_centitoken_seconds >= 0),
  tokens_funded INTEGER NOT NULL CHECK (tokens_funded >= 0),
  price_version INTEGER NOT NULL CHECK (price_version >= 1),
  created_at INTEGER NOT NULL,
  CHECK (interval_end_ms > interval_start_ms),
  CHECK (participant_seconds = free_participant_seconds + paid_participant_seconds)
);

CREATE INDEX IF NOT EXISTS idx_messenger_call_usage_authorization
  ON messenger_call_usage_ledger(authorization_id, interval_start_ms);

CREATE INDEX IF NOT EXISTS idx_messenger_call_usage_payer_created
  ON messenger_call_usage_ledger(payer_uid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messenger_call_usage_call
  ON messenger_call_usage_ledger(call_id, interval_start_ms);

-- One immutable caller-visible summary per terminal authorization. The
-- WalletDO remains the balance/allowance authority; this row makes a receipt
-- queryable and reconcilable after the asynchronous wallet transaction lands.
CREATE TABLE IF NOT EXISTS messenger_call_receipts (
  authorization_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  payer_uid TEXT NOT NULL,
  media TEXT NOT NULL CHECK (media IN ('audio', 'video')),
  quality_sku TEXT NOT NULL CHECK (quality_sku IN ('audio', 'video_sd', 'video_hd', 'video_2k', 'video_4k')),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare', 'stream')),
  connected_wall_seconds INTEGER NOT NULL CHECK (connected_wall_seconds >= 0),
  participant_seconds INTEGER NOT NULL CHECK (participant_seconds >= 0),
  free_participant_seconds INTEGER NOT NULL CHECK (free_participant_seconds >= 0),
  paid_participant_seconds INTEGER NOT NULL CHECK (paid_participant_seconds >= 0),
  rate_centitokens_per_participant_minute INTEGER NOT NULL CHECK (rate_centitokens_per_participant_minute >= 0),
  price_version INTEGER NOT NULL CHECK (price_version >= 1),
  tokens_charged INTEGER NOT NULL CHECK (tokens_charged >= 0),
  ending_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (participant_seconds = free_participant_seconds + paid_participant_seconds),
  CHECK (participant_seconds = connected_wall_seconds * 2)
);

CREATE INDEX IF NOT EXISTS idx_messenger_call_receipts_payer_created
  ON messenger_call_receipts(payer_uid, created_at DESC);
