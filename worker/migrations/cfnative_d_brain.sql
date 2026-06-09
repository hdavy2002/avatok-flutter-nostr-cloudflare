-- Re-key batch D (avatok-brain) — AvaBrain memory identity npub -> uid.
-- Clean reinstall, run once.
-- Apply: wrangler d1 execute avatok-brain --remote --file=migrations/cfnative_d_brain.sql

ALTER TABLE brain_entities RENAME COLUMN npub TO uid;
ALTER TABLE brain_relationships RENAME COLUMN npub TO uid;
ALTER TABLE brain_facts RENAME COLUMN npub TO uid;
ALTER TABLE brain_daily_summaries RENAME COLUMN npub TO uid;
ALTER TABLE brain_events RENAME COLUMN npub TO uid;
ALTER TABLE brain_consent RENAME COLUMN npub TO uid;
