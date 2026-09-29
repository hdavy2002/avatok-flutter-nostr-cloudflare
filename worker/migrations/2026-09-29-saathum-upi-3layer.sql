-- [SAATHUM-UPI-3LAYER 2026-09-29] Columns for the 3-layer UPI confirmation
-- (Specs/PLAN-SAATHUM-UPI-3LAYER.md). ALTER-only file (CLAUDE.md / DASH2 convention:
-- the alter-applier only runs files with no CREATE TABLE). DB: avatok-meta (DB_META).
-- NOT applied by the implementing agent. Order: this file FIRST, then
-- 2026-09-29-saathum-upi-3layer-tables.sql (CREATE-only).
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-29-saathum-upi-3layer.sql
-- ADD COLUMN is not idempotent in SQLite: run this file once (the alter sweep records it).
--
-- amount_paise (existing column) now holds the amount the buyer must actually PAY
-- (total_rupees*100 - k, k in 1..199). rounding_discount_paise = total_rupees*100 - amount_paise.
ALTER TABLE saathum_checkouts ADD COLUMN rounding_discount_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saathum_checkouts ADD COLUMN paid_claimed_at INTEGER;       -- buyer tapped "I've paid"
ALTER TABLE saathum_checkouts ADD COLUMN payer_vpa TEXT;                -- from the matched bank SMS
ALTER TABLE saathum_checkouts ADD COLUMN matched_message_hash TEXT;     -- SMS evidence that confirmed it
ALTER TABLE saathum_checkouts ADD COLUMN confirm_source TEXT;           -- sms_auto | utr | admin
ALTER TABLE saathum_checkouts ADD COLUMN reviewed_by TEXT;              -- admin uid (confirm/reject)
ALTER TABLE saathum_checkouts ADD COLUMN review_note TEXT;
ALTER TABLE saathum_checkouts ADD COLUMN reviewed_at INTEGER;
ALTER TABLE saathum_checkouts ADD COLUMN review_alerted_at INTEGER;     -- one admin WhatsApp alert per item
-- Auto-match lookup: "which open checkouts wait on exactly this amount?"
CREATE INDEX IF NOT EXISTS idx_saathum_checkouts_amount_open
  ON saathum_checkouts(receiving_account_key, amount_paise, status);
