-- P0 data foundation — canonical Identity + immutable aliases + Routing.
-- Design: Specs/ROUTING-IDENTITY-PRESENCE-ARCH.md (v4) §5.1 (Identity),
--         §5.3 (Routing), §12 (backfill constraint).
-- Target DB: avatok-meta (binding DB_META). Idempotent — safe to re-run.
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/identity_routing.sql
--
-- These tables are ALSO created lazily at runtime (worker/src/lib/routing.ts,
-- ensureIdentityTables) to match the codebase's lazy-DDL pattern (see
-- keybackup.ts). This file exists so the schema can be provisioned/reviewed
-- explicitly and used by the backfill.

-- §5.1 Identity — "who is this user?". Owns the durable opaque identity_id,
-- name, phone, email(hash), verification, status. NEVER knows sockets, inboxes,
-- or regions. `identity_id` is opaque (idn_<ulid>) and NEVER reused; the current
-- Clerk uid lives as an ALIAS (kind='uid'), NOT as the identity_id, so a future
-- uid re-key bumps the alias/route generation without ever changing identity_id.
-- `merged_into` points a merged identity at the surviving one (status='merged').
CREATE TABLE IF NOT EXISTS identities (
  identity_id  TEXT PRIMARY KEY,                 -- durable opaque id (idn_<ulid>), never reused
  display_name TEXT,
  email_hash   TEXT,
  phone        TEXT,
  verification TEXT,
  status       TEXT NOT NULL DEFAULT 'active',   -- active|merged|disabled
  merged_into  TEXT,                             -- when status='merged' → surviving identity_id
  version      INTEGER NOT NULL DEFAULT 1,       -- identity_version (§9 version stamp)
  updated_at   INTEGER NOT NULL
);

-- §5.1 Immutable, append-only aliases (rows are NEVER edited/deleted) so that
-- historical routing stays explainable: every uid/npub/tel/number a user ever
-- had maps back to its identity_id, with a validity window. Retiring an alias
-- means setting valid_to on the current row and inserting a fresh row — never
-- mutating in place. `valid_to IS NULL` = the currently-active alias.
-- kind ∈ npub | uid | tel | number.
CREATE TABLE IF NOT EXISTS identity_aliases (
  alias       TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- npub|uid|tel|number
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,                           -- NULL = current
  PRIMARY KEY (alias, valid_from)                -- append-only: (alias, valid_from) is unique
);

-- Reverse lookup: all aliases for a given identity (merge/audit/backfill).
CREATE INDEX IF NOT EXISTS idx_alias_identity ON identity_aliases(identity_id);

-- §5.3 Routing — "who currently represents this identity?". TINY. Resolves
-- identity_id → current_uid + capabilities + generation. `generation` is bumped
-- on ANY re-key (the uid changed underneath the identity). `capabilities` is a
-- JSON blob ({video, sfu, receipts, ...}).
--
-- DELIBERATELY NO region / inbox / transport column here. Transport owns
-- geography and sharding (§5.7), so adding Singapore/Mumbai/Tokyo/Frankfurt
-- later NEVER touches Routing. Do not add one.
CREATE TABLE IF NOT EXISTS routes (
  identity_id     TEXT PRIMARY KEY,
  current_uid     TEXT NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1,    -- bumped on any re-key
  capabilities    TEXT,                          -- json: {video, sfu, receipts, ...}
  routing_version INTEGER NOT NULL DEFAULT 1,    -- routing_version (§9 version stamp)
  updated_at      INTEGER NOT NULL
);

-- One uid maps to exactly one identity's route (reverse: uid → identity).
CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_uid ON routes(current_uid);
