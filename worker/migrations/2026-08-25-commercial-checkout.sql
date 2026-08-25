-- Phase 2C — server-authoritative commercial checkout idempotency.
-- Additive only. Do not execute until the commercial checkout flags and the
-- matching client flow have passed staging review.

-- One row per account-bound checkout attempt. The request hash makes reuse of
-- one Idempotency-Key with a different slot or listing a hard conflict. The
-- response is replayed after a successful retry, so a wallet hold can never be
-- charged twice for the same logical purchase.
CREATE TABLE IF NOT EXISTS commercial_checkout_operations (
  operation_id    TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  listing_id      TEXT NOT NULL,
  request_sha256  TEXT NOT NULL,
  order_id        TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL CHECK (state IN ('started','completed','failed')),
  response_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_checkout_account
  ON commercial_checkout_operations(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commercial_checkout_state
  ON commercial_checkout_operations(state, updated_at);

-- SQLite treats NULLs as distinct in a normal UNIQUE constraint. Live tickets
-- have no booking_id, so this partial index is the account-bound one-ticket
-- authority. Refunded/revoked rows leave the index and may be repurchased.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_live_entitlement_active
  ON commercial_entitlements(listing_id, account_id, role)
  WHERE kind='live_event' AND booking_id IS NULL AND role='viewer'
    AND state IN ('reserved','held','active','consumed');
