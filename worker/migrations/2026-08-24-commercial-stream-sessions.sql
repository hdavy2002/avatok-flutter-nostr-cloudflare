-- Phase 2A — provider-neutral commercial live/consultation authority.
-- DB: DB_META. Additive only. This migration is intentionally NOT executed by
-- creating this file; production stays dark until the owner authorizes it.
--
-- Public listing URLs are discovery links. Admission is always resolved from
-- an authenticated account-bound entitlement below; no provider token, call
-- CID, order id, or reusable admission secret belongs in a share URL.

CREATE TABLE IF NOT EXISTS commercial_policy_snapshots (
  policy_snapshot_id       TEXT PRIMARY KEY,
  order_id                 TEXT NOT NULL UNIQUE,
  listing_id               TEXT NOT NULL,
  booking_id               TEXT,
  buyer_id                 TEXT NOT NULL,
  creator_id               TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  gross_amount             INTEGER NOT NULL CHECK (gross_amount >= 0),
  currency                 TEXT NOT NULL,
  creator_fee_pct          INTEGER NOT NULL CHECK (creator_fee_pct BETWEEN 0 AND 100),
  settlement_hold_hours    INTEGER NOT NULL CHECK (settlement_hold_hours >= 0),
  platform_fee_amount      INTEGER NOT NULL CHECK (platform_fee_amount >= 0),
  creator_amount           INTEGER NOT NULL CHECK (creator_amount >= 0),
  cancellation_policy_json TEXT NOT NULL,
  conversion_snapshot_json TEXT,
  policy_version           TEXT NOT NULL,
  created_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_policy_listing
  ON commercial_policy_snapshots(listing_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commercial_policy_booking
  ON commercial_policy_snapshots(booking_id);

CREATE TABLE IF NOT EXISTS commercial_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  listing_id     TEXT NOT NULL,
  booking_id     TEXT,
  order_id       TEXT,
  account_id     TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('host','viewer','creator','buyer')),
  state          TEXT NOT NULL CHECK (state IN ('reserved','held','active','revoked','refunded','consumed')),
  starts_at      INTEGER,
  ends_at        INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(kind, listing_id, booking_id, account_id, role)
);
CREATE INDEX IF NOT EXISTS idx_commercial_entitlement_account
  ON commercial_entitlements(account_id, state, starts_at);
CREATE INDEX IF NOT EXISTS idx_commercial_entitlement_listing
  ON commercial_entitlements(listing_id, state);
CREATE INDEX IF NOT EXISTS idx_commercial_entitlement_order
  ON commercial_entitlements(order_id);

CREATE TABLE IF NOT EXISTS commercial_sessions (
  commercial_session_id TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  listing_id             TEXT NOT NULL,
  booking_id             TEXT,
  order_id               TEXT,
  creator_id             TEXT NOT NULL,
  provider               TEXT NOT NULL CHECK (provider = 'getstream'),
  provider_call_type     TEXT NOT NULL CHECK (provider_call_type IN ('avatok_livestream','avatok_consult_1to1')),
  provider_call_id       TEXT NOT NULL,
  session_version        INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
  scheduled_at           INTEGER NOT NULL,
  backstage_opened_at    INTEGER,
  live_started_at        INTEGER,
  ended_at               INTEGER,
  state                  TEXT NOT NULL CHECK (state IN ('scheduled','backstage','live','ending','ended','cancelled','reconciliation_pending')),
  state_version          INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  settlement_state       TEXT NOT NULL DEFAULT 'not_ready'
    CHECK (settlement_state IN ('not_ready','pending','review_pending','held','settled','refunded')),
  recording_state        TEXT NOT NULL DEFAULT 'disabled'
    CHECK (recording_state IN ('disabled','requested','recording','ready','failed')),
  replay_state           TEXT NOT NULL DEFAULT 'disabled'
    CHECK (replay_state IN ('disabled','processing','available','removed','failed')),
  policy_snapshot_id     TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(provider, provider_call_type, provider_call_id),
  UNIQUE(kind, listing_id, booking_id, session_version)
);
CREATE INDEX IF NOT EXISTS idx_commercial_session_listing
  ON commercial_sessions(listing_id, state, session_version);
CREATE INDEX IF NOT EXISTS idx_commercial_session_booking
  ON commercial_sessions(booking_id, state);
CREATE INDEX IF NOT EXISTS idx_commercial_session_settlement
  ON commercial_sessions(settlement_state, updated_at);

-- Server-owned membership is the only provider-id → AvaTOK-account mapping.
-- A consultation must have exactly one creator and one buyer row.
CREATE TABLE IF NOT EXISTS commercial_session_members (
  commercial_session_id TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  entitlement_id         TEXT NOT NULL,
  provider_user_id       TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('host','viewer','creator','buyer')),
  added_at                INTEGER NOT NULL,
  removed_at              INTEGER,
  PRIMARY KEY (commercial_session_id, account_id),
  UNIQUE(commercial_session_id, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_member_entitlement
  ON commercial_session_members(entitlement_id);

-- Immutable signed-provider evidence inbox. Reconciliation may annotate
-- processing state but never replace provider payload/evidence.
CREATE TABLE IF NOT EXISTS commercial_provider_events (
  provider_event_id      TEXT PRIMARY KEY,
  provider               TEXT NOT NULL CHECK (provider = 'getstream'),
  provider_call_type     TEXT,
  provider_call_id       TEXT,
  commercial_session_id  TEXT,
  event_type             TEXT NOT NULL,
  provider_user_id       TEXT,
  provider_occurred_at   INTEGER,
  received_at            INTEGER NOT NULL,
  payload_sha256         TEXT NOT NULL,
  payload_json           TEXT NOT NULL,
  evidence_source        TEXT NOT NULL DEFAULT 'signed_webhook'
    CHECK (evidence_source IN ('signed_webhook','authenticated_reconciliation')),
  processing_state       TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_state IN ('received','applied','duplicate','ignored','review_pending')),
  processed_at           INTEGER,
  processing_error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_commercial_event_session
  ON commercial_provider_events(commercial_session_id, provider_occurred_at);
CREATE INDEX IF NOT EXISTS idx_commercial_event_call
  ON commercial_provider_events(provider, provider_call_type, provider_call_id, received_at);
CREATE INDEX IF NOT EXISTS idx_commercial_event_review
  ON commercial_provider_events(processing_state, received_at);

CREATE TABLE IF NOT EXISTS commercial_participant_intervals (
  interval_id             TEXT PRIMARY KEY,
  commercial_session_id   TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  provider_user_id        TEXT NOT NULL,
  provider_session_id     TEXT NOT NULL,
  joined_event_id         TEXT NOT NULL,
  left_event_id           TEXT,
  joined_at               INTEGER NOT NULL,
  left_at                 INTEGER,
  connected_ms            INTEGER,
  reconciliation_state    TEXT NOT NULL DEFAULT 'open'
    CHECK (reconciliation_state IN ('open','closed','review_pending','reconciled')),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE(commercial_session_id, provider_user_id, provider_session_id, joined_event_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_interval_session
  ON commercial_participant_intervals(commercial_session_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_commercial_interval_account
  ON commercial_participant_intervals(account_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_commercial_interval_open
  ON commercial_participant_intervals(commercial_session_id, reconciliation_state, joined_at);

CREATE TABLE IF NOT EXISTS commercial_control_operations (
  operation_id          TEXT PRIMARY KEY,
  commercial_session_id TEXT NOT NULL,
  actor_id              TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('prepare_host','go_live','end')),
  state                 TEXT NOT NULL CHECK (state IN ('pending','confirmed','failed','reconciliation_pending')),
  provider_status       INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(commercial_session_id, action, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_control_pending
  ON commercial_control_operations(state, updated_at);

-- Terminal provider evidence creates exactly one pending settlement handoff.
-- A separate money worker will snapshot/release escrow and then create the
-- immutable receipt. The webhook receiver never guesses a payout.
CREATE TABLE IF NOT EXISTS commercial_settlement_jobs (
  settlement_job_id     TEXT PRIMARY KEY,
  commercial_session_id TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('pending','processing','review_pending','settled','refunded')),
  terminal_event_id     TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  funds_verified_at     INTEGER,
  ledger_confirmed_at   INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(commercial_session_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_settlement_jobs_state
  ON commercial_settlement_jobs(state, updated_at);

CREATE TABLE IF NOT EXISTS commercial_receipts (
  receipt_id             TEXT PRIMARY KEY,
  commercial_session_id  TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  listing_id             TEXT NOT NULL,
  booking_id             TEXT,
  buyer_id               TEXT,
  creator_id             TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  gross_amount            INTEGER NOT NULL,
  platform_fee_amount     INTEGER NOT NULL,
  creator_amount          INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  settlement_state        TEXT NOT NULL CHECK (settlement_state IN ('settled','refunded','partial_refund')),
  connected_ms            INTEGER NOT NULL DEFAULT 0,
  policy_snapshot_id      TEXT,
  issued_at               INTEGER NOT NULL,
  UNIQUE(commercial_session_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_commercial_receipt_order
  ON commercial_receipts(order_id);
