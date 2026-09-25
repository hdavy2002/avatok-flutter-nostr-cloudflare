-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- One "Payment receipt" PDF per payment. receipt_no like SH-2026-000123,
-- numbered per calendar year (IST). PDF bytes live in the PRIVATE DIGITAL R2
-- bucket at r2_key = receipts/<uid>/<receipt_no>.pdf.
CREATE TABLE IF NOT EXISTS receipts (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE,
  uid        TEXT NOT NULL,
  receipt_no TEXT NOT NULL UNIQUE,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_uid ON receipts(uid, created_at);
