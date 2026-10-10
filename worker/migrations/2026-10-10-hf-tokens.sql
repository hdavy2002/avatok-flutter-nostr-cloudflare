-- [HF-TOK-MATH-1] HF token lots, pricing versions, Play purchases, debts and the INR host ledger. DB_META. Spec: section 11.3.
-- CREATE only (no ALTERs here; the hf_calls snapshot columns are in 2026-10-10-hf-calls-token-snapshot.sql).
-- Nothing reads or writes these tables yet. Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-10-hf-tokens.sql
-- Units: paise for rupees; micro-tokens (1 token = 1,000,000) for tokens. All integers.

CREATE TABLE IF NOT EXISTS hf_pricing_versions (
  id TEXT PRIMARY KEY,                              -- e.g. gp-v1. Rows are never edited once active; a change is a new version.
  provider TEXT NOT NULL,                           -- google_play|paytm|razorpay|cashfree
  purchase_paise_per_token INTEGER NOT NULL,        -- what the buyer pays
  redemption_paise_per_token INTEGER NOT NULL,      -- what a token is worth in call time
  provider_fee_bps INTEGER NOT NULL DEFAULT 0,      -- assumed fee, for reconciliation only
  tax_mode TEXT NOT NULL DEFAULT 'none_unregistered',
  effective_from INTEGER NOT NULL DEFAULT 0,        -- ms
  status TEXT NOT NULL DEFAULT 'active',            -- active|scheduled|retired
  note TEXT
);

CREATE TABLE IF NOT EXISTS hf_token_products (
  product_id TEXT PRIMARY KEY,                      -- Play SKU, e.g. hf_tokens_100. The price shown comes from Play, never from here.
  tokens INTEGER NOT NULL,
  pricing_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hf_token_lots (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- purchase|test|adjustment
  pricing_version TEXT NOT NULL,
  redemption_paise_per_token INTEGER NOT NULL,      -- frozen at grant: old lots are never revalued
  tokens_granted_micro INTEGER NOT NULL,
  tokens_left_micro INTEGER NOT NULL,
  tokens_reserved_micro INTEGER NOT NULL DEFAULT 0, -- held inside tokens_left for calls in progress
  paid_paise INTEGER NOT NULL DEFAULT 0,            -- what the buyer paid incl. tax; 0 for test
  provider TEXT,
  provider_ref TEXT,                                -- Play orderId
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'             -- active|revoked
);
CREATE INDEX IF NOT EXISTS hf_token_lots_uid ON hf_token_lots(uid, status, created_at);
CREATE INDEX IF NOT EXISTS hf_token_lots_ref ON hf_token_lots(provider, provider_ref);

CREATE TABLE IF NOT EXISTS hf_token_ledger (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- purchase|reserve|release|spend|refund_revoke|debt_create|debt_clear|admin_adjust
  lot_id TEXT,
  delta_micro INTEGER NOT NULL,
  rupee_value_paise INTEGER NOT NULL DEFAULT 0,
  call_id TEXT,
  purchase_id TEXT,
  op_id TEXT UNIQUE NOT NULL,                       -- idempotency key, e.g. hfplay:<orderId>, hfvoid:<orderId>
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_token_ledger_uid ON hf_token_ledger(uid, created_at);
CREATE INDEX IF NOT EXISTS hf_token_ledger_call ON hf_token_ledger(call_id);
CREATE INDEX IF NOT EXISTS hf_token_ledger_lot ON hf_token_ledger(lot_id);

CREATE TABLE IF NOT EXISTS hf_play_purchases (
  id TEXT PRIMARY KEY,
  purchase_token TEXT UNIQUE NOT NULL,
  order_id TEXT UNIQUE NOT NULL,
  product_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',            -- pending|verified|credited|consumed|refunded|revoked
  price_micros INTEGER,                             -- Play's price in micros of the currency
  currency TEXT,
  raw TEXT,                                         -- trimmed Play response
  lot_id TEXT,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  consumed_at INTEGER,
  refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS hf_play_purchases_uid ON hf_play_purchases(uid, created_at);
CREATE INDEX IF NOT EXISTS hf_play_purchases_state ON hf_play_purchases(state, created_at);

CREATE TABLE IF NOT EXISTS hf_token_debts (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  value_paise INTEGER NOT NULL,
  source_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',              -- open|cleared
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE INDEX IF NOT EXISTS hf_token_debts_uid ON hf_token_debts(uid, status);

CREATE TABLE IF NOT EXISTS hf_host_ledger (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- call_earning|call_earning_test|payout_reserve|payout_paid|payout_cancel|admin_adjust
  amount_paise INTEGER NOT NULL,                    -- signed
  call_id TEXT,
  payout_id TEXT,
  available_at INTEGER,                             -- call end + 7 days
  op_id TEXT UNIQUE NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_host_ledger_host ON hf_host_ledger(host_uid, created_at);
CREATE INDEX IF NOT EXISTS hf_host_ledger_call ON hf_host_ledger(call_id);

-- Seed: pricing version gp-v1 (Google Play, Re 1 price, Rs 0.82 value, 15% assumed fee) and the four launch packs.
INSERT OR IGNORE INTO hf_pricing_versions (id, provider, purchase_paise_per_token, redemption_paise_per_token, provider_fee_bps, tax_mode, effective_from, status, note)
VALUES ('gp-v1', 'google_play', 100, 82, 1500, 'none_unregistered', 1791590400000, 'active', 'HF-TOK-D2: launch pricing, Google Play Billing only');
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active) VALUES ('hf_tokens_100', 100, 'gp-v1', 1);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active) VALUES ('hf_tokens_200', 200, 'gp-v1', 1);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active) VALUES ('hf_tokens_500', 500, 'gp-v1', 1);
INSERT OR IGNORE INTO hf_token_products (product_id, tokens, pricing_version, active) VALUES ('hf_tokens_1000', 1000, 'gp-v1', 1);
