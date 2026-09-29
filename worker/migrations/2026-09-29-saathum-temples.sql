-- [SAATHUM-TEMPLE-FIELD-1 2026-09-29] OWNER REQUEST: every event names the temple it is performed at.
-- A reusable temple directory (admin picks one per event, or adds a new one once and reuses it)
-- plus a nullable listings.temple_id. Additive and idempotent (CREATE IF NOT EXISTS / INSERT OR IGNORE);
-- the ALTER runs once -- re-running it errors with "duplicate column name", which is harmless.
-- NOT applied by the implementing agent. Apply BEFORE deploying the worker (the public listing
-- and checkout reads join this table):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-29-saathum-temples.sql
--
-- saathum_temples.region: the region key from web/src/lib/temples.ts (rishikesh, haridwar, ...), null for
-- temples the admin adds by hand. UNIQUE(name, place) is case-sensitive in SQLite; the API also does a
-- case-insensitive duplicate check (lib/temples.ts) so "kunjapuri devi temple" returns the existing row.
CREATE TABLE IF NOT EXISTS saathum_temples (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  place      TEXT NOT NULL,
  region     TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (name, place)
);
CREATE INDEX IF NOT EXISTS idx_saathum_temples_name ON saathum_temples(name COLLATE NOCASE);

ALTER TABLE listings ADD COLUMN temple_id TEXT; -- nullable; references saathum_temples.id (not enforced, D1)

INSERT OR IGNORE INTO saathum_temples (id, name, place, region, created_at) VALUES
  ('temple_kunjapuri-devi-temple', 'Kunjapuri Devi Temple', 'Rishikesh', 'rishikesh', 1790640000000),
  ('temple_shatrughan-temple', 'Shatrughan Temple', 'Rishikesh', 'rishikesh', 1790640000000),
  ('temple_bilkeshwar-mahadev-temple', 'Bilkeshwar Mahadev Temple', 'Haridwar', 'haridwar', 1790640000000),
  ('temple_daksheshwar-mahadev-temple', 'Daksheshwar Mahadev Temple', 'Kankhal, Haridwar', 'haridwar', 1790640000000),
  ('temple_sureshwari-devi-temple', 'Sureshwari Devi Temple', 'Haridwar', 'haridwar', 1790640000000),
  ('temple_neeleshwar-mahadev-temple', 'Neeleshwar Mahadev Temple', 'Haridwar', 'haridwar', 1790640000000),
  ('temple_prakasheshwar-mahadev-temple', 'Prakasheshwar Mahadev Temple', 'Dehradun', 'dehradun', 1790640000000),
  ('temple_laxman-siddh-temple', 'Laxman Siddh Temple', 'Dehradun', 'dehradun', 1790640000000),
  ('temple_kamleshwar-mahadev-temple', 'Kamleshwar Mahadev Temple', 'Purola', 'purola', 1790640000000),
  ('temple_yogadhyan-badri', 'Yogadhyan Badri', 'Pandukeshwar, Badrinath', 'badrinath', 1790640000000),
  ('temple_bhavishya-badri', 'Bhavishya Badri', 'Joshimath', 'badrinath', 1790640000000),
  ('temple_vridha-badri', 'Vridha Badri', 'Joshimath', 'badrinath', 1790640000000),
  ('temple_mata-murti-temple', 'Mata Murti Temple', 'Mana, Badrinath', 'badrinath', 1790640000000),
  ('temple_kashi-vishwanath-temple', 'Kashi Vishwanath Temple', 'Guptkashi', 'kedarnath', 1790640000000),
  ('temple_omkareshwar-temple', 'Omkareshwar Temple', 'Ukhimath', 'kedarnath', 1790640000000),
  ('temple_gauri-mai-temple', 'Gauri Mai Temple', 'Gaurikund', 'kedarnath', 1790640000000),
  ('temple_mukhimath-ganga-temple', 'Mukhimath Ganga Temple', 'Mukhba, Gangotri', 'gangotri', 1790640000000),
  ('temple_lakshmi-narayan-temple', 'Lakshmi Narayan Temple', 'Harsil', 'gangotri', 1790640000000),
  ('temple_bijli-mahadev-temple', 'Bijli Mahadev Temple', 'Kullu', 'himachal', 1790640000000),
  ('temple_prashar-rishi-temple', 'Prashar Rishi Temple', 'Mandi', 'himachal', 1790640000000);
