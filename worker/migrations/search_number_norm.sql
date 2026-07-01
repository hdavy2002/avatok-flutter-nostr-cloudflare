-- People-directory search at scale (2026-07-01).
-- Discovery is EXACT-KEY only: email (via /api/resolve) and AvaTOK number.
-- NAME search is intentionally NOT supported (a name matches thousands of people
-- at millions of users — noise + cost with no product value), so there are no
-- name indexes here.
--
-- number_norm = last 10 digits of the AvaTOK number (canonical digits). Search
-- matches avatok_number (exact) OR number_norm (suffix) — both indexed — so
-- "+13022202211", "13022202211" and "3022202211" all resolve without a scan.
-- Written alongside avatok_number in worker/src/routes/number.ts.
ALTER TABLE users ADD COLUMN number_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_users_number_norm ON users(number_norm);

-- Backfill existing rows (avatok_number is already stored as canonical digits).
UPDATE users SET number_norm = substr(avatok_number, -10)
 WHERE avatok_number IS NOT NULL AND avatok_number <> '';
