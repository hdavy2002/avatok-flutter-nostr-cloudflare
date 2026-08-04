-- [AFF-PLAY-VOID-1] Persist the provider identity and real Play price so
-- refunds can be reconciled and INR/other localized prices are auditable.
ALTER TABLE topup_records ADD COLUMN provider TEXT;
ALTER TABLE topup_records ADD COLUMN provider_purchase_token TEXT;
ALTER TABLE topup_records ADD COLUMN provider_order_id TEXT;
ALTER TABLE topup_records ADD COLUMN provider_price_minor INTEGER;
ALTER TABLE topup_records ADD COLUMN provider_price_currency TEXT;
ALTER TABLE topup_records ADD COLUMN provider_purchase_at INTEGER;
ALTER TABLE topup_records ADD COLUMN voided_at INTEGER;
ALTER TABLE topup_records ADD COLUMN voided_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_play_purchase_token
  ON topup_records(provider_purchase_token)
  WHERE provider_purchase_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topup_provider_order
  ON topup_records(provider_order_id);

CREATE TABLE IF NOT EXISTS play_voided_purchases (
  purchase_token TEXT PRIMARY KEY,
  order_id TEXT,
  product_id TEXT,
  voided_at INTEGER NOT NULL,
  voided_reason TEXT,
  topup_id TEXT,
  processed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_voided_topup ON play_voided_purchases(topup_id);
