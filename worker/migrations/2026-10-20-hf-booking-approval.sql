-- [HF-BOOK-APPROVE-BE] CREATE only (apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-20-hf-booking-approval.sql).
-- Dedupe for the "You're open for calls" alert: one row per host, IST date and window start minute. Purged with the account (hfPurgeTables: host_uid).
CREATE TABLE IF NOT EXISTS hf_host_open_alerts (
  host_uid TEXT NOT NULL,
  date TEXT NOT NULL,          -- IST calendar date YYYY-MM-DD
  start_min INTEGER NOT NULL,  -- window start, minutes after IST midnight
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (host_uid, date, start_min)
);
-- The expiry cron scans pending bookings by deadline.
CREATE INDEX IF NOT EXISTS hf_bookings_pending_deadline ON hf_bookings(status, approval_deadline);
