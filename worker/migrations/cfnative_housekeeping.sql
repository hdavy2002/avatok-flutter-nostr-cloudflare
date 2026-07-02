-- Housekeeping (Nostr deprecated) — drop the dead legacy uid tables on
-- avatok-meta now that every route is re-keyed to Clerk uid. Search moved to a
-- LIKE over `users`, so the profiles FTS mirror is retired too.
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/cfnative_housekeeping.sql

DROP TRIGGER IF EXISTS profiles_ai;
DROP TRIGGER IF EXISTS profiles_ad;
DROP TRIGGER IF EXISTS profiles_au;
DROP TABLE IF EXISTS profiles_fts;
DROP TABLE IF EXISTS profiles;            -- replaced by `users`
DROP TABLE IF EXISTS clerk_account_link;    -- uid IS the account now
DROP TABLE IF EXISTS contact_phone_index; -- replaced by users.phone_hash
DROP TABLE IF EXISTS push_tokens;         -- replaced by push_tokens_v2
DROP TABLE IF EXISTS user_blocks;         -- unused (consolidated on `blocks`)
DROP TABLE IF EXISTS user_mutes;          -- unused (consolidated on `mutes`)

-- Strikes still in use (moderation consumer) — re-key its bare uid column.
ALTER TABLE account_strikes RENAME COLUMN uid TO uid;
