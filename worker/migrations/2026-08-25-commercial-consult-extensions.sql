-- Phase 2D — mutually confirmed consultation extensions.
-- Additive and dark by default; deployment is a separate owner-authorized step.

CREATE TABLE IF NOT EXISTS commercial_consult_extensions (
  extension_id             TEXT PRIMARY KEY,
  commercial_session_id    TEXT NOT NULL,
  booking_id               TEXT NOT NULL,
  listing_id               TEXT NOT NULL,
  base_order_id            TEXT NOT NULL,
  extension_order_id       TEXT NOT NULL UNIQUE,
  buyer_id                 TEXT NOT NULL,
  creator_id               TEXT NOT NULL,
  base_ends_at             INTEGER NOT NULL,
  extension_ends_at        INTEGER NOT NULL,
  extension_minutes        INTEGER NOT NULL CHECK (extension_minutes > 0),
  rate_per_minute           INTEGER NOT NULL CHECK (rate_per_minute > 0),
  amount                   INTEGER NOT NULL CHECK (amount > 0),
  currency                 TEXT NOT NULL,
  policy_version           TEXT NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN ('proposed','consented','holding','held','applied','declined','expired','failed')),
  creator_consented_at     INTEGER,
  buyer_consented_at       INTEGER,
  held_at                  INTEGER,
  applied_at               INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commercial_extension_booking
  ON commercial_consult_extensions(booking_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_commercial_extension_session
  ON commercial_consult_extensions(commercial_session_id, state);
