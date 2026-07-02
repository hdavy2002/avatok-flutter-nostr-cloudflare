-- DB_META — identity, social graph, app data.
-- Replaces every KV key the old monolith used: prof:/handle:/email:/phone:/
-- contacts:/comm:/commidx:/dir:all. None of this belongs in KV (Rulebook §KV).
-- Apply: wrangler d1 execute avatok-meta --file=migrations/meta.sql

-- Identity link (spec §3.2): Clerk owns the account, Nostr owns the signature.
CREATE TABLE IF NOT EXISTS clerk_account_link (
  clerk_user_id          TEXT PRIMARY KEY,
  uid                   TEXT UNIQUE NOT NULL,
  encrypted_key_backup  TEXT,                       -- NIP-49, only if user opted in
  backup_encryption_method TEXT,
  tier                   TEXT NOT NULL DEFAULT 'basic', -- 'basic'|'verified'|'suspended'
  account_kind           TEXT,                       -- 'personal'|'parent'|'enterprise' (restored cross-device)
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_link_uid ON clerk_account_link(uid);
CREATE INDEX IF NOT EXISTS idx_link_tier ON clerk_account_link(tier);

-- Public profile + directory (replaces KV prof:/handle:/email:).
-- email_hash enables "is my email-contact here" without storing raw email.
CREATE TABLE IF NOT EXISTS profiles (
  uid          TEXT PRIMARY KEY,
  handle        TEXT UNIQUE,            -- NIP-05 local part, lowercased
  display_name  TEXT,
  bio           TEXT,
  avatar_url    TEXT,
  email_hash    TEXT,                   -- sha256(lower(email)); never raw
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_handle ON profiles(handle);
CREATE INDEX IF NOT EXISTS idx_profiles_email_hash ON profiles(email_hash);

-- Phone discovery (WhatsApp-style "who's here"). HASHED ONLY — never raw numbers.
-- Match query: SELECT uid FROM contact_phone_index WHERE phone_hash IN (?, ?, ?)
CREATE TABLE IF NOT EXISTS contact_phone_index (
  phone_hash  TEXT NOT NULL,           -- sha256 of E.164-normalized number
  uid        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (phone_hash, uid)
);
-- No separate phone_hash index: the composite PK leads with phone_hash, so
-- `WHERE phone_hash IN (...)` already uses the PK. A second index is dead write weight.

-- Social graph query-mirror (kind 3 on the relay is source of truth).
CREATE TABLE IF NOT EXISTS follows (
  uid         TEXT NOT NULL,
  follows_uid TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (uid, follows_uid)
);
CREATE INDEX IF NOT EXISTS idx_follows_uid ON follows(uid);
CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(follows_uid);

-- Blocks — hard filter. The relay checks this before broadcasting an event from
-- B to A (and the API rejects DMs from blocked senders). Hot path: cache a
-- user's block set in the relay DO memory / Cache API rather than hitting D1 per
-- broadcast. PK leads with uid, so "all blocks for uid" + "does A block B" both
-- use the PK — no extra index.
CREATE TABLE IF NOT EXISTS blocks (
  uid         TEXT NOT NULL,          -- the user doing the blocking
  blocked_uid TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (uid, blocked_uid)
);

-- Mutes — soft filter (hide, don't reject). Mirrors NIP-51 kind 10000; kept
-- server-side so feeds/notifications can be filtered without shipping the whole
-- list to every client read.
CREATE TABLE IF NOT EXISTS mutes (
  uid       TEXT NOT NULL,
  muted_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, muted_uid)
);

CREATE TABLE IF NOT EXISTS user_settings (
  uid          TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Encrypted per-user vault: opaque client-encrypted blobs keyed by (uid, kind),
-- e.g. the contact list, so they sync across devices. The server never sees
-- plaintext — the blob is encrypted with a key derived from the user's Nostr
-- private key. Wiped on account deletion.
CREATE TABLE IF NOT EXISTS user_vault (
  uid        TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'contacts'|'settings'|'apps'
  blob        TEXT NOT NULL,            -- client-encrypted (AES-GCM) ciphertext
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, kind)
);

-- Push tokens — D1, not KV (Rulebook wins over stale spec §11.3). User-confirmed.
CREATE TABLE IF NOT EXISTS push_tokens (
  uid        TEXT NOT NULL,
  platform    TEXT NOT NULL,           -- 'fcm'|'apns'
  token       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, token)
);
CREATE INDEX IF NOT EXISTS idx_push_uid ON push_tokens(uid);

-- Communities (replaces KV comm:/commidx:).
CREATE TABLE IF NOT EXISTS communities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  avatar_url  TEXT,
  owner_uid  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_owner ON communities(owner_uid);

CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL,
  uid         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member', -- 'owner'|'admin'|'member'
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (community_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_comm_member ON community_members(uid);

-- Strike system (spec §8.5). Rulebook keeps strikes in DB_META.
CREATE TABLE IF NOT EXISTS account_strikes (
  id            TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  clerk_user_id TEXT NOT NULL,
  category      TEXT NOT NULL,
  evidence_url  TEXT,
  ai_confidence REAL,
  source        TEXT NOT NULL,         -- 'ai_auto'|'user_report'|'admin_manual'
  action_taken  TEXT NOT NULL,         -- 'warning'|'temp_block'|'perm_ban'
  created_at    INTEGER NOT NULL,
  reviewed_by   TEXT,
  reviewed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_strikes_uid ON account_strikes(uid);

CREATE TABLE IF NOT EXISTS account_status (
  clerk_user_id TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active'|'temp_blocked'|'perm_banned'|'under_review'
  reason        TEXT,
  blocked_until INTEGER,
  blocked_at    INTEGER,
  appealed      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_status_uid ON account_status(uid);

-- Tier-2 verification (spec §3.7). App-specific table lives in DB_META until 2GB.
CREATE TABLE IF NOT EXISTS verification_requests (
  id                 TEXT PRIMARY KEY,
  clerk_user_id      TEXT NOT NULL,
  uid               TEXT NOT NULL,
  status             TEXT NOT NULL,    -- 'pending'|'approved'|'rejected'|'expired'
  document_type      TEXT,             -- 'aadhaar'|'pan'|'passport'|'driving_license'
  document_front_key TEXT,             -- key in avatok-verification bucket
  document_back_key  TEXT,
  selfie_key         TEXT,
  liveness_video_key TEXT,
  submitted_at       INTEGER NOT NULL,
  reviewed_by        TEXT,
  reviewed_at        INTEGER,
  rejection_reason   TEXT,
  attempt_number     INTEGER DEFAULT 1,
  auto_rejected      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_verif_status ON verification_requests(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_verif_user ON verification_requests(clerk_user_id);
