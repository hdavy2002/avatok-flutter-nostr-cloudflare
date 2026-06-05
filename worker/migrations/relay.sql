-- DB_RELAY — Nostr event store (replaces the relay DO's in-DO SQLite).
-- Single database at launch: feed reads span many authors and NIP-17 gift wraps
-- (kind 1059) carry RANDOM author keys, so author-sharding would scatter a user's
-- incoming DMs. We index recipients via nostr_tags(#p) instead. Time-shard
-- (archive events older than a cutoff to a second DB) when nostr_events nears
-- the 5 GB free-tier limit — NOT by author. Per Rulebook v1.1.
-- Apply: wrangler d1 execute avatok-relay --file=migrations/relay.sql

CREATE TABLE IF NOT EXISTS nostr_events (
  id          TEXT PRIMARY KEY,         -- 32-byte event id (hex)
  pubkey      TEXT NOT NULL,            -- author (random for gift wraps)
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  tags        TEXT NOT NULL,            -- JSON array
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evt_kind_created   ON nostr_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evt_pubkey_created ON nostr_events(pubkey, created_at DESC);

-- Flattened single-letter tag index. Powers #p (recipient/gift-wrap delivery),
-- #e (reply threads), #d (replaceable), etc. — no LIKE scans.
CREATE TABLE IF NOT EXISTS nostr_tags (
  event_id    TEXT NOT NULL,
  tag         TEXT NOT NULL,           -- single letter: 'p','e','d','a',...
  value       TEXT NOT NULL,
  kind        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (event_id, tag, value)
);
CREATE INDEX IF NOT EXISTS idx_tags_lookup ON nostr_tags(tag, value, created_at DESC);
