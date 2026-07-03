-- [UI-MKT-3] Marketplace favorites (hearts). DB: avatok-meta (DB_META).
-- One row per (user, listing). Low-write, per-user surface — D1 is fine here.
-- The card/list query LEFT JOINs this on uid to hydrate a `favorited` flag per
-- fetch (per-account scoping: the uid comes from the authed request, never a
-- global key). insert OR IGNORE on POST, delete on DELETE, list on GET.
CREATE TABLE IF NOT EXISTS listing_favorites (
  uid        TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, listing_id)
);
-- "my favorites" reads newest-first per user; the card LEFT JOIN uses the PK.
CREATE INDEX IF NOT EXISTS idx_listing_favorites_uid ON listing_favorites(uid, created_at);
