-- [AVABRAIN-EXPORT-1] (Bible §6.1, §9.2, §P1.3/P1.5) — explicit private-content
-- export + memory review/correction/forget/export screens.
--
-- Apply: wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain_export_memory.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN has no "IF NOT EXISTS". These ALTERs will
-- error with "duplicate column name" if re-run after a first successful apply —
-- that error is benign (the column already exists). Apply once per D1 (prod +
-- staging), mirroring the existing brain_phase_b4.sql convention.

-- §4.2 fact quality: user_confirmed raises a fact's authority (memory/confirm).
-- valid_until marks a fact SUPERSEDED by a correction (memory/correct) — NULL
-- means "currently active"; a non-null value excludes it from the review list
-- and from recall without deleting the audit trail.
ALTER TABLE brain_facts ADD COLUMN user_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brain_facts ADD COLUMN valid_until     INTEGER;

CREATE INDEX IF NOT EXISTS idx_brain_facts_active ON brain_facts(uid, valid_until, updated_at DESC);

-- One audit row per POST /api/brain/export call (Bible §6.1: "the ONLY way
-- device_private content reaches the server" — auditable, bounded). Never
-- stores the exported content itself, only who/when/how much.
CREATE TABLE IF NOT EXISTS brain_export_audit (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  item_count  INTEGER NOT NULL,
  char_count  INTEGER NOT NULL,
  sources     TEXT,                    -- JSON breakdown, e.g. {"dm":3,"group":1}
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_export_audit_user ON brain_export_audit(uid, created_at DESC);
