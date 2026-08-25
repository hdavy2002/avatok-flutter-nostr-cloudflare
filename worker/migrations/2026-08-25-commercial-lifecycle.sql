-- Phase 2E — commercial cancellation/refund and reschedule authority.
-- Additive and migration-owned. Runtime routes only read-probe these tables.

CREATE TABLE IF NOT EXISTS commercial_lifecycle_operations (
  operation_id   TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('cancel','reschedule','calendar')),
  account_id     TEXT NOT NULL,
  order_id       TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('started','completed','failed','review_pending')),
  response_json  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_lifecycle_request
  ON commercial_lifecycle_operations(account_id, operation_type, order_id, request_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_cancel_order_claim
  ON commercial_lifecycle_operations(order_id)
  WHERE operation_type='cancel';
CREATE INDEX IF NOT EXISTS idx_commercial_lifecycle_state
  ON commercial_lifecycle_operations(state, updated_at);

-- A single money claim owns the order across the D1-to-wallet boundary. The
-- settlement and refund paths both INSERT OR IGNORE this row before calling
-- WalletDO; the first claimant wins and retries by that same operation id stay
-- idempotent. A completed claim is intentionally never deleted or recycled.
CREATE TABLE IF NOT EXISTS commercial_money_claims (
  order_id    TEXT PRIMARY KEY,
  claim_type  TEXT NOT NULL CHECK (claim_type IN ('settlement','refund')),
  claim_id    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('claimed','completed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_money_claim_state
  ON commercial_money_claims(state, updated_at);

-- Refund receipts are immutable and do not require a provider session. This is
-- important when a live event is cancelled before anyone joins and therefore
-- has no commercial_sessions row. One order can have one terminal refund
-- receipt; the escrow refund operation is the matching idempotency boundary.
CREATE TABLE IF NOT EXISTS commercial_refund_receipts (
  refund_receipt_id      TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL UNIQUE,
  commercial_session_id TEXT,
  listing_id            TEXT NOT NULL,
  booking_id            TEXT,
  buyer_id              TEXT NOT NULL,
  creator_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  gross_amount          INTEGER NOT NULL CHECK (gross_amount >= 0),
  refunded_amount       INTEGER NOT NULL CHECK (refunded_amount >= 0),
  remaining_amount      INTEGER NOT NULL CHECK (remaining_amount >= 0),
  platform_fee_amount   INTEGER NOT NULL CHECK (platform_fee_amount >= 0),
  creator_amount        INTEGER NOT NULL CHECK (creator_amount >= 0),
  currency              TEXT NOT NULL,
  settlement_state      TEXT NOT NULL CHECK (settlement_state IN ('refunded','partial_refund')),
  reason                TEXT NOT NULL,
  actor                 TEXT NOT NULL CHECK (actor IN ('buyer','creator','provider','system')),
  policy_snapshot_id    TEXT NOT NULL,
  issued_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_refund_receipt_order
  ON commercial_refund_receipts(order_id, issued_at);
