-- Phase 9 — AvaChat ⇄ AvaBrain. Two small registries in DB_BRAIN:
--
-- brain_vectors: every NON-entity vector we upsert into Vectorize (messages,
-- voicemails, library chunks are derivable elsewhere; messages/voicemails are
-- not), keyed by the deterministic vector id. Enables retro-delete when a
-- guardrail toggles OFF (BRAIN_RETRO_DELETE) and a clean per-user purge —
-- Vectorize cannot delete by metadata filter, only by id.
--
-- brain_transcripts: Whisper transcripts for voice notes / voice mails, stored
-- next to the media ref (derived data — does NOT count against storage quota).
-- Apply: wrangler d1 execute avatok-brain --remote --file=worker/migrations/brain_phase9.sql

CREATE TABLE IF NOT EXISTS brain_vectors (
  vec_id     TEXT PRIMARY KEY,        -- e.g. <uid>:msg:<conv>:<ts> | <uid>:vm:<media_ref>:<i>
  uid        TEXT NOT NULL,
  capability TEXT NOT NULL,           -- guardrail capability that allowed it (avatok_messages|group_chats|voicemails|files|…)
  kind       TEXT NOT NULL,           -- message|voicemail|file
  source_app TEXT NOT NULL,
  ref        TEXT,                    -- conv id / media_ref — the deep link target
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_vec_user ON brain_vectors(uid, capability);
CREATE INDEX IF NOT EXISTS idx_brain_vec_kind ON brain_vectors(uid, kind);

CREATE TABLE IF NOT EXISTS brain_transcripts (
  uid        TEXT NOT NULL,
  media_ref  TEXT NOT NULL,           -- R2 key / media id of the voice note
  conv       TEXT,                    -- conversation it was heard in
  transcript TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, media_ref)
);
CREATE INDEX IF NOT EXISTS idx_brain_tr_user ON brain_transcripts(uid, created_at DESC);
