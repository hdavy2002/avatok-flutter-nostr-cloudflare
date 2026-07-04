-- 2026-07-04: server-persisted poll votes (DB_META / avatok-meta).
-- Poll DEFINITION (question + options) lives in the chat message envelope
-- (t:'poll', {id,q,options,multi}) — durable via the InboxDO log + R2 archive.
-- Only the VOTES are stored here so tallies survive reinstall / phone transfer
-- and ride the existing backup (avatok-meta is in the standard D1 backup set).
--
-- One row per (poll_id, voter_uid, option_idx). A single-choice poll keeps one
-- row per voter (the client replaces on change); a multi-select poll keeps one
-- row per chosen option. `conv` is stored so GET /api/poll/state can batch every
-- poll in a conversation in ONE query, and so membership can be re-checked.
-- Aggregate counts + "who voted" are computed at read time (no denormalised
-- counters to drift). Toggling a vote off deletes the row.
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    TEXT    NOT NULL,          -- the poll's uuid (message envelope `id`)
  conv       TEXT    NOT NULL,          -- conversation id (server conv id) — for batch reads + membership
  option_idx INTEGER NOT NULL,          -- 0-based option index into the poll's `options`
  voter_uid  TEXT    NOT NULL,          -- who voted
  created_at INTEGER NOT NULL,          -- epoch ms of the (latest) vote
  PRIMARY KEY (poll_id, voter_uid, option_idx)
);
-- Batch fetch every poll's tally for a conversation on thread open.
CREATE INDEX IF NOT EXISTS idx_poll_votes_conv ON poll_votes(conv);
-- Fast per-poll aggregation.
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
