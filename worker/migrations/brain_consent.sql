-- DB_BRAIN — AvaBrain consent toggles (Golden Rule 15: default ON / opt-out).
-- One row per (npub, capability). ABSENCE of a row means ENABLED (default ON) —
-- we only persist a row when the user turns something OFF (or back on). Booleans
-- are non-sensitive, so they live server-readable here and gate the ingestion
-- pipeline (Q_BRAIN producers + the brain consumer both check this).
--
-- Capabilities:
--   master            — the global AvaBrain switch
--   <app>_files       — "keep a tab on my files" for an app (e.g. avatok_files)
--   <app>_dms         — "read my <app> DMs" (on-device only; gates client extractors)
CREATE TABLE IF NOT EXISTS brain_consent (
  npub       TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (npub, capability)
);
