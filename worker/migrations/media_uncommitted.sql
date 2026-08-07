-- [SPEC-SEND-1 / WS-30a] "uncommitted" state on user_media.
--
-- WHY: the client uploads chat media SPECULATIVELY (while the user is still
-- composing / before they hit Send). Those bytes must NOT consume the user's
-- AvaStorage quota until the media is actually sent, otherwise a browsed-and-
-- abandoned attachment silently eats the 5 GB pool and can push an account
-- read-only for a file that was never shared with anyone.
--
--   uncommitted = 0  committed (DEFAULT, and what every EXISTING row backfills
--                    to) — counted by recomputeStorage(), exactly as today.
--   uncommitted = 1  speculative, not yet sent — EXCLUDED from the quota SUM
--                    (worker/src/storage.ts recomputeStorage) until
--                    POST /api/media/commit flips it back to 0.
--   uncommitted_at   epoch ms the row entered the speculative state; NULL once
--                    committed. This is what a stale-draft sweeper prunes on.
--
-- Back-compat: purely additive. The DEFAULT 0 means a client/worker that knows
-- nothing about this column behaves byte-for-byte as before.
--
-- Apply: wrangler d1 execute avatok-media-meta --file=migrations/media_uncommitted.sql
-- STAGING FIRST, then prod as a deliberate step (CLAUDE.md: promotion is code +
-- migrations only).
--
-- D1/SQLite has NO "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" — re-running an
-- ADD COLUMN that already exists errors harmlessly on THAT statement, so run the
-- statements one at a time (same note as migrations/receptionist_status_note.sql).
-- The Worker ALSO self-migrates these two columns at runtime with the same
-- try/swallow guard do/inbox.ts uses (`ensureUncommittedColumns` in
-- routes/media.ts), so applying this file is safe whether or not the runtime
-- guard already ran.

ALTER TABLE user_media ADD COLUMN uncommitted INTEGER DEFAULT 0;  -- 0 = committed (counts), 1 = speculative (does not)
ALTER TABLE user_media ADD COLUMN uncommitted_at INTEGER;         -- epoch ms; NULL once committed

-- Partial index for the stale-speculative sweep. Only rows that are actually
-- uncommitted are indexed, so it stays tiny (the overwhelming majority of rows
-- are committed) while covering "find speculative rows older than X".
CREATE INDEX IF NOT EXISTS idx_media_uncommitted
  ON user_media(uncommitted, uncommitted_at)
  WHERE uncommitted = 1;
