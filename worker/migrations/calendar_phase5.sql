-- Phase 5 — AvaCalendar + AvaBooking (PHASE-05.md). DB_META (avatok-meta).
--
-- Part A: npub → Clerk uid migration. The pre-pivot tables are keyed by
-- host_npub/owner_npub/attendee_npub; since the Cloudflare-native pivot the
-- routes already WRITE Clerk uids into those columns, so the backfill is a
-- straight copy. New *_uid columns become the canonical keys; the *_npub
-- columns stay (read-only legacy) until a later cleanup migration drops them.
--
-- Part B: the conflict engine + booking layer. NOTE: the spec sketch says
-- "UTC epoch s" — we standardise on **ms epoch** instead, matching every
-- existing calendar table and Date.now() call-site (mixed units across joined
-- tables is how off-by-1000 bugs happen).

-- ---------------------------------------------------------------------------
-- A. uid columns + backfill
-- ---------------------------------------------------------------------------
ALTER TABLE calendar_slots  ADD COLUMN host_uid TEXT;
UPDATE calendar_slots SET host_uid = host_npub WHERE host_uid IS NULL;
CREATE INDEX IF NOT EXISTS idx_slots_host_uid ON calendar_slots(host_uid, start_at);

ALTER TABLE calendar_events ADD COLUMN owner_uid TEXT;
ALTER TABLE calendar_events ADD COLUMN host_uid TEXT;
ALTER TABLE calendar_events ADD COLUMN attendee_uid TEXT;
UPDATE calendar_events SET owner_uid = owner_npub, host_uid = host_npub, attendee_uid = attendee_npub
 WHERE owner_uid IS NULL;
CREATE INDEX IF NOT EXISTS idx_cev_owner_uid ON calendar_events(owner_uid, start_at);

-- Reminder ladder (A5): T-24h email / T-60m email+push / T-10m push.
-- reminded_60 is reused for the T-60 tier; reminded_30 is retired (kept, unused).
ALTER TABLE calendar_events ADD COLUMN reminded_24 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendar_events ADD COLUMN reminded_10 INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- B. Cross-app occupancy — the heart of Phase 5. EVERY time-consuming thing
-- (slot offered, booking taken, AvaLive event, gcal busy import, manual block)
-- claims a row here; every scheduling write path overlap-checks it first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_blocks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,           -- the person whose time is blocked (Clerk uid)
  source_app    TEXT NOT NULL,           -- avacalendar|avaconsult|avalive|gcal|manual
  source_ref    TEXT,                    -- slot id / booking id / gcal event id
  starts_at     INTEGER NOT NULL,        -- ms epoch UTC
  ends_at       INTEGER NOT NULL,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'busy',  -- busy|tentative|cancelled
  gcal_event_id TEXT,                    -- our exported gcal event (outbound sync)
  created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blocks_user_time ON calendar_blocks(user_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_blocks_ref ON calendar_blocks(source_app, source_ref);

-- Canonical booking row (calendar_events keeps the per-party mirror for the
-- existing event feed; THIS row owns money/reschedule/reminder state).
CREATE TABLE IF NOT EXISTS bookings (
  id               TEXT PRIMARY KEY,
  creator_id       TEXT NOT NULL,
  buyer_id         TEXT NOT NULL,
  listing_id       TEXT NOT NULL,        -- slot id today; listing id from Phase 6
  kind             TEXT NOT NULL,        -- consult_1to1|consult_group|live_event
  starts_at        INTEGER, ends_at INTEGER,
  price            INTEGER,              -- coins
  order_id         TEXT,                 -- escrow ref (Phase 2/7)
  status           TEXT NOT NULL,        -- confirmed|completed|cancelled_user|cancelled_creator|no_show_user|no_show_creator|refunded
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  reminder24_sent  INTEGER NOT NULL DEFAULT 0,
  reminder_sent    INTEGER NOT NULL DEFAULT 0,   -- the T-60 tier
  reminder10_sent  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bookings_creator_time ON bookings(creator_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_buyer_time  ON bookings(buyer_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_remind ON bookings(status, starts_at);

-- Creator's offered hours (consults). tz is an IANA zone; expansion is DST-safe.
CREATE TABLE IF NOT EXISTS availability_rules (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  weekday   INTEGER NOT NULL,            -- 0=Sun … 6=Sat (in tz)
  start_min INTEGER NOT NULL,            -- minutes from local midnight
  end_min   INTEGER NOT NULL,
  tz        TEXT NOT NULL,
  slot_min  INTEGER NOT NULL DEFAULT 60
);
CREATE INDEX IF NOT EXISTS idx_avail_user ON availability_rules(user_id, weekday);

-- A3. Booking policies + vacation mode (server-side enforcement, UI greying is cosmetic).
CREATE TABLE IF NOT EXISTS booking_policies (
  user_id        TEXT PRIMARY KEY,
  buffer_min     INTEGER NOT NULL DEFAULT 10,
  min_notice_min INTEGER NOT NULL DEFAULT 120,
  max_per_day    INTEGER NOT NULL DEFAULT 8,
  vacation_until INTEGER                 -- ms epoch; NULL = active
);

-- A4. Reschedule flow (max 2 per booking; pending expires at original start).
CREATE TABLE IF NOT EXISTS reschedule_requests (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  proposed_by TEXT NOT NULL,             -- uid
  new_start   INTEGER NOT NULL, new_end INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|declined|expired
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resched_booking ON reschedule_requests(booking_id, status);

-- Google Calendar per-account OAuth + sync state. refresh_token_enc is
-- AES-GCM-encrypted with the GCAL_TOKEN_KEY worker secret (never plaintext).
CREATE TABLE IF NOT EXISTS gcal_accounts (
  user_id           TEXT PRIMARY KEY,
  email             TEXT,
  refresh_token_enc TEXT NOT NULL,
  access_token      TEXT,                -- short-lived cache
  access_expires_at INTEGER,
  sync_token        TEXT,                -- incremental events.list token
  channel_id        TEXT, resource_id TEXT, channel_expires_at INTEGER,
  connected_at      INTEGER, last_sync_at INTEGER
);
