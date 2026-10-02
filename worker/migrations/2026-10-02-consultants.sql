-- [AUMFE-CONSULT-FOUNDATION-1 2026-10-02] Real Consultants (DB_META). CREATE-only file: apply with
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-02-consultants.sql
-- (NOT d1_apply_alters.py — that one skips CREATE TABLE). Spec: Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md
CREATE TABLE IF NOT EXISTS consultants (
  id TEXT PRIMARY KEY,                       -- 'cn_' + 16 hex
  uid TEXT UNIQUE,                           -- the signed-in user who runs this desk; NULL until admin attaches one
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  disciplines_json TEXT NOT NULL,            -- ["palmistry","face_reading"]
  photo_url TEXT NOT NULL,
  photo_hero_url TEXT,
  tagline TEXT,
  bio TEXT,
  lineage TEXT,
  city TEXT,
  languages_json TEXT NOT NULL DEFAULT '[]',
  years INTEGER,
  rate_rupees INTEGER NOT NULL DEFAULT 500 CHECK (rate_rupees > 0),
  rate_floor INTEGER NOT NULL DEFAULT 300,
  rate_ceil INTEGER NOT NULL DEFAULT 5000,
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused')),
  strikes INTEGER NOT NULL DEFAULT 0,
  is_seed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consultant_availability (
  consultant_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday, IST
  start_hm TEXT NOT NULL,                                     -- 'HH:MM' IST
  end_hm TEXT NOT NULL,
  PRIMARY KEY (consultant_id, weekday, start_hm)
);

CREATE TABLE IF NOT EXISTS consultant_exceptions (
  consultant_id TEXT NOT NULL,
  date TEXT NOT NULL,                                         -- 'YYYY-MM-DD' IST
  off INTEGER NOT NULL DEFAULT 1,
  start_hm TEXT,
  end_hm TEXT,
  PRIMARY KEY (consultant_id, date, off, start_hm)
);

CREATE TABLE IF NOT EXISTS consult_bookings (
  id TEXT PRIMARY KEY,                       -- 'cb_' + 20 hex
  ref TEXT UNIQUE NOT NULL,                  -- 'AFC-' + 8 upper hex (shown to people)
  consultant_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  request_key TEXT NOT NULL,
  discipline TEXT NOT NULL,
  slot_start_ms INTEGER NOT NULL,
  slot_end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','awaiting_review','confirmed','in_call','completed','no_show_consultant','no_show_customer','cancelled','expired')),
  rate_rupees INTEGER NOT NULL,
  gst_rupees INTEGER NOT NULL,
  total_rupees INTEGER NOT NULL CHECK (total_rupees > 0),
  fee_rupees INTEGER NOT NULL,
  payout_rupees INTEGER NOT NULL,
  intake_json TEXT NOT NULL,
  questions_json TEXT NOT NULL DEFAULT '[]',
  prep_status TEXT NOT NULL DEFAULT 'pending' CHECK (prep_status IN ('pending','running','ready','partial','failed')),
  prep_attempts INTEGER NOT NULL DEFAULT 0,
  prep_error TEXT,
  terms_accepted_at INTEGER NOT NULL,
  refund_policy_accepted_at INTEGER NOT NULL,
  -- payment: mirrors shop_orders so the same UPI rail can match it
  pay_method TEXT NOT NULL DEFAULT 'upi' CHECK (pay_method IN ('upi','wallet')),
  receiving_account_key TEXT,
  amount_paise INTEGER,
  rounding_discount_paise INTEGER NOT NULL DEFAULT 0,
  payer_reference TEXT,
  reference_revision INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  utr TEXT,
  payer_vpa TEXT,
  matched_message_hash TEXT,
  confirm_source TEXT,
  paid_claimed_at INTEGER,
  reviewed_by TEXT,
  review_note TEXT,
  reviewed_at INTEGER,
  review_alerted_at INTEGER,
  receipt_no TEXT,
  confirmed_at INTEGER,
  expires_at INTEGER,
  -- desk + call
  consultant_notes TEXT NOT NULL DEFAULT '',
  call_started_at INTEGER,
  call_ended_at INTEGER,
  customer_seconds INTEGER NOT NULL DEFAULT 0,
  consultant_seconds INTEGER NOT NULL DEFAULT 0,
  consultant_joined_at INTEGER,
  customer_joined_at INTEGER,
  -- settle + notify
  settled_at INTEGER,
  settle_outcome TEXT,
  refund_utr TEXT,
  refunded_at INTEGER,
  confirm_sent_at INTEGER,
  reminded_day_at INTEGER,
  reminded_15_at INTEGER,
  thanks_sent_at INTEGER,
  review_token TEXT UNIQUE,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (uid, request_key)
);
-- One live booking per consultant per start time (held/paid/done). Expired/cancelled rows free the slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_consult_slot_live ON consult_bookings(consultant_id, slot_start_ms)
  WHERE status IN ('held','awaiting_review','confirmed','in_call','completed','no_show_customer');
CREATE INDEX IF NOT EXISTS ix_consult_bookings_uid ON consult_bookings(uid, created_at);
CREATE INDEX IF NOT EXISTS ix_consult_bookings_consultant ON consult_bookings(consultant_id, slot_start_ms);
CREATE INDEX IF NOT EXISTS ix_consult_bookings_status ON consult_bookings(status, slot_start_ms);

CREATE TABLE IF NOT EXISTS consult_photos (
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('palm_right','palm_left','face_front','face_side')),
  r2_key TEXT NOT NULL,                      -- private DIGITAL bucket
  api_id TEXT,                               -- palm_id / face_id from AstrologyAPI vision
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','accepted','rejected')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (booking_id, kind)
);

CREATE TABLE IF NOT EXISTS consult_file_cards (
  booking_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  api_json TEXT,
  override_json TEXT,
  edited_by TEXT,
  edited_at INTEGER,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','missing','error')),
  note TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (booking_id, key)
);

CREATE TABLE IF NOT EXISTS consult_reviews (
  id TEXT PRIMARY KEY,                       -- 'cr_' + 16 hex
  booking_id TEXT UNIQUE,                    -- NULL for seed reviews
  consultant_id TEXT NOT NULL,
  uid TEXT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text TEXT,
  display_name TEXT NOT NULL,
  discipline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  seed INTEGER NOT NULL DEFAULT 0,           -- seed rows are NEVER shown on the public site
  moderated_by TEXT,
  moderated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_consult_reviews_c ON consult_reviews(consultant_id, status, created_at);
