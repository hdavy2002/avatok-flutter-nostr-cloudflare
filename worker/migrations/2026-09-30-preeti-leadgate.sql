-- [SAATHUM-PREETI-LEADGATE-1 2026-09-30] Preeti lead gate: the visitor's email (for the transcript email) and
-- the transcript bookkeeping. ALTER-only; safe to run once.
ALTER TABLE ai_conversations ADD COLUMN email TEXT;
ALTER TABLE ai_conversations ADD COLUMN transcript_sent_through_id INTEGER;
ALTER TABLE ai_conversations ADD COLUMN transcript_sent_at INTEGER;
