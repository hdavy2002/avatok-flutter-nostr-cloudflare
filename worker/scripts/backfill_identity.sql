-- P0 backfill (NOTE + partial SQL).
-- Design: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md (v4) §12.
-- Target DB: avatok-meta (binding DB_META).
--
-- WHY THIS IS A NOTE, NOT A ONE-SHOT SQL BACKFILL
-- ----------------------------------------------
-- Every users.uid needs a MINTED opaque identity_id of the form `idn_<ulid>`.
-- SQLite/D1 has no clean, collision-safe ULID generator (no crypto random,
-- no per-row unique token builder), so identity_id minting MUST happen in JS.
-- Run the companion script instead:
--
--     node worker/scripts/backfill_identity.mjs
--
-- It reads every users.uid and, for each uid NOT already present as a
-- kind='uid' alias, mints a fresh idn_<ulid> and inserts the identities +
-- routes + identity_aliases rows (identical logic to
-- ensureIdentityForUid in worker/src/lib/routing.ts). It is idempotent and
-- safe to re-run.
--
-- WHAT SQL *CAN* SAFELY DO HERE
-- -----------------------------
-- 1) Ensure the schema exists (idempotent — same DDL as identity_routing.sql).
-- 2) Report which uids still need backfilling, so you can verify progress
--    before/after running the JS script.

-- (1) Ensure schema (idempotent).
CREATE TABLE IF NOT EXISTS identities (
  identity_id  TEXT PRIMARY KEY,
  display_name TEXT, email_hash TEXT, phone TEXT,
  verification TEXT, status TEXT NOT NULL DEFAULT 'active', merged_into TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_aliases (
  alias TEXT NOT NULL, identity_id TEXT NOT NULL, kind TEXT NOT NULL,
  valid_from INTEGER NOT NULL, valid_to INTEGER,
  PRIMARY KEY (alias, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_alias_identity ON identity_aliases(identity_id);
CREATE TABLE IF NOT EXISTS routes (
  identity_id     TEXT PRIMARY KEY,
  current_uid     TEXT NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1,
  capabilities    TEXT,
  routing_version INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_uid ON routes(current_uid);

-- (2) Diagnostics — uids still missing a kind='uid' alias (i.e. not yet
--     backfilled). Expect 0 rows after backfill_identity.mjs completes.
--     Uncomment to run standalone:
-- SELECT u.uid
--   FROM users u
--   LEFT JOIN identity_aliases a
--     ON a.alias = u.uid AND a.kind = 'uid'
--  WHERE a.alias IS NULL;
