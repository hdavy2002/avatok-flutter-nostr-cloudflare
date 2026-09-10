-- [WEB-PHONE-OTP-1 2026-09-10] Phone OTP sends for web sign-up (2Factor.in).
-- One row per SMS sent. Doubles as the rate-limit ledger (per uid, per phone,
-- global) and as the record of which 2Factor session a code belongs to.
-- The verified RESULT lives in contact_verification (phone_verified=1).
-- CREATE-only file on purpose: d1_apply_alters.py skips CREATEs, apply with
--   ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/phone_otp.sql
CREATE TABLE IF NOT EXISTS phone_otp (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uid          TEXT NOT NULL,
  phone_hash   TEXT NOT NULL,              -- sha256(E.164)
  e164         TEXT NOT NULL,              -- +91XXXXXXXXXX
  session_id   TEXT,                       -- 2Factor "Details" from the send; NULL if the send failed
  status       TEXT NOT NULL,              -- sent | failed | verified | expired
  attempts     INTEGER NOT NULL DEFAULT 0, -- verify attempts against this code
  created_at   INTEGER NOT NULL,
  verified_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_phone_otp_uid   ON phone_otp(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_phone_otp_phone ON phone_otp(phone_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_phone_otp_time  ON phone_otp(created_at);
