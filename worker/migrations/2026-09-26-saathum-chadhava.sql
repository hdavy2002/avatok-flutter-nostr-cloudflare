-- [SAATHUM-CHADHAVA 2026-09-26] Chadhava product catalogue (admin-managed).
-- DB: avatok-meta (DB_META). Contract: Specs/SPEC-2026-09-26-SAATHUM-CHECKOUT.md ("Data").
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS / INSERT OR IGNORE).
--
-- Every event offers all ACTIVE products (public GET filters WHERE active=1). Soft
-- delete: DELETE from the admin UI sets active=0 rather than removing the row, so a
-- product already frozen into a past checkout's quote JSON keeps its own record even
-- if it is later retired (worker/src/routes/saathum_chadhava.ts).
CREATE TABLE IF NOT EXISTS saathum_chadhava (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  price_rupees INTEGER NOT NULL CHECK(price_rupees BETWEEN 1 AND 100000),
  image_url    TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saathum_chadhava_active_sort ON saathum_chadhava(active, sort, title);

-- Seed (owner will generate the real photos later; UIs fall back gracefully on a 404).
INSERT OR IGNORE INTO saathum_chadhava (id, title, description, price_rupees, image_url, active, sort, created_at, updated_at)
VALUES
  ('chadhava-marigold-garland', 'Marigold garland', 'A fresh marigold garland offered in your name during the havan.', 51,
   '/assets/saathum-chadhava/marigold-garland.jpg', 1, 10, strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('chadhava-havan-samagri', 'Havan wood & samagri', 'Sacred wood and samagri offered into the havan fire in your name.', 101,
   '/assets/saathum-chadhava/havan-samagri.jpg', 1, 20, strftime('%s','now')*1000, strftime('%s','now')*1000);
