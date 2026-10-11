-- [HF-STD-PLAN-1] Prepared Play product contracts. Apply after the Standard-plan ALTER migration and before enabling the flag.
CREATE TABLE IF NOT EXISTS hf_play_prepare_snapshots (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  product_id TEXT NOT NULL,
  pricing_snapshot TEXT NOT NULL,
  prepared_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_play_prepare_snapshots_product_time ON hf_play_prepare_snapshots(uid, product_id, prepared_at DESC);
