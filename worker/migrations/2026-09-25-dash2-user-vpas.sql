-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- Customer's saved UPI ids (self-reported; used as the default refund VPA).
CREATE TABLE IF NOT EXISTS user_vpas (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  vpa        TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE(uid, vpa)
);
CREATE INDEX IF NOT EXISTS idx_user_vpas_uid ON user_vpas(uid, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_vpas_one_default ON user_vpas(uid) WHERE is_default = 1;
