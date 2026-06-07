-- DB_META — identity, social graph, app data.
-- Replaces every KV key the old monolith used: prof:/handle:/email:/phone:/
-- contacts:/comm:/commidx:/dir:all. None of this belongs in KV (Rulebook §KV).
-- Apply: wrangler d1 execute avatok-meta --file=migrations/meta.sql

-- Identity link (spec §3.2): Clerk owns the account, Nostr owns the signature.
CREATE TABLE IF NOT EXISTS clerk_nostr_link (
  clerk_user_id          TEXT PRIMARY KEY,
  npub                   TEXT UNIQUE NOT NULL,
  encrypted_nsec_backup  TEXT,                       -- NIP-49, only if user opted in
  backup_encryption_method TEXT,
  tier                   TEXT NOT NULL DEFAULT 'basic', -- 'basic'|'verified'|'suspended'
  account_kind           TEXT,                       -- 'personal'|'parent'|'enterprise' (restored cross-device)
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_link_npub ON clerk_nostr_link(npub);
CREATE INDEX IF NOT EXISTS idx_link_tier ON clerk_nostr_link(tier);

-- Public profile + directory (replaces KV prof:/handle:/email:).
-- email_hash enables "is my email-contact here" without storing raw email.
CREATE TABLE IF NOT EXISTS profiles (
  npub          TEXT PRIMARY KEY,
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
-- Match query: SELECT npub FROM contact_phone_index WHERE phone_hash IN (?, ?, ?)
CREATE TABLE IF NOT EXISTS contact_phone_index (
  phone_hash  TEXT NOT NULL,           -- sha256 of E.164-normalized number
  npub        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (phone_hash, npub)
);
-- No separate phone_hash index: the composite PK leads with phone_hash, so
-- `WHERE phone_hash IN (...)` already uses the PK. A second index is dead write weight.

-- Social graph query-mirror (kind 3 on the relay is source of truth).
CREATE TABLE IF NOT EXISTS follows (
  npub         TEXT NOT NULL,
  follows_npub TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (npub, follows_npub)
);
CREATE INDEX IF NOT EXISTS idx_follows_npub ON follows(npub);
CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(follows_npub);

-- Blocks — hard filter. The relay checks this before broadcasting an event from
-- B to A (and the API rejects DMs from blocked senders). Hot path: cache a
-- user's block set in the relay DO memory / Cache API rather than hitting D1 per
-- broadcast. PK leads with npub, so "all blocks for npub" + "does A block B" both
-- use the PK — no extra index.
CREATE TABLE IF NOT EXISTS blocks (
  npub         TEXT NOT NULL,          -- the user doing the blocking
  blocked_npub TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (npub, blocked_npub)
);

-- Mutes — soft filter (hide, don't reject). Mirrors NIP-51 kind 10000; kept
-- server-side so feeds/notifications can be filtered without shipping the whole
-- list to every client read.
CREATE TABLE IF NOT EXISTS mutes (
  npub       TEXT NOT NULL,
  muted_npub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (npub, muted_npub)
);

CREATE TABLE IF NOT EXISTS user_settings (
  npub          TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Push tokens — D1, not KV (Rulebook wins over stale spec §11.3). User-confirmed.
CREATE TABLE IF NOT EXISTS push_tokens (
  npub        TEXT NOT NULL,
  platform    TEXT NOT NULL,           -- 'fcm'|'apns'
  token       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (npub, token)
);
CREATE INDEX IF NOT EXISTS idx_push_npub ON push_tokens(npub);

-- Communities (replaces KV comm:/commidx:).
CREATE TABLE IF NOT EXISTS communities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  avatar_url  TEXT,
  owner_npub  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_owner ON communities(owner_npub);

CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL,
  npub         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member', -- 'owner'|'admin'|'member'
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (community_id, npub)
);
CREATE INDEX IF NOT EXISTS idx_comm_member ON community_members(npub);

-- Strike system (spec §8.5). Rulebook keeps strikes in DB_META.
CREATE TABLE IF NOT EXISTS account_strikes (
  id            TEXT PRIMARY KEY,
  npub          TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_strikes_npub ON account_strikes(npub);

CREATE TABLE IF NOT EXISTS account_status (
  clerk_user_id TEXT PRIMARY KEY,
  npub          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- 'active'|'temp_blocked'|'perm_banned'|'under_review'
  reason        TEXT,
  blocked_until INTEGER,
  blocked_at    INTEGER,
  appealed      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_status_npub ON account_status(npub);

-- Tier-2 verification (spec §3.7). App-specific table lives in DB_META until 2GB.
CREATE TABLE IF NOT EXISTS verification_requests (
  id                 TEXT PRIMARY KEY,
  clerk_user_id      TEXT NOT NULL,
  npub               TEXT NOT NULL,
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
