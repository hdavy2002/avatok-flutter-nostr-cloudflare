-- [HF-CALLS-1] Host presence. ALTER only: apply with scripts/d1_apply_alters.py worker/migrations/2026-10-09-hf-presence.sql (idempotent; needs 2026-10-09-hf-hosts.sql first).
ALTER TABLE hf_hosts ADD COLUMN presence TEXT NOT NULL DEFAULT 'offline';
ALTER TABLE hf_hosts ADD COLUMN presence_at INTEGER;
