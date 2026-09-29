-- [SAATHUM-UPI-3LAYER 2026-09-29] New tables for the 3-layer UPI confirmation.
-- CREATE-only, idempotent (IF NOT EXISTS). Apply AFTER 2026-09-29-saathum-upi-3layer.sql.
-- NOT applied by the implementing agent:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-29-saathum-upi-3layer-tables.sql
--
-- saathum_amount_reservations: one row per (receiving account, exact payable paise).
-- The PRIMARY KEY is the unique-amount enforcement; a slot is re-used only through a
-- single guarded upsert (lib/saathum_upi3.ts reserveUniqueAmount) that succeeds only when
-- reserved_until has passed (2 h cooldown after expiry/cancel) AND the previous holder is
-- not sitting in the admin review queue.
CREATE TABLE IF NOT EXISTS saathum_amount_reservations (
  receiving_account_key TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL,
  checkout_id           TEXT NOT NULL,
  reserved_until        INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (receiving_account_key, amount_paise)
);
CREATE INDEX IF NOT EXISTS idx_saathum_amount_res_checkout ON saathum_amount_reservations(checkout_id);

-- sms_source_health: one row per ingest device (companion app / Google Messages watcher).
CREATE TABLE IF NOT EXISTS sms_source_health (
  device_id         TEXT PRIMARY KEY,
  source            TEXT NOT NULL,          -- 'companion' | 'watcher'
  last_heartbeat_at INTEGER,
  last_sms_at       INTEGER,
  last_error        TEXT,
  alerted_at        INTEGER,                -- last stale alert sent (hourly re-alert)
  stale_alert_open  INTEGER NOT NULL DEFAULT 0, -- 1 while a stale alert is outstanding (drives "recovered")
  updated_at        INTEGER NOT NULL
);
