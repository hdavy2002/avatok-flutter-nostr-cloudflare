-- AvaTOK Number feature (Specs/AVATOK-NUMBER-FEATURE-SPEC.md) — 2026-06-26.
-- A purchasable in-network virtual number that represents a user without exposing
-- their real phone. Pure-virtual, country-standard format, NON-PSTN. Maps to the
-- Clerk uid. Bundled free on paid plans (tier >= 1). Apply to DB_META (avatok-meta).
-- Apply: wrangler d1 execute avatok-meta --remote --file=migrations/avatok_numbers.sql
--   (or via the D1 REST /query endpoint).
--
-- Handles are retired site-wide; the number / real phone (if public) / email are
-- the only network search keys. Names come from first_name/last_name (added here).

-- The virtual-number registry. number = canonical E.164 digits (no '+'), e.g.
-- '233245550148'. One ACTIVE number per uid (enforced by the partial unique index).
CREATE TABLE IF NOT EXISTS avatok_numbers (
  number      TEXT PRIMARY KEY,           -- canonical E.164 digits, no '+'
  country     TEXT NOT NULL,              -- ISO-3166 alpha-2, e.g. 'GH'
  uid         TEXT,                       -- owner Clerk uid; NULL once released
  display     TEXT NOT NULL,              -- pretty form, e.g. '+233 24 555 0148'
  status      TEXT NOT NULL DEFAULT 'active', -- active | dormant | released
  claimed_at  INTEGER,
  released_at INTEGER,
  updated_at  INTEGER NOT NULL
);
-- One active number per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_avatok_numbers_active_uid
  ON avatok_numbers(uid) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_avatok_numbers_country ON avatok_numbers(country);
CREATE INDEX IF NOT EXISTS idx_avatok_numbers_status ON avatok_numbers(status);

-- Short-lived holds during the pick -> confirm -> assign flow so two users can
-- never claim the same number concurrently. expires_at is an epoch-ms TTL.
CREATE TABLE IF NOT EXISTS number_reservations (
  number     TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_number_reservations_expires ON number_reservations(expires_at);

-- Directory columns added to the existing users table (DB_META.users).
-- Handles are retired; names + the virtual number power the contact card / search.
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN avatok_number TEXT;        -- active virtual number (E.164 digits); replaces real phone as identity
ALTER TABLE users ADD COLUMN avatok_number_display TEXT;-- pretty form for the card
ALTER TABLE users ADD COLUMN phone_discoverable INTEGER NOT NULL DEFAULT 0; -- real phone is private by default
ALTER TABLE users ADD COLUMN email_discoverable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN who_can_add TEXT NOT NULL DEFAULT 'everyone'; -- everyone | number_only | nobody
ALTER TABLE users ADD COLUMN share_token TEXT;          -- stable, non-expiring QR add token

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_avatok_number ON users(avatok_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_share_token ON users(share_token);
