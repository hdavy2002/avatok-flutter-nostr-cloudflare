-- F2 (customizable greeting): receptionist owner greeting preset + festival auto-greeting.
-- Additive, backward-compatible. The Worker ALSO self-migrates these columns at runtime
-- (guarded ADD COLUMN in receptionist.ts `ensureStatusColumns`), so applying this file is
-- optional-but-recommended for a clean schema. Apply to STAGING D1 first, then PROD.
-- D1 has no "ADD COLUMN IF NOT EXISTS" — if a column already exists (because the runtime
-- self-migration ran), that individual statement errors harmlessly; run them one at a time.
--
-- greeting_style: a preset id from GREETING_PRESETS in receptionist.ts
--   (none|namaste|jai_shree_ram|radhe_radhe|ram_ram|sat_sri_akal|assalam|vanakkam|
--    khamma_ghani|namaskar|hello|custom). NULL/none = plain open. "custom" resolves
--   the phrase from the existing greeting_text column.
-- festival_greeting: 0/1 — when 1 and today matches a known festival (Christmas, New
--   Year, Diwali, Holi, Eid al-Fitr), the festival greeting replaces the preset.
--
-- Apply: wrangler d1 execute DB_META --remote --file=migrations/receptionist_greeting.sql

ALTER TABLE receptionist_settings ADD COLUMN greeting_style TEXT;           -- preset id; NULL/none = plain open
ALTER TABLE receptionist_settings ADD COLUMN festival_greeting INTEGER;     -- 0/1: festival auto-greeting on matching dates
