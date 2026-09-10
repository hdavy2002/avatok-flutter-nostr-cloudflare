-- Applied through the idempotent ALTER helper because SQLite has no
-- `ADD COLUMN IF NOT EXISTS` syntax.
ALTER TABLE gcal_accounts ADD COLUMN last_error TEXT;
