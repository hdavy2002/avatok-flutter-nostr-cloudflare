-- [HF-TOK-PLAY-1] Maps the obfuscated Play account id (HMAC-SHA256 of the uid, base64url) back to the uid.
-- Real-time developer notifications and the cron carry only Play's obfuscatedExternalAccountId, never our uid.
-- CREATE only. Rows are written by POST /api/hf/tokens/play/prepare (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS hf_play_accounts (
  account_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_play_accounts_uid ON hf_play_accounts(uid);
