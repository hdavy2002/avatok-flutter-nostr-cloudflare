-- HF host availability and booking foundation. Apply only through the reviewed
-- DB_META migration process. Exit fences use hf_exit_requests.status='booking_cleanup'
-- while bounded booking holds are released; the status remains an active account-close gate.
-- This file does not alter existing HF call rows.
CREATE TABLE IF NOT EXISTS hf_availability_schedules (
  host_uid TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  durations_json TEXT NOT NULL,
  slot_interval_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL,
  min_notice_min INTEGER NOT NULL,
  horizon_days INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  exceptions_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hf_booking_quotes (
  id TEXT PRIMARY KEY,
  customer_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  schedule_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|consumed|expired
  reserved_paise INTEGER NOT NULL,
  price_snapshot_json TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS hf_booking_quotes_owner_expiry
  ON hf_booking_quotes(customer_uid, expires_at, status);
CREATE INDEX IF NOT EXISTS hf_booking_quotes_host_slot
  ON hf_booking_quotes(host_uid, starts_at, ends_at, status);

CREATE TABLE IF NOT EXISTS hf_bookings (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  customer_uid TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  host_timezone TEXT NOT NULL,
  schedule_version INTEGER NOT NULL,
  quote_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL, -- confirming|confirmed|starting|active|settling|completed|cancelled|failed
  duration_min INTEGER NOT NULL,
  reserved_paise INTEGER NOT NULL,
  expected_host_net_paise INTEGER NOT NULL,
  expected_host_paid_net_paise INTEGER NOT NULL DEFAULT 0,
  expected_host_test_net_paise INTEGER NOT NULL DEFAULT 0,
  price_snapshot_json TEXT NOT NULL,
  policy_snapshot_json TEXT NOT NULL,
  reservation_snapshot_json TEXT NOT NULL,
  call_id TEXT UNIQUE,
  settlement_status TEXT NOT NULL DEFAULT 'held', -- held|settling|settled|released
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  completed_at INTEGER,
  UNIQUE(customer_uid, idempotency_key)
);
CREATE INDEX IF NOT EXISTS hf_bookings_host_time
  ON hf_bookings(host_uid, starts_at, ends_at, status);
CREATE INDEX IF NOT EXISTS hf_bookings_customer_time
  ON hf_bookings(customer_uid, starts_at, ends_at, status);
CREATE INDEX IF NOT EXISTS hf_bookings_status_time
  ON hf_bookings(status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS hf_booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_uid TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(booking_id, operation_id)
);
CREATE INDEX IF NOT EXISTS hf_booking_events_booking_time
  ON hf_booking_events(booking_id, created_at);

-- Local occupancy rows are the HF booking authority. The confirmation path must
-- write these and matching, title-free calendar_blocks mirrors in its D1 batch.
CREATE TABLE IF NOT EXISTS hf_booking_occupancy (
  booking_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL, -- busy|cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(booking_id, user_id)
);
CREATE INDEX IF NOT EXISTS hf_booking_occupancy_user_time
  ON hf_booking_occupancy(user_id, starts_at, ends_at, status);

-- Writers claim this short lease before checking bookings and changing a host's
-- schedule. Booking confirmation MUST test for an unexpired row for its host
-- inside the same guarded D1 batch that inserts the booking and financial hold.
CREATE TABLE IF NOT EXISTS hf_booking_schedule_locks (
  host_uid TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_booking_schedule_locks_expiry
  ON hf_booking_schedule_locks(expires_at);

-- This migration runs after 2026-10-09-hf-calls.sql and is applied once by the
-- repository migration ledger. A call belongs to at most one scheduled booking.
ALTER TABLE hf_calls ADD COLUMN booking_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS hf_calls_booking_id
  ON hf_calls(booking_id) WHERE booking_id IS NOT NULL;
