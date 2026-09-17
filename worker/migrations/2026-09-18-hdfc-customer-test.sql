-- Separate invited test records; never commercial bookings or payment authority.
CREATE TABLE IF NOT EXISTS hdfc_sms_test_invites (
 invite_id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE
  CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 bound_uid TEXT,
 redeemed_at INTEGER,
 CHECK((bound_uid IS NULL)=(redeemed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS hdfc_sms_test_invites_owner
 ON hdfc_sms_test_invites(bound_uid,created_at);
CREATE TABLE IF NOT EXISTS hdfc_sms_test_bookings (
 booking_id TEXT PRIMARY KEY,
 invite_id TEXT NOT NULL UNIQUE REFERENCES hdfc_sms_test_invites(invite_id),
 intent_id TEXT NOT NULL UNIQUE REFERENCES hdfc_sms_smoke_intents(intent_id),
 uid TEXT NOT NULL,
 service_id TEXT NOT NULL CHECK(service_id='upi-demo-consultation'),
 created_at INTEGER NOT NULL,
 test_mode INTEGER NOT NULL DEFAULT 1 CHECK(test_mode=1)
);
CREATE INDEX IF NOT EXISTS hdfc_sms_test_bookings_owner
 ON hdfc_sms_test_bookings(uid,created_at);
