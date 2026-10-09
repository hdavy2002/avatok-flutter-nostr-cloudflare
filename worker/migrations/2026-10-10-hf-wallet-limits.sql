-- [HF-WALLET-LIMITS-1] HF caller spend limits (per-user override), payment receipts / GST tax invoices, document counters. DB_META.
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-10-hf-wallet-limits.sql
-- The ALTER TABLE line fails harmlessly if re-run once the column exists; run it once. Everything else is IF NOT EXISTS.

-- Per-user override of the default limits (flags hfDailySpendLimitRupees / hfMonthlySpendLimitRupees). NULL column = use the default.
CREATE TABLE IF NOT EXISTS hf_spend_limits (
  uid TEXT PRIMARY KEY,
  daily_rupees INTEGER,
  monthly_rupees INTEGER,
  note TEXT,
  admin_uid TEXT,
  updated_at INTEGER NOT NULL
);

-- One row per issued document. kind receipt = plain payment receipt (no GSTIN yet); tax_invoice = GST invoice on the platform share.
CREATE TABLE IF NOT EXISTS hf_receipts (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,                 -- <prefix>/R/<FY>/<seq> or <prefix>/I/<short FY>/<seq>
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- receipt | tax_invoice
  source TEXT NOT NULL,                        -- topup | call | statement
  source_id TEXT NOT NULL,                     -- hf_topups.id, hf_calls.id, or <uid>:<YYYY-MM> for a monthly statement
  amount_rupees INTEGER NOT NULL,              -- gross amount the document covers (whole rupees for receipts)
  taxable_paise INTEGER,
  gst_paise INTEGER,
  gstin TEXT,                                  -- supplier GSTIN at issue time (tax invoices only)
  issued_at INTEGER NOT NULL,
  data TEXT                                    -- JSON detail (gateway, split, lines ...)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_receipts_source ON hf_receipts(kind, source, source_id);
CREATE INDEX IF NOT EXISTS idx_hf_receipts_uid ON hf_receipts(uid, issued_at);

-- Gapless per-series counter (series = "R/2026-27" or "I/2026-27"). next = the number the next document gets.
CREATE TABLE IF NOT EXISTS hf_doc_counters (
  series TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

-- Lets the limit check count paid money a call may still spend while it is in progress.
ALTER TABLE hf_calls ADD COLUMN limit_cap_rupees INTEGER;
