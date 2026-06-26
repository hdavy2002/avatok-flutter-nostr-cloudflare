-- AI Search sharding (Specs/PROPOSAL-AI-SEARCH-SHARDING.md). Target DB: DB_META.
--
-- ava_search_items: one row per AI Search document we index for a user, so
--   account deletion is a direct lookup (CF's Items API has delete-by-item-id but
--   NO delete-by-folder bulk op) instead of scanning a shared shard.
-- ava_search_shard_stats: a cheap per-shard running item count for CF-capacity
--   telemetry (1,000,000 files/instance cap) — used to warn at 80%.

CREATE TABLE IF NOT EXISTS ava_search_items (
  uid        TEXT    NOT NULL,
  shard      TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ava_search_items_uid   ON ava_search_items (uid);
CREATE INDEX IF NOT EXISTS idx_ava_search_items_shard ON ava_search_items (shard);

CREATE TABLE IF NOT EXISTS ava_search_shard_stats (
  shard      TEXT    PRIMARY KEY,
  item_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
