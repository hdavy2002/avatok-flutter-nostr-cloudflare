-- ALTER-only companion for durable Google export sweep state.
-- Apply with scripts/d1_apply_alters.py on databases that already have
-- gcal_export_events from 2026-09-10-gcal-reliability.sql.
ALTER TABLE gcal_export_events ADD COLUMN snapshot_hash TEXT;
ALTER TABLE gcal_export_events ADD COLUMN snapshot_title TEXT;
ALTER TABLE gcal_export_events ADD COLUMN snapshot_starts_at INTEGER;
ALTER TABLE gcal_export_events ADD COLUMN snapshot_ends_at INTEGER;
ALTER TABLE gcal_export_events ADD COLUMN snapshot_status TEXT;
ALTER TABLE gcal_export_events ADD COLUMN next_retry_at INTEGER;
ALTER TABLE gcal_export_events ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
