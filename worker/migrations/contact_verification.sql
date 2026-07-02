-- Onboarding contact verification — phone (Firebase OTP, confirmed server-side)
-- and email (server-issued OTP, emailed via Brevo). One row per identity (uid),
-- in DB_META (binding DB_META = avatok-meta). We store only HASHES of the email
-- and phone (never the raw value — same privacy rule as profiles.email_hash),
-- plus the boolean verified flags used by the app + analytics.
CREATE TABLE IF NOT EXISTS contact_verification (
  uid             TEXT PRIMARY KEY,
  email_verified   INTEGER NOT NULL DEFAULT 0,  -- 0|1
  email_hash       TEXT,                         -- sha256(lowercased email)
  email_verified_at INTEGER,
  phone_verified   INTEGER NOT NULL DEFAULT 0,  -- 0|1
  phone_hash       TEXT,                         -- sha256(E.164 phone)
  phone_verified_at INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_verif_email ON contact_verification(email_hash);
CREATE INDEX IF NOT EXISTS idx_contact_verif_phone ON contact_verification(phone_hash);
