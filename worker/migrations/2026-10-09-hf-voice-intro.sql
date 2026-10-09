-- [HF-VOICE-INTRO-1] Host's own recorded voice introduction. DB_META. ALTER ... ADD COLUMN only (SQLite has no IF NOT EXISTS here: run once).
-- apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-voice-intro.sql
ALTER TABLE hf_hosts ADD COLUMN intro_mime TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_status TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_transcript TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_flags_json TEXT;
ALTER TABLE hf_hosts ADD COLUMN intro_uploaded_at INTEGER;
