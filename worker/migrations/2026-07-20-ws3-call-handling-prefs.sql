-- [AVACALL-SET-1] WS3 (owner decision 2026-07-20): two PAID per-user call-handling
-- prefs, DEFAULT OFF. Additive, backward-compatible. The Worker ALSO self-migrates
-- these columns at runtime (guarded ADD COLUMN in receptionist.ts `ensureStatusColumns`),
-- so applying this file is optional-but-recommended for a clean schema. Apply to
-- STAGING D1 first, then PROD as a deliberate step.
--
-- D1 has no "ADD COLUMN IF NOT EXISTS" — if a column already exists (because the
-- runtime self-migration ran first), that individual statement errors harmlessly;
-- run them one at a time.
--
--   ai_receptionist_enabled → Ava takes over on reject / no-answer / phone-off for
--                             BOTH AvaTOK↔AvaTOK and PSTN calls. 1/0; NULL = OFF.
--   pstn_voicemail_enabled  → a pre-recorded voicemail for PSTN calls only (the free
--                             AvaTOK↔AvaTOK voicemail is separate + always on). 1/0; NULL = OFF.

ALTER TABLE receptionist_settings ADD COLUMN ai_receptionist_enabled INTEGER;  -- 1/0; NULL = OFF
ALTER TABLE receptionist_settings ADD COLUMN pstn_voicemail_enabled INTEGER;   -- 1/0; NULL = OFF
