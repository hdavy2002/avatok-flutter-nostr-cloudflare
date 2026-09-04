-- [LIST-REVIEW-BINDING-1] Bind an admin's approval to the CONTENT that was actually
-- approved, not just the row id. DB: avatok-meta (DB_META). ALTERs only — mixing a
-- CREATE in here would break scripts/d1_apply_alters.py, which parses ALTERs and
-- ONLY ALTERs (see 2026-07-18-listings-taxonomy-columns.sql:70-75 for why that
-- split is load-bearing; 2026-09-02-listings-content.sql repeats the same warning).
--
-- Why: `updateListing`'s only status guard is cancelled/completed -> 409; the UPDATE
-- never touches `status`. A creator can get a listing approved, then rewrite title,
-- price, category, description and photos, and it stays `approved`/`published` with
-- no re-review. This is the second half of C02 (commit fa44bc21 closed the first
-- half — attrs.poster forgery). `reviewed_content_hash` is a fingerprint over the
-- MATERIAL fields an admin actually judged (see `reviewedContentHash()` in
-- worker/src/routes/listings.ts); `updateListing` recomputes it after a material
-- edit and, on a mismatch, walks the listing back to `pending_review` (or refuses
-- the edit with 409 if the listing already has sold entitlements) via the existing
-- `checkTransition` table in lib/listing_transitions.ts.
--
-- IDEMPOTENCY — same hazard as every ALTER-only file here: SQLite/D1 has no
-- `ADD COLUMN IF NOT EXISTS`, so a raw re-run aborts at the first duplicate and
-- silently leaves the rest missing. All three columns are nullable with no
-- DEFAULT — NULL is the correct "never reviewed under this scheme yet" value for
-- every existing row, including ones already sitting in `approved`/`published`
-- today (they simply re-earn a hash the next time an admin approves them again).
--
-- APPLY (idempotent, resumable, staging by default, prod fail-closed):
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-04-listing-reviewed-version.sql --binding DB_META --dry-run
--   python3 scripts/d1_apply_alters.py worker/migrations/2026-09-04-listing-reviewed-version.sql --binding DB_META
--   ALLOW_PROD=1 python3 scripts/d1_apply_alters.py worker/migrations/2026-09-04-listing-reviewed-version.sql --binding DB_META
--
-- RAW (only ever correct on a known-fresh DB; aborts on first duplicate elsewhere):
--   scripts/cf.sh worker d1 execute DB_META --remote --file=worker/migrations/2026-09-04-listing-reviewed-version.sql
--
-- NOT EXECUTED BY CREATING THIS FILE. This agent does not run migrations.

ALTER TABLE listings ADD COLUMN reviewed_content_hash TEXT;  -- fingerprint of the material content an admin approved (reviewedContentHash())
ALTER TABLE listings ADD COLUMN reviewed_at INTEGER;         -- epoch ms of the approval write that set reviewed_content_hash
ALTER TABLE listings ADD COLUMN reviewed_by TEXT;            -- admin uid that performed that approval
