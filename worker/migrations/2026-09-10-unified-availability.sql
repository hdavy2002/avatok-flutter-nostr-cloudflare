-- Unified, listing-aware availability authority (DB_META).
-- This migration is additive. Existing calendar tables remain readable and
-- continue to be used by legacy routes until they are moved onto this layer.

CREATE TABLE IF NOT EXISTS availability_schedules (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL,
  listing_id          TEXT,
  timezone            TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT 'shared', -- shared|custom|exclusive
  duration_min       INTEGER NOT NULL DEFAULT 60,
  slot_interval_min  INTEGER NOT NULL DEFAULT 60,
  buffer_min         INTEGER NOT NULL DEFAULT 10,
  min_notice_min     INTEGER NOT NULL DEFAULT 120,
  max_per_day        INTEGER NOT NULL DEFAULT 8,
  horizon_days       INTEGER NOT NULL DEFAULT 60,
  version             INTEGER NOT NULL DEFAULT 1,
  write_token         TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL,
  UNIQUE(creator_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_availability_schedules_creator
  ON availability_schedules(creator_id, listing_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_schedules_creator_default
  ON availability_schedules(creator_id) WHERE listing_id IS NULL;

CREATE TABLE IF NOT EXISTS availability_schedule_rules (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  weekday     INTEGER NOT NULL,
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  FOREIGN KEY(schedule_id) REFERENCES availability_schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_availability_schedule_rules_schedule
  ON availability_schedule_rules(schedule_id, weekday, start_min);

CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL,
  schedule_id TEXT,
  listing_id  TEXT,
  date        TEXT NOT NULL, -- YYYY-MM-DD in the schedule timezone
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  status      TEXT NOT NULL, -- available|unavailable|reserved
  reservation_id TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(schedule_id) REFERENCES availability_schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions_creator_date
  ON availability_exceptions(creator_id, date, listing_id, status);

-- A reservation is the creator-wide occupancy record for a listing. A held
-- reservation is temporary; confirmed/reserved rows are durable. The claim
-- path uses INSERT...SELECT...WHERE NOT EXISTS so overlapping requests race
-- atomically at the D1 primary.
CREATE TABLE IF NOT EXISTS availability_reservations (
  id             TEXT PRIMARY KEY,
  creator_id     TEXT NOT NULL,
  listing_id     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'booking', -- exclusive|booking|hold|block
  status         TEXT NOT NULL DEFAULT 'reserved', -- held|reserved|confirmed|cancelled|expired
  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  title          TEXT,
  source_ref     TEXT,
  hold_expires_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_availability_reservations_creator_time
  ON availability_reservations(creator_id, starts_at, ends_at, status);
CREATE INDEX IF NOT EXISTS idx_availability_reservations_listing_time
  ON availability_reservations(listing_id, starts_at, status);
CREATE INDEX IF NOT EXISTS idx_availability_reservations_hold_expiry
  ON availability_reservations(status, hold_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_reservations_source_ref
  ON availability_reservations(creator_id, source_ref) WHERE source_ref IS NOT NULL;

-- calendar_blocks remains the cross-app occupancy surface. These triggers make
-- every active unified reservation visible to legacy/live claims atomically in
-- the same D1 write, while the reservation row retains listing/lifecycle data.
CREATE TRIGGER IF NOT EXISTS availability_reservation_block_insert
AFTER INSERT ON availability_reservations
WHEN NEW.status IN ('held','reserved','confirmed')
BEGIN
  INSERT OR IGNORE INTO calendar_blocks
    (id,user_id,source_app,source_ref,starts_at,ends_at,title,status,created_at)
  VALUES ('availability:' || NEW.id,NEW.creator_id,'availability',NEW.id,NEW.starts_at,NEW.ends_at,NEW.title,'busy',NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS availability_reservation_block_update
AFTER UPDATE OF status,starts_at,ends_at,title,updated_at ON availability_reservations
BEGIN
  UPDATE calendar_blocks SET starts_at=NEW.starts_at, ends_at=NEW.ends_at, title=NEW.title,
    status=CASE WHEN NEW.status IN ('held','reserved','confirmed') THEN 'busy' ELSE 'cancelled' END
    WHERE source_app='availability' AND source_ref=NEW.id;
END;

-- Versioned idempotency/cancellation support for lifecycle consumers.
CREATE TABLE IF NOT EXISTS availability_reservation_events (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  operation      TEXT NOT NULL,
  idempotency_key TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE(reservation_id, operation, idempotency_key)
);
