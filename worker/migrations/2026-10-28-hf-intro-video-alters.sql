-- [HF-INTRO-W1] HF-INTRO-VIDEO-1: hf_hosts columns. DB_META. ALTER ADD COLUMN lines only (scripts/d1_apply_alters.py applies these):
--   python3 scripts/d1_apply_alters.py ... or scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-28-hf-intro-video-alters.sql
-- A host with intro_approved_at NULL is never shown in the intro Reels (D14/D18). call_option NULL = legacy host (no A/B choice yet).
ALTER TABLE hf_hosts ADD COLUMN categories_json TEXT;
ALTER TABLE hf_hosts ADD COLUMN call_option TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_video_id TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_approved_at INTEGER;
