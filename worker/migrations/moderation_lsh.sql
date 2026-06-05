-- LSH band index for the perceptual-hash blocklist. Each 64-bit pHash (16 hex
-- chars) is split into 4 bands of 16 bits (4 hex chars). An upload matches a
-- blocked image if it shares ANY band, so a near-duplicate (resize/recompress,
-- Hamming ≤6) lands in the same band → indexed candidate lookup instead of an
-- O(n) full-table scan. Final Hamming verification runs only on the few candidates.
CREATE TABLE IF NOT EXISTS blocked_phash_bands (
  band_index  INTEGER NOT NULL,   -- 0..3
  band_value  TEXT NOT NULL,      -- 4-hex-char (16-bit) slice
  hash_id     TEXT NOT NULL,      -- FK → blocked_media_hashes.id
  full_hash   TEXT NOT NULL,      -- complete 16-hex pHash for final verify
  PRIMARY KEY (band_index, band_value, hash_id)
);
CREATE INDEX IF NOT EXISTS idx_phash_band ON blocked_phash_bands(band_index, band_value);
