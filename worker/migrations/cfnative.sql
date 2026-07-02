-- Cloudflare-native pivot (2026-06-09) — uid-keyed core (Nostr deprecated).
-- Identity is now the Clerk user id (uid). These tables REPLACE the uid-keyed
-- identity/messaging surfaces going forward; the legacy uid tables (profiles,
-- clerk_account_link, blocks, mutes, push_tokens) are dropped in the housekeeping
-- re-key pass once every route is migrated. Additive here so the in-flight worker
-- keeps serving until the new worker version ships.
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/cfnative.sql
--
-- Messages do NOT live here — they live in DO-local SQLite per user (InboxDO).
-- D1 holds only low-write global query surfaces (directory, routing, gates).

-- The user / public directory. uid = Clerk user id (account authority).
CREATE TABLE IF NOT EXISTS users (
  uid           TEXT PRIMARY KEY,                 -- Clerk user id
  handle        TEXT UNIQUE,                      -- @handle, lowercased
  display_name  TEXT,
  bio           TEXT,
  avatar_url    TEXT,
  email_hash    TEXT,                             -- sha256(lower(email)); never raw
  phone_hash    TEXT,                             -- sha256(E.164); never raw
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash);

-- KYC gate (Stripe Identity). Sending / posting / transacting require 'verified'.
CREATE TABLE IF NOT EXISTS kyc_status (
  uid          TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'unverified', -- 'unverified'|'pending'|'verified'|'rejected'
  provider     TEXT,                               -- 'stripe_identity'
  session_id   TEXT,                               -- Stripe VerificationSession id
  verified_at  INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_status(status);

-- Conversations — membership routing for the InboxDO fan-out. 1:1 ('dm') or
-- 'group'. AvaTok calls are 1:1 only; group chats keep full messaging.
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,                    -- 'dm_<minUid>__<maxUid>' or 'g_<uuid>'
  kind        TEXT NOT NULL DEFAULT 'dm',          -- 'dm'|'group'
  title       TEXT,
  avatar_url  TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conv_id    TEXT NOT NULL,
  uid        TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',       -- 'owner'|'admin'|'member'
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (conv_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_convmem_uid ON conversation_members(uid);

-- Blocks — hard filter. The router refuses to deliver a message from a sender
-- the recipient has blocked. uid-keyed (going-forward).
CREATE TABLE IF NOT EXISTS user_blocks (
  uid          TEXT NOT NULL,                      -- the blocker
  blocked_uid  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (uid, blocked_uid)
);

-- Mutes — soft filter (hide, don't reject).
CREATE TABLE IF NOT EXISTS user_mutes (
  uid        TEXT NOT NULL,
  muted_uid  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, muted_uid)
);

-- Push tokens — uid-keyed (FCM/APNs) for offline delivery via Q_PUSH.
CREATE TABLE IF NOT EXISTS push_tokens_v2 (
  uid        TEXT NOT NULL,
  platform   TEXT NOT NULL,                        -- 'fcm'|'apns'
  token      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, token)
);
CREATE INDEX IF NOT EXISTS idx_push_v2_uid ON push_tokens_v2(uid);
