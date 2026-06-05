-- CSAM exact-hash blocklist (DB_MODERATION). Loaded from vetted sources only
-- (NCMEC / PhotoDNA / law-enforcement lists). Checked by the moderation consumer
-- BEFORE any AI scan. Empty table ⇒ the CSAM hash gate is a no-op (bypassed) until
-- you obtain access and load hashes. NEVER populate this from a generic NSFW model.
-- Apply: wrangler d1 execute avatok-moderation --remote --file=worker/migrations/csam_hashes.sql
CREATE TABLE IF NOT EXISTS csam_hashes (
  id        TEXT PRIMARY KEY,
  algo      TEXT NOT NULL,            -- 'sha256' | 'md5'
  value     TEXT NOT NULL,            -- the hash (lowercase hex)
  source    TEXT NOT NULL,            -- 'ncmec' | 'photodna' | 'thorn' | 'le'
  added_at  INTEGER NOT NULL
);
-- Exact-match lookup path used by csamCheckHash().
CREATE UNIQUE INDEX IF NOT EXISTS idx_csam_algo_value ON csam_hashes(algo, value);
