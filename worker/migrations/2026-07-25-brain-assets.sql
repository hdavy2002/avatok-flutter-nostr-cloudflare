-- [AVABRAIN-ASSET-1] Canonical cross-surface AvaMemoryAsset + derived-index
-- lifecycle (Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md Part VI
-- §40/§47). Targets the DB_BRAIN binding — the SAME D1 database as
-- brain_media / brain_consent / brain_vectors / brain_facts / brain_events
-- (see worker/src/types.ts `DB_BRAIN: D1Database` and consumers/src/types.ts
-- `DB_BRAIN: D1Database`). Apply with:
--   wrangler d1 execute <DB_BRAIN binding's database name> --file=worker/migrations/2026-07-25-brain-assets.sql
-- (staging first, via scripts/cf.sh conventions — NOT run by this change; the
-- coordinator runs migrations deliberately per CLAUDE.md.)
--
-- Every read in worker/src/lib/brain_assets.ts and consumers/src/brain_assets.ts
-- filters by owner_uid FIRST — account-scoped indexes below make that the fast
-- path for both the per-media lookup and the query-time consent/scope join.

CREATE TABLE IF NOT EXISTS brain_assets (
  asset_id             TEXT PRIMARY KEY,
  owner_uid            TEXT NOT NULL,
  media_id             TEXT NOT NULL,
  source_conversation  TEXT,
  source_message       TEXT,
  kind                 TEXT NOT NULL,                    -- image|pdf|document|audio|video
  mime                 TEXT,
  title                TEXT,
  user_description     TEXT,
  language             TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  transcript_ref       TEXT,                              -- opaque pointer only — never raw transcript text
  extracted_text_ref   TEXT,                              -- opaque pointer only — never raw extracted text
  caption_ref          TEXT,                              -- opaque pointer only — never raw caption text
  embedding_ref        TEXT,                              -- opaque pointer only — never a raw vector/embedding
  consent_version      INTEGER NOT NULL DEFAULT 1,
  sensitivity_class    TEXT NOT NULL DEFAULT 'standard',   -- standard|sensitive
  index_status         TEXT NOT NULL DEFAULT 'pending',    -- pending|processing|ready|failed|unsupported_visual_indexing|deleted
  deleted_at           INTEGER
);

-- Idempotent ingestion key (worker/src/lib/brain_assets.ts createOrGetAsset
-- ON CONFLICT(owner_uid, media_id) DO NOTHING) AND the primary account-scoped
-- lookup path (getAssetByMediaId / getAssetsByMediaIds).
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_assets_owner_media ON brain_assets(owner_uid, media_id);

-- Account-scoped secondary access patterns.
CREATE INDEX IF NOT EXISTS idx_brain_assets_owner_status  ON brain_assets(owner_uid, index_status);
CREATE INDEX IF NOT EXISTS idx_brain_assets_owner_created ON brain_assets(owner_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_brain_assets_owner_conv    ON brain_assets(owner_uid, source_conversation);
CREATE INDEX IF NOT EXISTS idx_brain_assets_owner_kind    ON brain_assets(owner_uid, kind);

CREATE TABLE IF NOT EXISTS brain_asset_derivatives (
  derivative_id  TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL,
  owner_uid      TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- transcript|caption|ocr_text|extracted_text|embedding
  ref            TEXT NOT NULL,   -- opaque pointer only (D1 row key / Vectorize id) — never raw content
  created_at     INTEGER NOT NULL
);

-- Account-scoped: revoke (deleteAssetDerivatives) always filters owner_uid+asset_id first.
CREATE INDEX IF NOT EXISTS idx_brain_asset_derivatives_owner_asset ON brain_asset_derivatives(owner_uid, asset_id);
CREATE INDEX IF NOT EXISTS idx_brain_asset_derivatives_owner_kind  ON brain_asset_derivatives(owner_uid, kind);
