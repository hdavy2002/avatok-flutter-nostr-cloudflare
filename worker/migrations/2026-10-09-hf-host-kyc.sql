-- [HF-HOST-KYC-1 2026-10-09] Hello Fraands host verification (DB_META). CREATE TABLEs ONLY (CLAUDE.md: keep
-- CREATEs in their own file; scripts/d1_apply_alters.py skips CREATEs). Apply with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-host-kyc.sql
-- RULES: the full Aadhaar number is NEVER stored (only aadhaar_last4 + the vendor reference). *_enc columns
-- hold lib/pii_crypto.ts ciphertext ("v1:<iv>:<ct>"). Rulebook HF-KYC-1..5, HF-PRIV-6.

CREATE TABLE IF NOT EXISTS hf_kyc (
  uid              TEXT PRIMARY KEY,
  role             TEXT NOT NULL DEFAULT 'host',          -- 'host' | 'lane_caller'
  aadhaar_last4    TEXT,
  provider         TEXT NOT NULL DEFAULT 'sandbox',
  provider_ref     TEXT,                                   -- vendor reference_id (not the Aadhaar number)
  name_enc         TEXT,
  dob_enc          TEXT,
  address_enc      TEXT,
  guardian_name_enc TEXT,                                  -- care_of / father's name
  gender           TEXT,                                   -- 'F' | 'M' | 'T'
  age_ok           INTEGER NOT NULL DEFAULT 0,             -- 1 = 18+
  photo_r2_key     TEXT,                                   -- VERIFICATION bucket: hf/kyc/{uid}/aadhaar-photo.jpg
  consent_version  TEXT,
  consent_at       INTEGER,
  verified_at      INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hf_selfie (
  id            TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  code          TEXT NOT NULL,                             -- the 4-digit code the host read aloud
  r2_key        TEXT NOT NULL,                             -- VERIFICATION bucket: hf/selfie/{uid}/{ts}.{ext}
  mime          TEXT,
  bytes         INTEGER,
  created_at    INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',           -- 'pending' | 'approved' | 'rejected'
  review_reason TEXT,
  reviewed_by   TEXT,
  reviewed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hf_selfie_uid ON hf_selfie (uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf_selfie_status ON hf_selfie (review_status, created_at);

CREATE TABLE IF NOT EXISTS hf_payout (
  uid               TEXT PRIMARY KEY,
  upi_enc           TEXT,
  upi_verified      INTEGER NOT NULL DEFAULT 0,
  account_enc       TEXT,
  account_last4     TEXT,
  ifsc              TEXT,
  name_at_bank_enc  TEXT,
  name_match        INTEGER NOT NULL DEFAULT 0,
  verified_at       INTEGER,
  updated_at        INTEGER NOT NULL
);

-- Audit ledger of Aadhaar OTP sends/verifications (no Aadhaar number, no OTP, no PII): consent trail + abuse review.
CREATE TABLE IF NOT EXISTS hf_kyc_otp (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL,
  role          TEXT,
  provider_ref  TEXT,
  status        TEXT NOT NULL,                             -- 'sent' | 'failed' | 'verified' | 'declined' | 'rejected'
  reason        TEXT,
  consent_version TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_kyc_otp_uid ON hf_kyc_otp (uid, created_at DESC);
