-- Additive only: old policy snapshots retain their exact money and policy version.
-- A quote is committed before a wallet hold or external payment order is created.
CREATE TABLE IF NOT EXISTS commercial_pricing_quotes (
  order_id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  quote_json TEXT NOT NULL CHECK (json_valid(quote_json)),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS commercial_pricing_quotes_immutable
BEFORE UPDATE ON commercial_pricing_quotes
BEGIN
  SELECT RAISE(ABORT, 'commercial pricing quote is immutable');
END;

-- NULL identifies an extension quoted before the authoritative pricing contract.
ALTER TABLE commercial_consult_extensions ADD COLUMN pricing_quote_json TEXT
  CHECK (pricing_quote_json IS NULL OR json_valid(pricing_quote_json));

CREATE TRIGGER IF NOT EXISTS commercial_extension_pricing_immutable
BEFORE UPDATE OF pricing_quote_json,amount,rate_per_minute,extension_minutes,currency,
  base_ends_at,extension_ends_at ON commercial_consult_extensions
BEGIN
  SELECT RAISE(ABORT, 'commercial extension pricing is immutable');
END;

-- Stable refund/release amounts across a retry after money has already moved.
CREATE TABLE IF NOT EXISTS commercial_settlement_money_plans (
  order_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commercial_settlement_money_plans_immutable
BEFORE UPDATE ON commercial_settlement_money_plans
BEGIN
  SELECT RAISE(ABORT, 'commercial settlement money plan is immutable');
END;

CREATE TABLE IF NOT EXISTS commercial_refund_intents (
  order_id TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0 AND typeof(amount) = 'integer'),
  rail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commercial_refund_intents_immutable
BEFORE UPDATE ON commercial_refund_intents
BEGIN
  SELECT RAISE(ABORT, 'commercial refund intent is immutable');
END;
