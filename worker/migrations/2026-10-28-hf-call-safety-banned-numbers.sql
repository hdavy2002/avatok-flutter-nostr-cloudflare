-- [HF-CALL-SAFETY-BE] sha256(E.164) of a banned person's WhatsApp number: blocked from new sign-up (phone OTP send). DB_META.
CREATE TABLE IF NOT EXISTS hf_banned_numbers (
  phone_hash TEXT PRIMARY KEY,
  uid TEXT,
  reason TEXT,
  banned_at INTEGER NOT NULL,
  by_uid TEXT
);
