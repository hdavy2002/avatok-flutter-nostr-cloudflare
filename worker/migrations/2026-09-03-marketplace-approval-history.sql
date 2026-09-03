-- Marketplace approval history and publish-gate support.
--
-- Adds an immutable audit trail for listing/poster moderation decisions, including
-- the actor, state transition, and mandatory rejection reason. The worker routes
-- write to this table whenever a listing moves through approval or publish.

CREATE TABLE IF NOT EXISTS listing_approval_history (
  id             TEXT PRIMARY KEY,
  listing_id     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  action         TEXT NOT NULL,
  previous_status TEXT,
  next_status    TEXT,
  reason         TEXT,
  poster_status  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_approval_history_listing_time
  ON listing_approval_history(listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_approval_history_actor_time
  ON listing_approval_history(actor_id, created_at DESC);
