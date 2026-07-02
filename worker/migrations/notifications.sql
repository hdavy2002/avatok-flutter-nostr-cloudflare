-- In-app notification feed (system/transactional alerts — wallet, moderation,
-- briefing, social). NOT chat: server-originated, not E2E. Lives in DB_META.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  uid       TEXT NOT NULL,
  type       TEXT NOT NULL,        -- wallet|system|moderation|social|brain|payment
  title      TEXT NOT NULL,
  body       TEXT,
  data       TEXT,                 -- JSON (e.g. {amount, currency, deeplink})
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(uid, read) WHERE read = 0;
