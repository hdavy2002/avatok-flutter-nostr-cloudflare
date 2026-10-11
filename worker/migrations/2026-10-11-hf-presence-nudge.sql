-- [HF-PRESENCE-NUDGE-1] 3-hourly WhatsApp "you're offline" reminder for a LIVE host (rulebook HF-HOST-NUDGE-1). ALTER only: apply with
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-10-11-hf-presence-nudge.sql   (idempotent; needs 2026-10-09-hf-hosts.sql first)
ALTER TABLE hf_hosts ADD COLUMN nudge_last_at INTEGER;
ALTER TABLE hf_hosts ADD COLUMN nudge_paused INTEGER NOT NULL DEFAULT 0;
