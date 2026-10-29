-- [SUPPORT-QUEUE-1] WhatsApp outbox for the whatsapp-priority / whatsapp-normal queues.
-- Queue messages carry { job:'send', outboxId, key } only; the text lives here.
--
-- NOT the same table as `whatsapp_outbox` (2026-09-28): that one is the cron-drained buyer
-- notification outbox with checkout/listing columns and its own manual-reconcile rules.
-- Existing WhatsApp call sites are NOT migrated by this change.

CREATE TABLE IF NOT EXISTS whatsapp_queue_outbox (
  id            TEXT PRIMARY KEY,                 -- uuid; the outboxId in the queue message
  idem_key      TEXT NOT NULL UNIQUE,             -- idempotency key; the `key` in the queue message
  e164          TEXT NOT NULL,
  message       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  lane          TEXT NOT NULL DEFAULT 'normal',   -- priority | normal
  status        TEXT NOT NULL DEFAULT 'queued',   -- queued | sending | sent | failed | manual_reconcile
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  queue_accepted_at INTEGER,
  sent_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_queue_outbox_status ON whatsapp_queue_outbox(status, created_at);

-- Tiny key/value settings for queue consumers. whatsapp_min_interval_ms is the safe send rate
-- (default 1000 = 1 msg/sec for the single linked WasenderAPI number); change it with a plain
-- UPDATE, no deploy. whatsapp_last_send_at is the D1 pacing slot shared by both lanes.
CREATE TABLE IF NOT EXISTS queue_settings (
  name       TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO queue_settings (name, value, updated_at) VALUES ('whatsapp_min_interval_ms', 1000, 0);
INSERT OR IGNORE INTO queue_settings (name, value, updated_at) VALUES ('whatsapp_last_send_at', 0, 0);
