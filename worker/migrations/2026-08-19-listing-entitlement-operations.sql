-- [AVA-MKT-ENTITLEMENTS-2] Durable wallet -> listing entitlement boundary.
--
-- DB_META, next to listings and listing_entitlements. WalletDO remains the balance
-- authority; this table records enough state to finish an entitlement after a
-- successful idempotent WalletDO spend is followed by a transient D1 failure.
-- All statements are forward-only and safe to re-run.

-- Include the complete entitlement prerequisite here as well as the new
-- operation ledger. Older environments already have this table; fresh or
-- partially migrated environments must not depend on route-time DDL.
CREATE TABLE IF NOT EXISTS listing_entitlements (
  listing_id   TEXT    NOT NULL,
  period       INTEGER NOT NULL DEFAULT 1,
  uid          TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  charged      INTEGER NOT NULL DEFAULT 0,
  op_id        TEXT,
  period_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (listing_id, period)
);

CREATE INDEX IF NOT EXISTS idx_le_uid_quota
  ON listing_entitlements(uid, source, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_le_opid
  ON listing_entitlements(op_id) WHERE op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_le_expires
  ON listing_entitlements(expires_at);

CREATE TABLE IF NOT EXISTS listing_entitlement_operations (
  listing_id              TEXT    NOT NULL,
  period                  INTEGER NOT NULL,
  uid                     TEXT    NOT NULL,
  vertical                TEXT,
  amount                  INTEGER NOT NULL DEFAULT 0,
  funding_policy          TEXT    NOT NULL DEFAULT 'paid_only',
  fee_enabled             INTEGER NOT NULL DEFAULT 0,
  source                  TEXT    NOT NULL DEFAULT 'free',
  wallet_op_id            TEXT,
  state                   TEXT    NOT NULL DEFAULT 'quoted',
  wallet_charged          INTEGER NOT NULL DEFAULT 0,
  wallet_balance_after    INTEGER,
  entitlement_expires_at  INTEGER,
  last_error              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (listing_id, period)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leo_wallet_op
  ON listing_entitlement_operations(wallet_op_id)
  WHERE wallet_op_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leo_state_updated
  ON listing_entitlement_operations(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_leo_uid_updated
  ON listing_entitlement_operations(uid, updated_at);

-- The publish path reserves a free slot by counting active free operations that
-- have not materialized an entitlement yet. Keep that authoritative count
-- indexed; the conditional INSERT itself is the concurrency boundary.
CREATE INDEX IF NOT EXISTS idx_leo_free_quota
  ON listing_entitlement_operations(uid, source, state, entitlement_expires_at);
