-- DB_MEDIA — Phase 4 (AvaStorage): per-user quota summary + monthly snapshots.
-- Apply via the D1 REST API: POST .../d1/database/<DB_MEDIA>/query.
--
-- storage_quota is the SUMMARY the AvaStorage graphs repaint from (perf budget
-- §7: never aggregate user_media on screen open). It is recomputed by the
-- worker after every registerFile (upload/record/delete) and read by
-- GET /api/storage/summary + the monthly billing cron.
--   used_bytes  — dedup-counted: each content key once (shortcuts are free).
--   by_category — JSON {category:{count,bytes}} (≤6 keys: image|video|audio|
--                 document|other + total handled separately).
--   state       — ok | over_quota_paying | read_only  (NEVER delete user files).

CREATE TABLE IF NOT EXISTS storage_quota (
  uid         TEXT PRIMARY KEY,
  used_bytes  INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 5368709120,   -- 5 GB free
  state       TEXT NOT NULL DEFAULT 'ok',
  by_category TEXT,                                  -- JSON summary for the graphs
  updated_at  INTEGER
);

-- Monthly usage snapshots → AvaStorage trend mini-bars (last 6 months).
-- Upserted daily by the consumers cron (cheap INSERT..SELECT over storage_quota).
CREATE TABLE IF NOT EXISTS storage_snapshots (
  uid        TEXT NOT NULL,
  month      TEXT NOT NULL,            -- 'YYYY-MM'
  used_bytes INTEGER NOT NULL,
  PRIMARY KEY (uid, month)
);
CREATE INDEX IF NOT EXISTS idx_storage_snap_uid ON storage_snapshots(uid, month DESC);
