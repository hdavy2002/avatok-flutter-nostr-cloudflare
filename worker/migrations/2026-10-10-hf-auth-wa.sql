-- [HF-AUTH-WA-1] WhatsApp-only sign-up. CREATE only.
-- hf_phone_signup: one row per phone hash that has gone through phone-only sign-up. The PRIMARY KEY is the lock:
-- two verifies racing for the same new number both try to INSERT, exactly one wins and creates the Clerk user.
-- ext_id is the unguessable Clerk external_id chosen BEFORE the Clerk call, so a retry after a crash finds the same
-- Clerk user instead of making a second one. uid is set as soon as Clerk has the user; state is 'creating'|'done'.
CREATE TABLE IF NOT EXISTS hf_phone_signup (
  phone_hash TEXT PRIMARY KEY,
  ext_id TEXT NOT NULL,
  uid TEXT,
  state TEXT NOT NULL DEFAULT 'creating',
  lease_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_phone_signup_uid ON hf_phone_signup(uid);
-- hf_age_confirm: the "I am 18 or over" confirmation, one row per user (first confirmation wins).
CREATE TABLE IF NOT EXISTS hf_age_confirm (
  uid TEXT PRIMARY KEY,
  confirmed_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
