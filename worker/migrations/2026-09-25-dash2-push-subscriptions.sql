-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- Web Push subscriptions (table only; sending lands later).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_uid ON push_subscriptions(uid);
