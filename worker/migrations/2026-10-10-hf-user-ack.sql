-- [HF-NATIVE-S4] Native app: which terms/safety text a user accepted. CREATE only (apply before the Worker deploy).
-- One row per (user, version); the first ack of a version wins. GET /api/hf/me returns the newest row's version as ackVersion.
-- The "I am 18 or over" tick is NOT stored here: it goes to hf_age_confirm (migration 2026-10-10-hf-auth-wa.sql).
-- Removed with the account by purgeHfUser (worker/src/lib/hf_purge.ts + consumers/src/hf_purge.ts).
CREATE TABLE IF NOT EXISTS hf_user_ack (
  uid TEXT NOT NULL,
  version TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (uid, version)
);
