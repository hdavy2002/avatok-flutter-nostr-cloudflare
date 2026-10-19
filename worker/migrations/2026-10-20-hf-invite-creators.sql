-- [HF-WIRE-22] HF-REEL-40: reels of creators who are NOT on Hello Fraands yet, shown in the Reels feed with an Invite button. DB_META.
-- CREATE only. Apply: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-20-hf-invite-creators.sql
-- Public data about public creators only (handle, name, avatar url, counts). No uid / phone / email -> nothing to purge with an account.
-- Embeds only (HF-REEL-32): hf_invite_reels keeps details next to the official embed url, NEVER a video file url (there is no video_url column).
-- handle is lowercase WITHOUT the leading @ (same as hf_invite_votes). source: search (exact-handle look-up) | vote | admin.
CREATE TABLE IF NOT EXISTS hf_invite_creators (
  platform TEXT NOT NULL,                         -- instagram|youtube
  handle TEXT NOT NULL,
  platform_user_id TEXT,                          -- YouTube channel id (UC...) / Instagram user id, from the provider look-up
  display_name TEXT,
  avatar_url TEXT,
  followers INTEGER NOT NULL DEFAULT 0,
  last_lookup_at INTEGER NOT NULL,                -- last time a fan searched for / voted for / the admin added this creator
  source TEXT NOT NULL DEFAULT 'search',
  hidden INTEGER NOT NULL DEFAULT 0,              -- 1 = admin hid this creator's reels (survives refresh)
  reels_fetched_at INTEGER,                       -- last attempt to fetch reels (rate limit: one attempt per 6 h)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (platform, handle)
);
CREATE TABLE IF NOT EXISTS hf_invite_reels (
  id TEXT PRIMARY KEY,                            -- hfiv_...
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  platform_video_id TEXT NOT NULL,
  url TEXT,
  embed_url TEXT,
  thumb_url TEXT,
  caption TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL,
  UNIQUE (platform, platform_video_id)
);
CREATE INDEX IF NOT EXISTS hf_invite_reels_creator ON hf_invite_reels(platform, handle, published_at);
