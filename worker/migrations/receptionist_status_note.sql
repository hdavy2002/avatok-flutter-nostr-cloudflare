-- F1 (Phase 12 finish): receptionist owner status note + expiry + default answering language.
-- Additive, backward-compatible. The Worker ALSO self-migrates these columns at runtime
-- (guarded ADD COLUMN in receptionist.ts `ensureStatusColumns`), so applying this file is
-- optional-but-recommended for a clean schema. Apply to STAGING D1 first, then PROD.
-- D1 has no "ADD COLUMN IF NOT EXISTS" — if a column already exists (because the runtime
-- self-migration ran), that individual statement errors harmlessly; run them one at a time.

ALTER TABLE receptionist_settings ADD COLUMN status_note TEXT;
ALTER TABLE receptionist_settings ADD COLUMN status_expires_at INTEGER;  -- epoch ms; NULL = never
ALTER TABLE receptionist_settings ADD COLUMN answer_lang TEXT;           -- BCP-47; NULL = auto-detect
