-- Phase 7 — DLQ landing zone for the money queue (DB_WALLET / avatok-wallet).
-- A settlement job that exhausted its 5 retries lands here; the admin console
-- retries it manually (POST /api/admin/settlements/:id/retry).
CREATE TABLE IF NOT EXISTS failed_settlements (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,             -- the original Q_MONEY message (JSON)
  error      TEXT,
  created_at INTEGER NOT NULL,
  retried_at INTEGER,
  status     TEXT NOT NULL DEFAULT 'failed'  -- failed|retried|resolved
);
CREATE INDEX IF NOT EXISTS idx_failed_settlements ON failed_settlements(status, created_at);
