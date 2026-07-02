-- Maps each user to their Bunny Stream collection (their "folder" for videos), so
-- video ownership is explicit and an account delete can remove the whole collection.
-- Lives in DB_META.
CREATE TABLE IF NOT EXISTS bunny_collections (
  uid          TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,   -- Bunny collection GUID
  created_at    INTEGER NOT NULL
);
