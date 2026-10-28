-- [HF-INTRO-DELETE-1] hf_intro_videos: record that the files were removed from storage. DB_META. ALTER ADD COLUMN lines only (scripts/d1_apply_alters.py applies these):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-28-hf-intro-video-deleted-alters.sql
-- A rejected / replaced / expired video keeps its row (the record of the decision) but its R2 files are deleted: deleted_at is set and r2_key / poster_key are cleared.
-- Apply BEFORE the worker that deletes (the daily sweep skips itself while deleted_at is missing, reject / approve need it).
ALTER TABLE hf_intro_videos ADD COLUMN deleted_at INTEGER;
ALTER TABLE hf_intro_videos ADD COLUMN deleted_reason TEXT;     -- rejected | replaced | draft_replaced | draft_expired
