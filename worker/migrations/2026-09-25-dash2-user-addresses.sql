-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- One billing/prasad address per account (shown on the payment receipt).
CREATE TABLE IF NOT EXISTS user_addresses (
  uid        TEXT PRIMARY KEY,
  name       TEXT,
  line1      TEXT,
  line2      TEXT,
  city       TEXT,
  state      TEXT,
  pin        TEXT,
  country    TEXT,
  updated_at INTEGER NOT NULL
);
