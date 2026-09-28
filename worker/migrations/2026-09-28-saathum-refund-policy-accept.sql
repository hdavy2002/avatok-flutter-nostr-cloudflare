-- [REFUND-POLICY-SRV-1] Records WHEN a buyer accepted the refund policy and WHICH
-- version of it, on the Saa Thum checkout row itself (routes/saathum_checkout.ts
-- saathumCheckoutCreate). ALTER-only file (CLAUDE.md / DASH2 convention: the
-- alter-applier script only runs against files with no CREATE TABLE statement).
-- NOT applied by the implementing agent -- the coordinator applies it with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-28-saathum-refund-policy-accept.sql
-- (or the standard d1_apply_alters.py sweep, since this file contains only ALTERs).
--
-- refund_policy_version is a short opaque string ("refunds-2026-09-28") identifying
-- the wording the buyer agreed to -- see REFUND_POLICY_VERSION in
-- routes/saathum_checkout.ts. Never re-derive "what they agreed to" from the CURRENT
-- policy; this column is the snapshot, same discipline as every other frozen quote/
-- policy value on this table (quote_json, sankalp_json).
ALTER TABLE saathum_checkouts ADD COLUMN refund_policy_accepted_at INTEGER;
ALTER TABLE saathum_checkouts ADD COLUMN refund_policy_version TEXT;
