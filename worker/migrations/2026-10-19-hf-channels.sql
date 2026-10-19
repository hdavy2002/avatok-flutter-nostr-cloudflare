-- [HF-WIRE-3] Hello Fraands Reels app: influencer Channels (Instagram + YouTube). DB_META.
-- CREATE only (apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-19-hf-channels.sql)
CREATE TABLE IF NOT EXISTS hf_channels (
  id TEXT PRIMARY KEY,
  host_uid TEXT NOT NULL,
  platform TEXT NOT NULL,                         -- instagram|youtube (facebook: coming soon)
  handle TEXT NOT NULL,
  url TEXT,
  platform_user_id TEXT,                          -- YouTube channel id / Instagram user id; set by the first successful look-up
  followers INTEGER NOT NULL DEFAULT 0,
  verify_code TEXT,                               -- one-time ownership code, e.g. HF-7K3Q9
  verified_at INTEGER,                            -- bio/description held the code at this time
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|disconnected (rejected = verified but below the follower minimum)
  consent_version TEXT,
  consent_at INTEGER,
  provider_ref TEXT,                              -- 'youtube-data-api-v3' | 'treg'
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hf_channels_host ON hf_channels(host_uid, status);
CREATE INDEX IF NOT EXISTS hf_channels_sync ON hf_channels(status, last_sync_at);
-- One real channel can belong to one influencer: a verified, still-connected channel is unique per platform account.
CREATE UNIQUE INDEX IF NOT EXISTS hf_channels_verified_unique
  ON hf_channels(platform, platform_user_id)
  WHERE verified_at IS NOT NULL AND status != 'disconnected' AND platform_user_id IS NOT NULL;
