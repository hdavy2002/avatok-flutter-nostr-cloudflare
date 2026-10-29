-- [HF-PAGES-2] Re-accept versioning. `version` bumps on every admin edit; `material_version` bumps only when the admin marks the
-- edit as an important change (PUT ... { material: true }). The registration/re-accept pin of an agreement is
-- `site:<slug>:<material_version>` (worker/src/lib/hf_registration_policies.ts). Existing rows start at 1, which the code treats
-- as equal to the old sha256 pins, so nobody is asked to accept again when this ships.
-- ALTER-only: apply with  scripts/d1_apply_alters.py worker/migrations/2026-10-29-hf-site-pages-material-alters.sql
ALTER TABLE site_pages ADD COLUMN material_version INTEGER NOT NULL DEFAULT 1;
