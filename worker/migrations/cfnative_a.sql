-- Re-key batch A — rename per-user uid columns to uid (Clerk user id) on the
-- tables the directory/identity routes use. The directory itself moved to the
-- new `users` table (cfnative.sql); these are the remaining per-user surfaces.
-- Clean reinstall: no data migration needed (2 test phones). Run once.
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/cfnative_a.sql

ALTER TABLE user_vault RENAME COLUMN uid TO uid;
ALTER TABLE communities RENAME COLUMN owner_uid TO owner_uid;
ALTER TABLE community_members RENAME COLUMN uid TO uid;
