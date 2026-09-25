-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- Customer profile fields that have no home in users (identity stays in users).
CREATE TABLE IF NOT EXISTS user_profile_extras (
  uid         TEXT PRIMARY KEY,
  gotra       TEXT,
  family_json TEXT,   -- JSON array of family member names/objects
  language    TEXT,
  notify_json TEXT,   -- JSON {push,email,whatsapp}
  updated_at  INTEGER NOT NULL
);
