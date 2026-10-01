-- [AUMFE-AGENT-MEMORY-1 2026-10-01] Which agent a text conversation belongs to. DB: avatok-meta (DB_META).
-- Confirmed ai_conversations has no `agent` column (see 2026-09-30-preeti-ai.sql + preeti-leadgate.sql).
-- NOT idempotent (SQLite has no ADD COLUMN IF NOT EXISTS): apply exactly once.
ALTER TABLE ai_conversations ADD COLUMN agent TEXT DEFAULT 'preeti';
