-- People-directory search at scale (2026-07-01).
-- Goal: number + name lookups must be INDEX-only (no full-table scans) so they
-- stay cheap/fast at millions of users, and format-tolerant for numbers.
--
-- number_norm = last 10 digits of the AvaTOK number (canonical digits). Search
-- matches avatok_number (exact) OR number_norm (suffix) — both indexed — so
-- "+13022202211", "13022202211" and "3022202211" all resolve without a scan.
-- Written alongside avatok_number in worker/src/routes/number.ts.
ALTER TABLE users ADD COLUMN number_norm TEXT;
CREATE INDEX IF NOT EXISTS idx_users_number_norm ON users(number_norm);

-- Name PREFIX search uses these COLLATE NOCASE indexes (a `lower(col) LIKE` or a
-- leading-'%' substring can't use an index; `col LIKE 'x%' COLLATE NOCASE` can).
CREATE INDEX IF NOT EXISTS idx_users_dname_nc ON users(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_fname_nc ON users(first_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_lname_nc ON users(last_name COLLATE NOCASE);

-- Backfill existing rows (avatok_number is already stored as canonical digits).
UPDATE users SET number_norm = substr(avatok_number, -10)
 WHERE avatok_number IS NOT NULL AND avatok_number <> '';
