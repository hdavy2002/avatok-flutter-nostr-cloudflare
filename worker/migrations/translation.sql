-- Live Voice Translation (Gemini 3.5 Live Translate) — PROPOSAL-LIVE-TRANSLATION-GEMINI.md
-- DB: avatok-meta (DB_META). Billing is metered per minute at 5 AvaCoins/min
-- ($3/hour, 1 coin = $0.01); 100% of translation fees go to platform:fees —
-- the creator never shares in this amount.

-- One row per listener-translation session (a user may have several per call:
-- stop/start, language change = new session).
CREATE TABLE IF NOT EXISTS translation_sessions (
  id            TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,               -- the LISTENER being billed (buyer or creator)
  context       TEXT NOT NULL,               -- consult | live | conference
  ref           TEXT NOT NULL,               -- booking id (consult) | listing id (live) | conversation id
  booking_id    TEXT,                        -- set when prepaid via a booking
  trl_order_id  TEXT,                        -- escrow bucket trl_<id> for prepaid mode
  mode          TEXT NOT NULL,               -- prepaid | payg
  target_lang   TEXT NOT NULL,               -- BCP-47
  rate_per_min  INTEGER NOT NULL DEFAULT 5,  -- coins/min (5 = $3/h)
  started_at    INTEGER NOT NULL,
  last_beat_at  INTEGER NOT NULL,
  billed_min    INTEGER NOT NULL DEFAULT 0,
  billed_coins  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active', -- active | paused_funds | ended
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trl_uid     ON translation_sessions(uid, status);
CREATE INDEX IF NOT EXISTS idx_trl_ref     ON translation_sessions(ref);
CREATE INDEX IF NOT EXISTS idx_trl_booking ON translation_sessions(booking_id);

-- Creator listing options: "Voice translation available" + language of
-- transmission (the language the creator speaks in).
ALTER TABLE listings ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN spoken_lang TEXT;

-- Booking-time prepay: buyer chose translation at checkout. translation_coins
-- is the prepaid amount held in escrow trl_<orderId>; consumed minutes settle
-- to platform:fees, the remainder refunds with the booking's refund rules.
ALTER TABLE bookings ADD COLUMN translation_lang TEXT;
ALTER TABLE bookings ADD COLUMN translation_coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN trl_order_id TEXT;
