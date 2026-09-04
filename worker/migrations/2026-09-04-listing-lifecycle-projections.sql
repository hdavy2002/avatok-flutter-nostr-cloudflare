-- [LIST-LIFECYCLE-PROJECTION-1] Durable, idempotent follower fan-out ledger.
CREATE TABLE IF NOT EXISTS listing_fanout_events (
  event_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_listing_fanout_pending
  ON listing_fanout_events(state, updated_at);

-- Increment the revision for every update, including older writers which do not
-- yet know about authority_version. The WHEN predicate also makes the trigger's
-- own UPDATE a no-op if recursive triggers are enabled.
CREATE TRIGGER IF NOT EXISTS listings_authority_version_after_update
AFTER UPDATE ON listings
FOR EACH ROW
WHEN NEW.authority_version = OLD.authority_version
BEGIN
  UPDATE listings
     SET authority_version = OLD.authority_version + 1
   WHERE id = NEW.id;
END;
