-- Phase 7 — AvaLive + AvaConsult delivery, escrow settlement, refund engine.
-- Applies to DB_META (avatok-meta). Additive only.

-- Orders gain the full Phase-7 lifecycle (table created in listings.sql).
-- status: held|free|settled|refunded_full|refunded_partial|cancelled
-- (legacy 'released'/'refunded' rows keep working — engine only acts on 'held').
ALTER TABLE orders ADD COLUMN kind TEXT;                      -- live_event|consult
ALTER TABLE orders ADD COLUMN fee_pct INTEGER DEFAULT 20;
ALTER TABLE orders ADD COLUMN escrow_account TEXT;            -- 'escrow:<orderId>'
ALTER TABLE orders ADD COLUMN booking_id TEXT;
ALTER TABLE orders ADD COLUMN cancelled_by TEXT;              -- buyer|creator
ALTER TABLE orders ADD COLUMN cancelled_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_booking ON orders(booking_id);

-- Host marks a consult complete (refund rule R3 trigger).
ALTER TABLE bookings ADD COLUMN host_marked_complete INTEGER DEFAULT 0;

-- Attendance = the refund engine's evidence. session_id = listing id (live
-- events) or booking id (consults). order_id NULL for the host.
CREATE TABLE IF NOT EXISTS session_attendance (
  session_id TEXT NOT NULL,
  order_id   TEXT,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,            -- host|attendee
  joined_at  INTEGER NOT NULL,
  left_at    INTEGER,
  PRIMARY KEY (session_id, user_id, joined_at)
);
CREATE INDEX IF NOT EXISTS idx_att_session ON session_attendance(session_id, role);

-- One row per live event delivery (Stream Live lifecycle + R7 downtime evidence).
CREATE TABLE IF NOT EXISTS live_sessions (
  listing_id        TEXT PRIMARY KEY,
  live_input        TEXT,
  whip_url          TEXT,
  whep_url          TEXT,
  hls_url           TEXT,
  state             TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|live|ended|settled
  started_at        INTEGER,
  ended_at          INTEGER,
  downtime_ms       INTEGER NOT NULL DEFAULT 0,        -- accumulated contiguous-gap downtime
  last_disconnect_at INTEGER,                          -- open gap start (NULL when connected)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Data-driven rule thresholds (tunable without redeploys).
CREATE TABLE IF NOT EXISTS refund_rules (
  id         TEXT PRIMARY KEY,         -- R1..R7
  params     TEXT NOT NULL,            -- JSON
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO refund_rules (id, params, enabled, updated_at) VALUES
  ('R1', '{"wait_min":20}',                      1, strftime('%s','now')*1000),
  ('R2', '{"wait_min":20,"presence_pct":75}',    1, strftime('%s','now')*1000),
  ('R3', '{"min_pct":50}',                       1, strftime('%s','now')*1000),
  ('R4', '{"hours":24}',                         1, strftime('%s','now')*1000),
  ('R5', '{"refund_pct":50}',                    1, strftime('%s','now')*1000),
  ('R6', '{}',                                   1, strftime('%s','now')*1000),
  ('R7', '{"downtime_min":5}',                   1, strftime('%s','now')*1000);

-- Idempotent settlement bookkeeping: one marker per (session, phase) stops the
-- sweep re-enqueueing; one row per money action is the audit of what fired.
CREATE TABLE IF NOT EXISTS settlement_log (
  id         TEXT PRIMARY KEY,          -- '<sid>:<phase>' markers; '<sid>:<rule>:<orderId>' actions
  session_id TEXT NOT NULL,
  order_id   TEXT,
  rule       TEXT NOT NULL,
  action     TEXT NOT NULL,             -- refund|release|strike|cancel_event|marker|noop
  amount     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_session ON settlement_log(session_id);
