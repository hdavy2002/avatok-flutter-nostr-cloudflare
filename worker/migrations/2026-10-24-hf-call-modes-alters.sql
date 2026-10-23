-- [HF-CALL-MODES-P0] Host call mode + on-call timestamp + queue pause; call source/funding columns.
-- ALTER only (D1 rule 6: CREATE never shares a file with ALTER). Apply with:
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-10-24-hf-call-modes-alters.sql
-- Needs 2026-10-09-hf-hosts.sql and 2026-10-09-hf-calls.sql first. Then apply 2026-10-24-hf-call-modes-backfill.sql.
-- Spec: Specs/SPEC-2026-10-23-HF-CALL-MODES-QUEUE.md section 2.6. Nothing reads these until hfCallModesEnabled / hfCallQueueEnabled / hfCallChunkBillingEnabled.
ALTER TABLE hf_hosts ADD COLUMN call_mode TEXT NOT NULL DEFAULT 'online';
ALTER TABLE hf_hosts ADD COLUMN on_call_since INTEGER;
ALTER TABLE hf_hosts ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hf_calls ADD COLUMN source TEXT;
ALTER TABLE hf_calls ADD COLUMN queue_entry_id TEXT;
ALTER TABLE hf_calls ADD COLUMN funded_seconds INTEGER;
ALTER TABLE hf_calls ADD COLUMN chunks INTEGER;
