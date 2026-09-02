-- [LIST-SLOTS-1] The real slots table — calendar 1:1 booking grain.
-- DB: avatok-meta (DB_META). CREATE-only file (a table and its indexes; no
-- ALTERs), per Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.3.
--
-- WHY THIS EXISTS — `listings.starts_at` is one instant. A calendar 1:1 (flow
-- D "Calendar 1:1") needs many bookable slots per listing, each with its own
-- capacity (capacity=1 IS a 1:1 slot) and its own atomic seat claim. This is
-- NOT `calendar_slots` (old AvaCalendar) — that table is untouched, left alone
-- per §C.3's explicit "is not this table. Leave it."
--
-- `listings.starts_at` STAYS and mirrors the earliest open slot; every shipped
-- client, card, email and sort still reads it. This table is additive.
--
-- Atomic claim pattern (mirrors worker/src/cal/engine.ts:claimBlock):
--   UPDATE listing_slots SET booked_count = booked_count + ?N
--   WHERE id = ?1 AND booked_count + ?N <= capacity;
-- Zero rows affected = full; the caller checks changes/meta.rows_written.
--
-- Slot is the booking grain for `consult`; optional refinement for
-- `live_event` — a live event with no slot rows behaves exactly as today.
-- `commercial_checkout.ts` will accept `slot_id`; the old `{start_at, end_at}`
-- body keeps working for one release and is resolved to a slot server-side
-- (not part of this migration).
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.
--
-- APPLY — this file has no ALTER TABLE statements, so d1_apply_alters.py will
-- refuse it ("no ALTER TABLE ... ADD COLUMN statements") by design. Use the
-- raw CREATE-TABLE path instead, which is idempotent via IF NOT EXISTS:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-listing-slots.sql
--   ALLOW_PROD=1 scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-02-listing-slots.sql

CREATE TABLE IF NOT EXISTS listing_slots (
  id            TEXT PRIMARY KEY,
  listing_id    TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,           -- epoch ms UTC
  ends_at       INTEGER NOT NULL,           -- epoch ms UTC
  label         TEXT,
  capacity      INTEGER NOT NULL,           -- capacity 1 = a 1:1 slot
  booked_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open', -- open|full|cancelled|done
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Answers "give me this listing's open slots in order".
CREATE INDEX IF NOT EXISTS idx_listing_slots_listing ON listing_slots(listing_id, starts_at);

-- Prevents a creator (or a double-submit) from creating two identical slots.
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_slots_unique ON listing_slots(listing_id, starts_at, label);
