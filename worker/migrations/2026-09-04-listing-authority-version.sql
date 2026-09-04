-- [LIST-AUTHORITY-HARDEN-1] Optimistic revision for every listings write.
-- Applied with scripts/d1_apply_alters.py so a partial/repeated rollout is safe.
ALTER TABLE listings ADD COLUMN authority_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN publication_version INTEGER NOT NULL DEFAULT 0;
