-- [SAATHUM-UPI-3LAYER 2026-09-29] Layer 2 is now the third-party "Auto Forward SMS - Forwarder"
-- app (POST/GET /api/sms/forward/:token). CREATE-only, idempotent, additive. Apply AFTER
-- 2026-09-29-saathum-upi-3layer-tables.sql. NOT applied by the implementing agent:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-29-sms-forwarder.sql
--
-- sms_forwarder_captures: onboarding aid (flag smsForwarderCaptureEnabled, default off). Keeps the
-- LAST 20 requests the app sent -- content type, top-level keys and a redacted <=2 KB body sample --
-- so the exact payload format can be read via GET /api/admin/saathum/forwarder/captures.
-- Redaction keeps only the last 4 digits of any 10+ digit run; the URL token is never stored.
CREATE TABLE IF NOT EXISTS sms_forwarder_captures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  INTEGER NOT NULL,
  method       TEXT NOT NULL,
  content_type TEXT,
  top_keys     TEXT NOT NULL,   -- JSON array of top-level key names (body + query string)
  body_sample  TEXT NOT NULL    -- redacted, capped at 2048 chars
);
CREATE INDEX IF NOT EXISTS idx_sms_forwarder_captures_received ON sms_forwarder_captures(received_at);

-- sms_source_health already holds one row per ingest device; the forwarder uses device_id
-- 'forwarder', source 'forwarder' (no schema change needed -- source is free text). This index
-- speeds the 24 h "watcher saw credits but the forwarder was silent" check and the
-- corroboration lookup (both scan hdfc_sms_receipts by device and time).
CREATE INDEX IF NOT EXISTS idx_hdfc_sms_receipts_device_created ON hdfc_sms_receipts(device_id, created_at);
