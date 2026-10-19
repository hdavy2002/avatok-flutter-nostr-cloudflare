-- [HF-WIRE-8] Optional note a fan leaves with a booking (shown to the influencer, never any contact detail).
-- CREATE only; purged with the account (hfPurgeTables: fan_uid, host_uid).
CREATE TABLE IF NOT EXISTS hf_booking_notes (
  booking_id TEXT PRIMARY KEY,
  fan_uid TEXT NOT NULL,
  host_uid TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_booking_notes_host ON hf_booking_notes(host_uid);
CREATE INDEX IF NOT EXISTS idx_hf_booking_notes_fan ON hf_booking_notes(fan_uid);
