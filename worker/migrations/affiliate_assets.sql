-- AvaAffiliate v2 — generated marketing-asset records (routes/affiliate_assets.ts).
-- DB: avatok-meta (DB_META). The bytes live in the PUBLIC blob bucket
-- (avatok-blobs, key affiliate-assets/<link_id>/<format>-<ts>.png) and are
-- served by blossom.avatok.ai / the /cdn-cgi/image transform path.
CREATE TABLE IF NOT EXISTS affiliate_assets (
  id         TEXT PRIMARY KEY,                       -- uuid
  link_id    TEXT NOT NULL REFERENCES affiliate_links(id),
  format     TEXT NOT NULL,                          -- 'story' | 'post' | 'banner'
  r2_key     TEXT NOT NULL,                          -- avatok-blobs key
  created_at INTEGER NOT NULL                        -- ms epoch (one ts per 3-image run)
);
CREATE INDEX IF NOT EXISTS idx_aff_assets_link ON affiliate_assets(link_id, created_at DESC);
