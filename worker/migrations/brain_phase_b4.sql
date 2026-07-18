-- One Brain — Phase B4 (SPEC-2026-07-17 §5.3, §8-B4, B-D4). Derived-fact retention.
-- Additive columns on brain_facts so the nightly fact-decay job can age out facts
-- not re-supported within 18 months, and refresh them on re-observation. All
-- statements are IF-safe / additive — running twice is harmless (see note on ALTER).
--
-- Apply: wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain_phase_b4.sql
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN has no "IF NOT EXISTS". These two ALTERs will
-- error with "duplicate column name" if re-run after a first successful apply — that
-- error is benign (the column already exists). Apply once per D1 (prod + staging).

-- ── DB_BRAIN (avatok-brain) ─────────────────────────────────────────────────

-- §5.3 fact decay: the newest supporting event ts (derived_from_max_ts) and the
-- last time the fact was (re-)observed (last_confirmed_at). Nullable so pre-B4 rows
-- are untouched; the decay job COALESCEs to updated_at for them. The consumer +
-- do/user_brain.ts fact-writing paths now stamp both on every write.
ALTER TABLE brain_facts ADD COLUMN derived_from_max_ts INTEGER;
ALTER TABLE brain_facts ADD COLUMN last_confirmed_at   INTEGER;

-- Nightly decay scan: DELETE ... WHERE COALESCE(last_confirmed_at, derived_from_max_ts,
-- updated_at) < cutoff. Index on the primary decay key keeps the sweep cheap.
CREATE INDEX IF NOT EXISTS idx_brain_facts_decay ON brain_facts(uid, last_confirmed_at);
