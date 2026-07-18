-- One Brain — Phase B0 (SPEC-2026-07-17 §3, §5). Consent fail-closed + the
-- stateful deletion contract. Idempotency for brain_events + the brain_deletions
-- job table live in DB_BRAIN (avatok-brain); the avachat_sessions block at the
-- bottom is DB_META (avatok-meta) — see the note there.
--
-- Apply (brain tables): wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain_phase_b0.sql
-- Apply (meta table)   : run ONLY the avachat_sessions statement below against
--                        avatok-meta (it is a no-op in prod, where ava_chat_history.ts
--                        ensureTable() already created it). Running the whole file
--                        against avatok-brain is harmless — it would create an unused
--                        empty avachat_sessions there — but the AUTHORITATIVE copy is
--                        in avatok-meta and that is where the deletion job wipes it.

-- ── DB_BRAIN (avatok-brain) ─────────────────────────────────────────────────

-- §3.2 idempotency: producer-supplied key, stable across retries. Nullable so
-- legacy (keyless) events are unaffected; the unique index is PARTIAL (only
-- enforced where the key is present) so multiple NULLs never collide.
ALTER TABLE brain_events ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_brain_events_idem
  ON brain_events(uid, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- §5.1 deletion contract: deletion is a JOB WITH STATE, not a request.
--   state: pending → running → partial → complete | failed
--   targets: json — ["contacts",...] for a scoped deletion, or "all".
--   counts : json — per-store rows/vectors removed + attempts + failures (audit).
CREATE TABLE IF NOT EXISTS brain_deletions (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  targets      TEXT,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  counts       TEXT,
  completed_at INTEGER
);
-- Latest-per-user lookup (delete_status) + the ingest-time watermark scan.
CREATE INDEX IF NOT EXISTS idx_brain_deletions_uid ON brain_deletions(uid, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_deletions_active ON brain_deletions(uid, state);

-- ── DB_META (avatok-meta) — APPLY THIS STATEMENT AGAINST avatok-meta ─────────
-- Real migration for avachat_sessions (SPEC B0). Mirrors EXACTLY the effective
-- schema that worker/src/routes/ava_chat_history.ts ensureTable() builds lazily
-- (base table + the starred/archived/sort_order columns it ALTERs in). IF NOT
-- EXISTS ⇒ a no-op in prod, where ensureTable() already created it. Keep this
-- and ensureTable() in lock-step: NO schema drift.
CREATE TABLE IF NOT EXISTS avachat_sessions (
  session_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  persona       TEXT,
  title         TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL,
  starred       INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  sort_order    REAL
);
