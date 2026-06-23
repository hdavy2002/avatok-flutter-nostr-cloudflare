-- DB_META — Phase 1 subscription tiers (Free/Plus/Pro/Max).
-- One row per user holding their current billing tier + renewal/expiry.
-- Source of truth is the payment webhook (Stripe) / Play verification; the app
-- reads tier from here (echoed in the wallet balance response).
-- Apply: wrangler d1 execute avatok-meta --file=migrations/subscriptions.sql

CREATE TABLE IF NOT EXISTS subscriptions (
  uid         TEXT PRIMARY KEY,                 -- account id (Clerk uid)
  tier        INTEGER NOT NULL DEFAULT 0,       -- 0=Free 1=Plus 2=Pro 3=Max
  status      TEXT NOT NULL DEFAULT 'none',     -- 'active'|'canceled'|'none'
  source      TEXT NOT NULL DEFAULT 'none',     -- 'stripe'|'play'|'none'
  renews_at   INTEGER,                          -- epoch ms; downgrade to Free after this
  ref         TEXT,                             -- stripe subscription id / play purchase token
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_tier ON subscriptions(tier);
CREATE INDEX IF NOT EXISTS idx_subs_renews ON subscriptions(renews_at);

-- Pending checkout records (web Stripe subscription sessions), so the webhook can
-- map an incoming event back to a uid + intended tier idempotently.
CREATE TABLE IF NOT EXISTS subscription_checkouts (
  id          TEXT PRIMARY KEY,                 -- our checkout id (also Stripe metadata)
  uid         TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  source      TEXT NOT NULL,                    -- 'stripe'|'play'
  session_id  TEXT,                             -- stripe checkout session id
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'done'|'void'
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subco_uid ON subscription_checkouts(uid);
CREATE INDEX IF NOT EXISTS idx_subco_session ON subscription_checkouts(session_id);
