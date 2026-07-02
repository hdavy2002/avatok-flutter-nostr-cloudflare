-- FTS5 index for people search (replaces the full-table LIKE '%q%' scan in
-- /api/search). External-content table mirrors `profiles`; triggers keep it in
-- sync; MATCH is index-backed and supports prefix queries (e.g. `dav*`).
CREATE VIRTUAL TABLE IF NOT EXISTS profiles_fts USING fts5(
  uid UNINDEXED,
  handle,
  display_name,
  content=profiles,
  content_rowid=rowid
);

-- One-time backfill of existing rows.
INSERT INTO profiles_fts(rowid, uid, handle, display_name)
  SELECT rowid, uid, handle, display_name FROM profiles
  WHERE rowid NOT IN (SELECT rowid FROM profiles_fts);

-- Keep FTS in sync with profiles.
CREATE TRIGGER IF NOT EXISTS profiles_ai AFTER INSERT ON profiles BEGIN
  INSERT INTO profiles_fts(rowid, uid, handle, display_name)
  VALUES (new.rowid, new.uid, new.handle, new.display_name);
END;

CREATE TRIGGER IF NOT EXISTS profiles_ad AFTER DELETE ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, uid, handle, display_name)
  VALUES ('delete', old.rowid, old.uid, old.handle, old.display_name);
END;

CREATE TRIGGER IF NOT EXISTS profiles_au AFTER UPDATE ON profiles BEGIN
  INSERT INTO profiles_fts(profiles_fts, rowid, uid, handle, display_name)
  VALUES ('delete', old.rowid, old.uid, old.handle, old.display_name);
  INSERT INTO profiles_fts(rowid, uid, handle, display_name)
  VALUES (new.rowid, new.uid, new.handle, new.display_name);
END;
