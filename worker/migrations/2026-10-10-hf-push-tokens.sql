-- [HF-APP-4] Android push tokens for the HF app (Capacitor shell). CREATE only.
-- One row per device token. A token moves to the newest signed-in user (UNIQUE token), so a shared phone never
-- delivers one person's pushes to another. Deleted on sign-out, on account deletion (hf_purge.ts), when FCM says
-- the token is dead (consumers/src/fcm.ts) and after 180 days without being seen (hf_retention.ts).
CREATE TABLE IF NOT EXISTS hf_push_tokens (
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  shell TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hf_push_tokens_user ON hf_push_tokens(user_id);
