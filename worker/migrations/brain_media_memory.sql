-- [AVABRAIN-MEDIA-1] (Bible §5) — daily audio/video memory pipeline state.
--
-- brain_media is the state-machine row for ONE uploaded recording the user opted
-- to "Remember in AvaBrain" (domain `media_memory`, worker/src/lib/brain_domains.ts).
-- It is intentionally separate from `user_media` (AvaLibrary) and `brain_transcripts`
-- (DM voicemail) — different retention, different cost profile, different consent key.
--
-- state machine (Bible §5.2 step 6): queued -> transcribing -> summarizing ->
-- embedding -> ready | failed | deleted. `state`/`error`/`updated_at` are the
-- only columns the consumer mutates after insert; the route only INSERTs (at
-- /complete) and reads (at GET /:id, DELETE /:id).
--
-- Dedup (Bible §5.3): UNIQUE(uid, content_hash) — a re-upload of the same bytes by
-- the same user resolves to the SAME row instead of a second processing job. The
-- id is a fresh uuid (not the hash itself) so vector/derived ids stay stable even
-- if content_hash collisions ever needed remediation.
--
-- Apply: scripts/cf.sh d1 execute avatok-brain --file=worker/migrations/brain_media_memory.sql
-- (never raw `wrangler d1 execute` — the wrapper resolves the correct
-- staging/production D1 binding off .avatok-target; a bare wrangler call
-- resolves the TOP-LEVEL wrangler.toml block, which is PRODUCTION.)
CREATE TABLE IF NOT EXISTS brain_media (
  id            TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  content_hash  TEXT NOT NULL,        -- sha256 hex of the PLAINTEXT bytes (idempotency + dedup key) — computed
                                       -- BEFORE encryption so a re-upload of the same recording still dedups.
  kind          TEXT NOT NULL,        -- 'audio' | 'video'
  mime          TEXT NOT NULL,
  r2_key        TEXT NOT NULL,        -- BLOBS key, u/<uid>/media_memory/<hash>. BLOBS (avatok-blobs) is the
                                       -- PUBLIC, world-servable bucket (blossom.avatok.ai) — media_memory is
                                       -- account_private, so the bytes stored at this key are ALWAYS AES-256-GCM
                                       -- ciphertext (key_b64/iv_b64 below), never plaintext. Never expose this
                                       -- key as a fetchable URL from any endpoint.
  size_bytes    INTEGER NOT NULL,     -- ciphertext length (== plaintext length for AES-GCM sans the 16B tag,
                                       -- which is appended to the ciphertext by WebCrypto)
  duration_sec  INTEGER,
  key_b64       TEXT,                 -- per-item random AES-256 key, base64 — server-side only, NEVER returned
                                       -- by GET /:id or any other endpoint. NULL only for pre-encryption legacy
                                       -- rows (none expected — media_memory ships dark until this lands).
  iv_b64        TEXT,                 -- per-item random 12-byte GCM IV, base64 — paired with key_b64.
  state         TEXT NOT NULL DEFAULT 'queued', -- queued|transcribing|summarizing|embedding|ready|failed|deleted
  error         TEXT,                 -- last failure reason (state='failed' only)
  transcript_chars INTEGER,           -- bounded transcript length actually stored (telemetry/audit)
  frame_count   INTEGER,              -- # frames captioned (video only; budgeted, may be 0)
  vector_count  INTEGER,              -- # Vectorize chunks embedded (audit / dedup sanity)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ready_at      INTEGER,
  UNIQUE (uid, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_brain_media_uid ON brain_media(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_media_state ON brain_media(uid, state);
