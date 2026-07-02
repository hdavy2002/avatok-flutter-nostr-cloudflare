-- Phase 3 (v5.2 §10.2) — AvaCalendar. Tables in DB_META (avatok-meta). Creators
-- publish bookable slots; users book (wallet debit if paid). Each booking writes a
-- MIRRORED event row for both host and attendee. Cron sends 30m + 1h reminders.

-- Bookable slots a host offers.
CREATE TABLE IF NOT EXISTS calendar_slots (
  id           TEXT PRIMARY KEY,
  host_uid    TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  start_at     INTEGER NOT NULL,      -- ms epoch
  end_at       INTEGER NOT NULL,
  price_coins  INTEGER NOT NULL DEFAULT 0, -- 0 = free
  capacity     INTEGER NOT NULL DEFAULT 1,
  booked_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open', -- 'open'|'closed'|'cancelled'
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slots_host ON calendar_slots(host_uid, start_at);
CREATE INDEX IF NOT EXISTS idx_slots_open ON calendar_slots(status, start_at);

-- Confirmed bookings, mirrored: one row per party (owner_uid = whose calendar).
CREATE TABLE IF NOT EXISTS calendar_events (
  id            TEXT PRIMARY KEY,     -- uuid (distinct per party row)
  booking_id    TEXT NOT NULL,        -- shared id linking the host+attendee rows
  slot_id       TEXT NOT NULL,
  owner_uid    TEXT NOT NULL,        -- whose calendar this row belongs to
  role          TEXT NOT NULL,        -- 'host'|'attendee'
  host_uid     TEXT NOT NULL,
  attendee_uid TEXT NOT NULL,
  title         TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  price_coins   INTEGER NOT NULL DEFAULT 0,
  paid          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed'|'cancelled'
  source        TEXT NOT NULL DEFAULT 'user',      -- 'user'|'agent' (§29 agent calendar)
  reminded_60   INTEGER NOT NULL DEFAULT 0,
  reminded_30   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cev_owner ON calendar_events(owner_uid, start_at);
CREATE INDEX IF NOT EXISTS idx_cev_remind ON calendar_events(status, start_at);
CREATE INDEX IF NOT EXISTS idx_cev_booking ON calendar_events(booking_id);
