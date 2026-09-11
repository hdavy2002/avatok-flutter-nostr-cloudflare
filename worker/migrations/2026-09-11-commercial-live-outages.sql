-- [LIVE-GRACE-1] CREATE ONLY -- do not apply automatically. Keep separate from
-- the ALTER file in this WP (CLAUDE.md pitfall #6: `d1_apply_alters.py` applies
-- only ALTER ADD COLUMN lines and silently skips a CREATE TABLE sitting in the
-- same file). Apply with
-- `scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<f>.sql`
-- (path relative to worker/) once the coordinator authorizes it.
--
-- One row per host outage window during a live event
-- (RULEBOOK-PAID-SESSIONS.md v2 §4 L4/L5): `started_at` is the host's
-- `participant_left` timestamp, `ended_at` is the host's rejoin timestamp, or
-- NULL while the outage is still open (the `live_grace` DO alarm still
-- pending). commercial_settlement.ts subtracts every outage's overlap with a
-- viewer's connected interval from that viewer's `watched_eligible_ms` when
-- the event ends with `end_outcome='host_no_return'`.

CREATE TABLE IF NOT EXISTS commercial_live_outages (
  outage_id              TEXT PRIMARY KEY,
  commercial_session_id  TEXT NOT NULL,
  started_at             INTEGER NOT NULL,
  ended_at               INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_live_outage_session
  ON commercial_live_outages(commercial_session_id, started_at);
