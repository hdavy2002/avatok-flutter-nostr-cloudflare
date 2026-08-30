-- [CARD-SLOTS-1] Group the copies a repeating show produces.
--
-- OWNER DECISION 2026-08-29: one listing is one event. A weekly show is N listings, not
-- one listing with N sessions. The rejected alternative — a `listing_sessions` table with
-- claimBlock moved onto the session — is the honest model for recurrence and the only one
-- that can express per-slot seats, and it is a rewrite of the booking grain touching
-- bookings, entitlements, settlement, calendar and every card. Not built speculatively.
-- See Specs/SPEC-2026-08-29-PAID-SESSIONS-FIX-AND-GUEST-PAY.md [CARD-SLOTS-1].
--
-- So `series_id` is a LABEL, not a new grain. Every row stays a standalone bookable event
-- with its own calendar block, its own seats, its own order and its own settlement. The
-- column exists so a creator can see and cancel "the Friday show" as a set, and so a card
-- can one day say "weekly" without lying.
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.
--
-- Nullable with no backfill: every existing listing is a standalone event, which is
-- exactly what NULL means here.

ALTER TABLE listings ADD COLUMN series_id TEXT;

-- Scoped by creator because a series is always one creator's, and this index answers the
-- only two questions asked of it: "show me this series" and "cancel this series".
CREATE INDEX IF NOT EXISTS idx_listings_series
  ON listings(creator_id, series_id, starts_at);
