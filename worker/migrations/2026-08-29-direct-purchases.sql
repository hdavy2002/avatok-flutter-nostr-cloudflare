-- [PAY-CASHFREE-1] Money paid at a gateway, before it becomes an entitlement.
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.
--
-- WHY A SEPARATE TABLE. `orders` is the escrow/settlement record and only exists once a
-- purchase has succeeded. This row exists from the moment a buyer is SENT to the gateway,
-- which is the window where things go wrong: they abandon, they pay and the webhook is
-- lost, they pay twice, the webhook arrives before the browser returns. Without a durable
-- row spanning that window, a lost webhook is an unrecoverable "they paid and got
-- nothing" with nothing to reconcile against.
--
-- gateway_order_id is UNIQUE and is what the webhook is idempotent on. cf_order_id is
-- Cashfree's own id, stored for support.
--
-- Amounts are PAISE (integers), never rupee decimals. Everything else in this codebase
-- counts in whole tokens (1 token = Rs 1); paise appear only where a gateway demands a
-- sub-rupee unit, and the conversion happens in lib/cashfree.ts alone.

CREATE TABLE IF NOT EXISTS direct_purchases (
  purchase_id       TEXT PRIMARY KEY,
  gateway           TEXT NOT NULL DEFAULT 'cashfree',
  gateway_order_id  TEXT NOT NULL UNIQUE,
  cf_order_id       TEXT,
  uid               TEXT NOT NULL,
  listing_id        TEXT NOT NULL,
  booking_id        TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  -- The split of what the buyer paid, frozen here so a receipt can be reprinted without
  -- recomputing it from config that may since have changed.
  base_paise        INTEGER NOT NULL CHECK (base_paise >= 0),
  gst_paise         INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
  total_paise       INTEGER NOT NULL CHECK (total_paise >= 0),
  -- pending  : sent to the gateway, outcome unknown
  -- paid     : gateway CONFIRMED payment (webhook + a read-back of the order)
  -- credited : escrow funded and the entitlement written — the terminal happy state
  -- failed   : gateway reported failure, or the buyer abandoned
  -- refunded : reversed to source
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','credited','failed','refunded')),
  -- The affiliate this purchase should pay a bounty to, captured from the ava_aff_dev
  -- cookie at order time. [GUEST-AFFIL-BOUNTY-1]
  affiliate_uid     TEXT,
  bounty_paid       INTEGER NOT NULL DEFAULT 0,
  order_id          TEXT,          -- the commercial order, once created
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_purchase_uid ON direct_purchases(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_direct_purchase_status ON direct_purchases(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_direct_purchase_listing ON direct_purchases(listing_id, status);
-- Reconciliation sweep: "paid at the gateway but never credited here" is the query that
-- finds every buyer who paid and got nothing.
CREATE INDEX IF NOT EXISTS idx_direct_purchase_order ON direct_purchases(order_id);
