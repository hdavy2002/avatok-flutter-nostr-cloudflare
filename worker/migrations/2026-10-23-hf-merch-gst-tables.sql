-- [HF-MERCH-GST-1 2026-10-23] CREATE-only (no ALTERs needed). The influencer's OPTIONAL GSTIN for merch: record only, payouts do not change because of it.
-- Apply (coordinator only, never an agent):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-10-23-hf-merch-gst-tables.sql
-- The worker tolerates the table being absent (GET /api/hf/merch/tax answers null, PUT answers 503 unavailable).
CREATE TABLE IF NOT EXISTS hf_merch_seller_tax (
  uid TEXT PRIMARY KEY,
  gstin TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
