-- DB_MEDIA — AvaLibrary file-manager extension (additive, non-breaking).
-- Extends the user_media spine with a category/file_name/folder model, soft-delete,
-- and sent|received provenance, plus a user-folder table. Apply via the D1 REST API
-- (sandbox can't run `wrangler d1 migrate`): POST .../d1/database/<DB_MEDIA>/query.
--
-- NOTE: D1 ALTER TABLE adds ONE column per statement and has no "IF NOT EXISTS"
-- for columns, so the apply script tolerates "duplicate column" errors (idempotent).

-- 1. category: image|video|document|audio|other — derived from mime on insert.
ALTER TABLE user_media ADD COLUMN category TEXT;
-- 2. file_name: original display name (e.g. "invoice-june.pdf").
ALTER TABLE user_media ADD COLUMN file_name TEXT;
-- 3. folder_id: user-folder placement; NULL = lives in its auto (system) folder.
ALTER TABLE user_media ADD COLUMN folder_id TEXT;
-- 4. deleted_at: soft delete (storage recompute on set); NULL = live.
ALTER TABLE user_media ADD COLUMN deleted_at INTEGER;
-- 5. source_kind: sent|received (receiver-side Library entries = 'received').
ALTER TABLE user_media ADD COLUMN source_kind TEXT DEFAULT 'sent';
-- 6. enc_blob: for 'received' DM media — decryption material encrypted to the
--    recipient (Vault-style). Server never sees plaintext keys.
ALTER TABLE user_media ADD COLUMN enc_blob TEXT;

-- Backfill category from mime (fallback to legacy media_type for old rows).
UPDATE user_media SET category =
  CASE
    WHEN mime_type LIKE 'image/%' THEN 'image'
    WHEN mime_type LIKE 'video/%' THEN 'video'
    WHEN mime_type LIKE 'audio/%' THEN 'audio'
    WHEN mime_type LIKE 'application/pdf' OR mime_type LIKE 'text/%'
      OR mime_type LIKE 'application/msword%'
      OR mime_type LIKE 'application/vnd.%' THEN 'document'
    WHEN media_type = 'image' THEN 'image'
    WHEN media_type = 'video' THEN 'video'
    WHEN media_type = 'audio' THEN 'audio'
    ELSE 'other'
  END
WHERE category IS NULL;

-- Default provenance for existing rows.
UPDATE user_media SET source_kind = 'sent' WHERE source_kind IS NULL;

-- Helpful indexes for the folder tree + storage SUM.
CREATE INDEX IF NOT EXISTS idx_media_lib ON user_media(uid, original_app, category, deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_folder ON user_media(uid, folder_id);

-- User folders (system folders app→category are virtual, never stored).
CREATE TABLE IF NOT EXISTS library_folders (
  id         TEXT PRIMARY KEY,
  uid       TEXT NOT NULL,
  app        TEXT NOT NULL,            -- which app root this folder hangs under
  name       TEXT NOT NULL,
  parent_id  TEXT,                     -- NULL = top-level user folder under the app
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_tree ON library_folders(uid, app, parent_id);
