-- [HF-IG-LOGIN-1] Log in with Instagram for influencer channels (HF-REEL-58). DB_META. CREATE only; the coordinator applies it:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-24-hf-instagram-login.sql
-- Flag hfInstagramLoginEnabled stays off until this is applied and Meta App Review has passed.

-- One row per channel connected by Instagram login. enc_token = AES-GCM ciphertext `v1.<iv>.<ct>` (key HF_TOKEN_ENC_KEY, bound to channel_id); never returned to a client.
CREATE TABLE IF NOT EXISTS hf_channel_tokens (
  channel_id TEXT PRIMARY KEY,                    -- hf_channels.id
  host_uid TEXT NOT NULL,                         -- owner (account purge)
  ig_user_id TEXT,                                -- professional account id (the /media and /comments edge owner)
  ig_scoped_id TEXT,                              -- app-scoped id (what Meta's deauthorize / data-deletion signed_request names)
  enc_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,                    -- ms epoch; long-lived tokens last 60 days, refreshed after 50
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active',          -- active | needs_reconnect (code 190 / expired: the channel and approval stay)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_channel_tokens_host ON hf_channel_tokens(host_uid, status);
CREATE INDEX IF NOT EXISTS hf_channel_tokens_igu ON hf_channel_tokens(ig_user_id);
CREATE INDEX IF NOT EXISTS hf_channel_tokens_scoped ON hf_channel_tokens(ig_scoped_id);

-- Which Instagram media a reel is (needed to read its comments). Side table: hf_reels is untouched.
CREATE TABLE IF NOT EXISTS hf_reel_ig_media (
  reel_id TEXT PRIMARY KEY,                       -- hfrl_...
  ig_media_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  host_uid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_reel_ig_media_channel ON hf_reel_ig_media(channel_id);
CREATE INDEX IF NOT EXISTS hf_reel_ig_media_host ON hf_reel_ig_media(host_uid);

-- Meta data-deletion requests (confirmation code -> the status page). Holds no personal data.
CREATE TABLE IF NOT EXISTS hf_ig_deletion_requests (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL
);
