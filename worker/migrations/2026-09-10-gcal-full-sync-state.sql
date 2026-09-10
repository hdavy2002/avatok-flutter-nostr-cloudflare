-- ALTER-only companion for the additive gcal reliability tables.
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS; apply with
-- scripts/d1_apply_alters.py so existing deployments can be upgraded
-- idempotently.
ALTER TABLE gcal_calendars ADD COLUMN last_full_sync_at INTEGER;
