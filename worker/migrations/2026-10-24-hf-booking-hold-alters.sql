-- [HF-CALL-MODES-P0] Booking hold = cost of min(length,15) minutes (HF-BOOK-10). ALTER only. Apply with:
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-10-24-hf-booking-hold-alters.sql
-- NULL on old rows: readers fall back to duration_min*60.
ALTER TABLE hf_bookings ADD COLUMN hold_seconds INTEGER;
ALTER TABLE hf_booking_quotes ADD COLUMN hold_seconds INTEGER;
