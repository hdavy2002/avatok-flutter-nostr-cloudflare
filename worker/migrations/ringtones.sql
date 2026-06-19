-- AI Ringback Tones + Busy Tone (Specs/proposals/PROPOSAL-AI-RINGBACK-TONES.md).
-- Per-account library of generated ringtones. Audio bytes live in R2
-- (u/<uid>/ringtones/<id>.mp3); this table is metadata ONLY. Nothing about
-- ringtones lives in a Durable Object (CallRoom stays pure signaling).
--
-- Invariants (enforced in routes/ringtone.ts, not by the schema):
--   • <= 5 rows per account_id — a 6th generation evicts the OLDEST by
--     created_at (its R2 object is deleted first, then this row).
--   • exactly one is_default = 1 per account_id; deleting/evicting the default
--     auto-promotes the newest remaining row.
--
-- Apply to DB_META (avatok-meta) via the REST migration workflow.
CREATE TABLE IF NOT EXISTS ringtones (
  id          TEXT PRIMARY KEY,           -- uuid
  account_id  TEXT NOT NULL,              -- Clerk uid (one account = one uid)
  name        TEXT NOT NULL,              -- shown in settings (e.g. "Calm piano")
  r2_key      TEXT NOT NULL,              -- u/<account_id>/ringtones/<id>.mp3
  url         TEXT NOT NULL,              -- BLOSSOM_BASE_URL/<r2_key>
  seconds     INTEGER NOT NULL DEFAULT 30,
  is_default  INTEGER NOT NULL DEFAULT 0, -- exactly one =1 per account
  created_at  INTEGER NOT NULL            -- epoch ms; FIFO eviction key
);
CREATE INDEX IF NOT EXISTS ix_ringtones_acct ON ringtones(account_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ringtones_default ON ringtones(account_id, is_default);
