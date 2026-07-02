-- Re-key batch B — media/library identity uid -> uid (Clerk user id).
-- Target DB: avatok-media-meta (binding DB_MEDIA). Clean reinstall, run once.
-- Apply: wrangler d1 execute avatok-media-meta --remote --file=migrations/cfnative_b.sql

ALTER TABLE user_media RENAME COLUMN uid TO uid;
ALTER TABLE library_folders RENAME COLUMN uid TO uid;
