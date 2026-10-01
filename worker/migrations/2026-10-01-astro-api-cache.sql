-- [AUMFE-ASTRO-CLIENT-1 2026-10-01] AstrologyAPI answer cache (DB_META). NOT yet applied.
-- expires_at NULL = cached forever (natal data); otherwise epoch ms (next IST midnight for daily data).
CREATE TABLE IF NOT EXISTS astro_api_cache (
  key        TEXT PRIMARY KEY,
  endpoint   TEXT,
  json       TEXT,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_astro_api_cache_expires ON astro_api_cache(expires_at);
