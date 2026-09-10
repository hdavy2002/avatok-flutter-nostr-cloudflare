-- Google Calendar reliability and multi-calendar state.
-- Additive: the legacy gcal_accounts row remains the OAuth/token anchor and
-- existing calendar_blocks rows remain the availability projection.

CREATE TABLE IF NOT EXISTS gcal_calendars (
  user_id             TEXT NOT NULL,
  calendar_id         TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT 'Google Calendar',
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  access_role         TEXT,
  primary_calendar    INTEGER NOT NULL DEFAULT 0,
  selected            INTEGER NOT NULL DEFAULT 0,
  destination         INTEGER NOT NULL DEFAULT 0,
  sync_token          TEXT,
  channel_id          TEXT,
  resource_id         TEXT,
  channel_token       TEXT,
  channel_expires_at  INTEGER,
  last_sync_at        INTEGER,
  last_success_at     INTEGER,
  last_full_sync_at   INTEGER,
  last_error          TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_id)
);
CREATE INDEX IF NOT EXISTS idx_gcal_calendars_user_selected
  ON gcal_calendars(user_id, selected, calendar_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_calendars_destination
  ON gcal_calendars(user_id) WHERE destination=1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_calendars_channel
  ON gcal_calendars(channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gcal_export_events (
  user_id       TEXT NOT NULL,
  block_id      TEXT NOT NULL,
  calendar_id   TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'active', -- active|deleted|error
  last_error    TEXT,
  snapshot_hash TEXT,
  snapshot_title TEXT,
  snapshot_starts_at INTEGER,
  snapshot_ends_at INTEGER,
  snapshot_status TEXT,
  next_retry_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, block_id, calendar_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_export_event_id
  ON gcal_export_events(user_id, calendar_id, event_id);
