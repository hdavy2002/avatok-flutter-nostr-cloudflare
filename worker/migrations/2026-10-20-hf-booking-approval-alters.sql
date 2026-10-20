-- [HF-BOOK-APPROVE-BE] Booking approval. ALTER ONLY (scripts/d1_apply_alters.py skips CREATEs, so the CREATE is in 2026-10-20-hf-booking-approval.sql).
-- Apply: python3 scripts/d1_apply_alters.py worker/migrations/2026-10-20-hf-booking-approval-alters.sql   (idempotent; needs 2026-10-13-hf-bookings.sql first)
-- Existing rows get the defaults: every current influencer is 'manual' approval with open-time alerts on; old bookings have no topic / deadline.
ALTER TABLE hf_hosts ADD COLUMN booking_approval TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE hf_hosts ADD COLUMN open_alerts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hf_bookings ADD COLUMN topic_slug TEXT;
ALTER TABLE hf_bookings ADD COLUMN approval_deadline INTEGER;
ALTER TABLE hf_bookings ADD COLUMN approved_at INTEGER;
ALTER TABLE hf_bookings ADD COLUMN decided_by TEXT;
ALTER TABLE hf_bookings ADD COLUMN cancel_reason TEXT;
