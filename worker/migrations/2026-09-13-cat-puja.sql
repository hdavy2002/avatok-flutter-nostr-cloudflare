-- [LISTING-WIZARD-1 2026-09-13] Add the standalone "Puja" category.
-- Runtime authority for categories is this table, NOT the generated mirrors in
-- web/src/lib/listingTaxonomy.ts or app/lib/core/listing_groups.dart. Without
-- this row /api/explore/categories omits it and publish 400s unknown_category.
-- Canonical source: Specs/listing-taxonomy.json (regenerate mirrors with
-- scripts/gen_listing_taxonomy.py — never hand-edit them).
--
-- CREATE-free on purpose: scripts/d1_apply_alters.py skips non-ALTER lines, so
-- apply this with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-09-13-cat-puja.sql
INSERT OR IGNORE INTO listing_categories (id, label, emoji, sort, active, group_id) VALUES
  ('live_puja_ritual',  'Puja',  '🕉️', 35, 1, 'india_goes_live');
