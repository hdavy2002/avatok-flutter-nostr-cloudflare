-- AvaAffiliate — commission reporting (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md §4).
-- DB: avatok-wallet (DB_WALLET). Money itself flows through the double-entry
-- wallet_ledger (platform:fees → user:<affiliate>, type 'affiliate_commission')
-- inside the same settlement pass as the creator/platform split — this table is
-- a reporting/projection table, NEVER a balance source.

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id              TEXT PRIMARY KEY,             -- = settlement id + ':aff' (idempotent)
  order_id        TEXT NOT NULL,                -- escrow order ref (refund clawback lookup)
  link_id         TEXT NOT NULL,
  affiliate_uid   TEXT NOT NULL,
  referred_uid    TEXT NOT NULL,
  listing_id      TEXT NOT NULL,
  app             TEXT NOT NULL,                -- 'avalive' | 'avaconsult' | 'avavoice'
  gross_coins     INTEGER NOT NULL,
  affiliate_coins INTEGER NOT NULL,             -- min(floor(gross × affiliate_default), platform_cut)
  admin_coins     INTEGER NOT NULL,             -- platform_cut − affiliate_coins
  reversed_coins  INTEGER NOT NULL DEFAULT 0,   -- proportional refund clawback applied so far
  status          TEXT NOT NULL,                -- held | settled | reversed
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aff_comm_affiliate ON affiliate_commissions(affiliate_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_aff_comm_order     ON affiliate_commissions(order_id);
CREATE INDEX IF NOT EXISTS idx_aff_comm_link      ON affiliate_commissions(link_id, created_at);
CREATE INDEX IF NOT EXISTS idx_aff_comm_referred  ON affiliate_commissions(referred_uid, listing_id);

-- The 10%-of-gross rate is data, not code — tunable without a deploy (§2).
INSERT INTO commission_rates (app_name, rate, updated_at) VALUES
  ('affiliate_default', 0.10, 0)
ON CONFLICT(app_name) DO NOTHING;
