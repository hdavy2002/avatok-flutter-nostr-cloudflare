-- [AVA-TOGGLE-DM-1] WS-17 — per-thread Ava toggle for 1:1 conversations.
--
-- DB: DB_META (env.DB_META) — same database as ava_group_state
-- (worker/migrations/ava_group_companion.sql), whose design this deliberately
-- copies rather than redesigns.
--
-- ONE ROW PER (conv, uid), NOT ONE ROW PER CONV. This is the single real
-- difference from ava_group_state, and it exists because a DM has no owner and
-- no admin: there is nobody with the standing to decide for the other person.
-- Each participant stores their OWN preference; the pair's EFFECTIVE mode is
-- the MOST RESTRICTIVE of the two (off < assistant < companion) — see
-- effectiveDmMode() in worker/src/lib/ava_group_policy.ts.
--
-- Why most-restrictive wins: Ava reads BOTH sides of a 1:1 conversation. If A
-- switched Ava on for the thread, A would be enrolling B's messages into model
-- observation without B's consent. So:
--   * turning Ava OFF is unilateral and immediate — either participant can do
--     it and the thread is off for both;
--   * turning Ava ON is a request that only takes effect while the peer has
--     not turned it off;
--   * a participant with no row yet is treated as the platform default
--     (remote-config `avaDmDefaultOn`), so the owner's intended "Ava on by
--     default in DMs" is a config flip, never a hardcoded constant and never a
--     backfill of this table.
-- Neither participant can ever read or write the other's row.
--
-- mode mirrors GroupAvaMode exactly so one policy vocabulary covers both
-- surfaces: 'off' (no observation, no memory, no output), 'assistant' (Ava
-- responds only when directly addressed — @ava / the composer chip), and
-- 'companion' (Ava may also observe and contribute unprompted, subject to the
-- WS-18 ambient gates that do not exist yet).
--
-- policy_version: reserved, always 1 in v1, unread — same convention as
-- ava_group_state, so a later policy schema bump needs no ALTER.
--
-- SHIPS DARK. Nothing reads this table while remote-config
-- `avaDmToggleEnabled` is false (currently false in production): the read
-- helper short-circuits to 'off' BEFORE any D1 query, and the PUT route
-- refuses with 403 feature_disabled, so no row can even be created.
CREATE TABLE IF NOT EXISTS ava_dm_state (
  conv           TEXT    NOT NULL,
  uid            TEXT    NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'off',  -- 'off'|'assistant'|'companion'
  policy_version INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (conv, uid)
);

-- effectiveDmMode() reads both participants' rows for one conv in a single
-- query; this index keeps that lookup index-only.
CREATE INDEX IF NOT EXISTS idx_ava_dm_state_conv ON ava_dm_state(conv);
