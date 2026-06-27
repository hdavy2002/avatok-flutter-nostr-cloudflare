-- AvaTOK Number — free-tier generation (owner request 2026-06-27).
-- Generating an AvaTOK number is now FREE for everyone: every user gets ONE
-- number (claimed during onboarding). Only PAID users (tier >= 1) can
-- regenerate / change it afterwards. We persist whether a free user has spent
-- their single free generation so that releasing and re-picking can't hand a
-- free account a second number.
-- Apply to DB_META (avatok-meta):
--   wrangler d1 execute avatok-meta --remote --file=migrations/avatok_number_free_tier.sql
--   (or via the D1 REST /query endpoint).
ALTER TABLE users ADD COLUMN free_number_used INTEGER NOT NULL DEFAULT 0;
