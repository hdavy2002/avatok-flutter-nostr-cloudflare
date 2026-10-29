-- [HF-MOD-3 2026-10-29] Intro video safety check. ALTERs only (apply with scripts/d1_apply_alters.py).
ALTER TABLE hf_intro_videos ADD COLUMN storage TEXT NOT NULL DEFAULT 'public'; -- 'private' = DIGITAL bucket until approved
ALTER TABLE hf_moderation_jobs ADD COLUMN override_by TEXT;    -- admin uid who approved against an AI flag
ALTER TABLE hf_moderation_jobs ADD COLUMN override_note TEXT;  -- why the AI was wrong (required)
ALTER TABLE hf_moderation_jobs ADD COLUMN override_at INTEGER;
