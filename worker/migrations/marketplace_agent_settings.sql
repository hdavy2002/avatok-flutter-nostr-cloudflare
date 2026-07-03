-- Marketplace Agent settings (AI Messenger Batch — STREAM A, MKT-LANG-1).
-- Per-user negotiation-agent preferences: default language (BCP-47), agent name,
-- voice, tone, negotiation guardrails (price floor + ask-before-commit), auto-
-- respond + quiet hours, and digest preference. One row per user (user_id = the
-- Clerk user id, matching every other per-user table here). Server-readable so
-- the negotiation pipeline (worker/src/routes/marketplace.ts) can resolve the
-- buyer's language / floor / tone without a client round-trip.
--
-- Apply (D1 REST or CI): wrangler d1 execute DB_META --remote \
--   --file=migrations/marketplace_agent_settings.sql
CREATE TABLE IF NOT EXISTS marketplace_agent_settings (
  user_id           TEXT PRIMARY KEY,
  agent_name        TEXT,
  lang              TEXT    NOT NULL DEFAULT 'en',
  voice             TEXT,
  tone              TEXT    NOT NULL DEFAULT 'friendly',
  floor_pct         INTEGER NOT NULL DEFAULT 80,
  ask_before_commit INTEGER NOT NULL DEFAULT 0,
  auto_respond      INTEGER NOT NULL DEFAULT 1,
  quiet_start       TEXT,
  quiet_end         TEXT,
  digest            TEXT    NOT NULL DEFAULT 'summary',
  updated_at        INTEGER NOT NULL
);
