-- [HF-FB-LOGIN-1] Facebook Login for "Social media verification". DB_META. CREATE only; the coordinator applies it:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-28-hf-facebook-login.sql
-- Flag hfFacebookLoginEnabled stays off until this is applied and Meta App Review has passed. No token is stored; this only lets
-- Meta's deauthorize / data-deletion callbacks find the channel. Data deletion requests reuse hf_ig_deletion_requests (no personal data).
CREATE TABLE IF NOT EXISTS hf_fb_logins (
  channel_id TEXT PRIMARY KEY,   -- hf_channels.id
  host_uid TEXT NOT NULL,        -- owner (account purge)
  fb_user_id TEXT NOT NULL,      -- app-scoped Facebook user id (what the signed_request names)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_fb_logins_host ON hf_fb_logins(host_uid);
CREATE INDEX IF NOT EXISTS hf_fb_logins_user ON hf_fb_logins(fb_user_id);
