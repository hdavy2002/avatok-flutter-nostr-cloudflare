-- AvaAffiliate — links + lifetime attribution (Specs/proposals/PROPOSAL-AVA-AFFILIATE.md §4).
-- DB: avatok-meta (DB_META). Money lives in avatok-wallet (affiliate_wallet.sql);
-- pending pre-signup clicks live in KV (`aff_pending:<device>`, TTL 30 d, last
-- write wins) — never in D1.

-- One affiliate account per user. L1 (verified email+password) is the entire bar.
CREATE TABLE IF NOT EXISTS affiliates (
  uid           TEXT PRIMARY KEY,               -- Clerk uid
  code          TEXT UNIQUE NOT NULL,           -- short public handle, e.g. 'dvy7k2'
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at    INTEGER NOT NULL
);

-- One link/QR per (affiliate, listing) pair — the URL is avatok.ai/a/<id>.
CREATE TABLE IF NOT EXISTS affiliate_links (
  id            TEXT PRIMARY KEY,               -- short unguessable link id
  affiliate_uid TEXT NOT NULL REFERENCES affiliates(uid),
  listing_id    TEXT NOT NULL,                  -- listings.id | avavoice_agents.id
  app           TEXT NOT NULL,                  -- 'avalive' | 'avaconsult' | 'avavoice'
  status        TEXT NOT NULL DEFAULT 'active', -- active | paused | listing_dead
  clicks        INTEGER NOT NULL DEFAULT 0,     -- raw click counter (PostHog holds the funnel)
  created_at    INTEGER NOT NULL,
  UNIQUE(affiliate_uid, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_aff_links_affiliate ON affiliate_links(affiliate_uid);
CREATE INDEX IF NOT EXISTS idx_aff_links_listing   ON affiliate_links(listing_id);

-- The lifetime binding: one affiliate per (referred user, listing), set once at
-- signup / first authenticated open. Self-referral + creator-self-promo are
-- rejected at bind time (and re-checked at settle).
CREATE TABLE IF NOT EXISTS affiliate_attributions (
  referred_uid  TEXT NOT NULL,
  listing_id    TEXT NOT NULL,
  link_id       TEXT NOT NULL REFERENCES affiliate_links(id),
  affiliate_uid TEXT NOT NULL,
  bound_at      INTEGER NOT NULL,
  source        TEXT NOT NULL,                  -- 'qr' | 'link' | 'share'
  PRIMARY KEY (referred_uid, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_aff_attr_link      ON affiliate_attributions(link_id);
CREATE INDEX IF NOT EXISTS idx_aff_attr_affiliate ON affiliate_attributions(affiliate_uid, bound_at);
