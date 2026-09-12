-- [SETTLE-CHECKIN-1] Receipt meta for the creator check-in decision (RULEBOOK-PAID-SESSIONS
-- §2 C1/C2). Nullable, additive columns only -- ALTER ADD COLUMN, applied with
-- `scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<f>.sql` per
-- CLAUDE.md pitfall #6 (a CREATE TABLE in the same file would be silently skipped by
-- d1_apply_alters.py -- this file has none).
--
-- NOT APPLIED by this agent. Coordinator/DEPLOY WP to run it.

ALTER TABLE commercial_receipts ADD COLUMN rule TEXT;
ALTER TABLE commercial_receipts ADD COLUMN checked_in_at INTEGER;
