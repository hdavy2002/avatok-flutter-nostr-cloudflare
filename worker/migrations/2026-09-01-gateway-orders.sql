-- [PAY-RAIL-1] Generic multi-gateway correlation: OUR order id <-> the gateway's own id,
-- plus webhook idempotency, for the /api/pay/:gateway/* routes (routes/pay.ts).
--
-- NOT EXECUTED BY CREATING THIS FILE. Applied deliberately, per environment.
--
-- WHY A SEPARATE TABLE FROM direct_purchases. direct_purchases (2026-08-29) belongs to the
-- DEDICATED /api/pay/cashfree/* routes (routes/cashfree.ts), which stay registered and
-- unchanged per spec §2.4. The generic /api/pay/:gateway/* routes serve razorpay, paytm,
-- stripe AND cashfree (the cashfree adapter is wired for completeness per spec §2.1, even
-- though it is shadowed by the dedicated route at the identical path and the picker keeps
-- it off by default) — giving them their own table keeps the two lanes from writing rows
-- into the same place under two different id schemes.
--
-- gateway_orders is the "we sent a buyer to this gateway" record, the same role
-- direct_purchases plays for Cashfree: it exists from the moment a buyer is sent to the
-- gateway (the window where things go wrong: they abandon, they pay and the webhook is
-- lost, they pay twice, the webhook arrives before the browser returns). order_id is OUR
-- id, minted by POST /api/pay/:gateway/order; (gateway, gateway_order_id) is unique per
-- gateway (Paytm and Cashfree both echo back the id we sent them, so gateway_order_id can
-- collide ACROSS gateways for the same order_id — the pair is what's unique, not the
-- column alone).
--
-- gateway_webhook_events is rule 2 of spec §2.5: "A gateway will deliver the same event
-- more than once. Key on (gateway, gateway_payment_id); a replay is a 200 with no side
-- effect." INSERT OR IGNORE into this table is the idempotency check itself — a 0-row
-- insert means "already handled, do nothing".
--
-- Amounts are PAISE (integers), never rupee decimals. 1 token = Rs 1 everywhere else in
-- this codebase (CLAUDE.md); paise appear only where a gateway demands a sub-rupee unit,
-- and the rupee<->paise conversion happens inside each adapter alone
-- (lib/payments/{razorpay,paytm,stripe_intl,cashfree_adapter}.ts).

CREATE TABLE IF NOT EXISTS gateway_orders (
  order_id           TEXT PRIMARY KEY,   -- OUR id
  gateway            TEXT NOT NULL CHECK (gateway IN ('razorpay','paytm','stripe','cashfree')),
  gateway_order_id   TEXT NOT NULL,
  uid                TEXT NOT NULL,
  listing_id         TEXT NOT NULL,
  booking_id         TEXT,
  kind               TEXT NOT NULL CHECK (kind IN ('live_event','consult_1to1')),
  -- Consults only, captured at order time for the same reason direct_purchases captures
  -- it: the webhook fires minutes later with no request to read a slot from.
  slot_start         INTEGER,
  slot_end           INTEGER,
  amount_paise       INTEGER NOT NULL CHECK (amount_paise >= 0),
  currency           TEXT NOT NULL DEFAULT 'INR',
  -- pending       : sent to the gateway, outcome unknown
  -- paid          : gateway CONFIRMED payment (webhook + a read-back of the order, where
  --                 the adapter supports one)
  -- credited      : escrow funded and the entitlement written — the terminal happy state
  -- failed        : gateway reported failure, or the buyer abandoned
  -- refunded      : reversed to source
  -- review_pending: amount mismatch or a provisioning failure that a retry cannot fix —
  --                 spec §2.5 rule 4, a hard failure, never a silent accept
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','credited','failed','refunded','review_pending')),
  gateway_payment_id TEXT,      -- set once the webhook identifies the specific payment
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_orders_gw_order ON gateway_orders(gateway, gateway_order_id);
CREATE INDEX IF NOT EXISTS idx_gateway_orders_uid ON gateway_orders(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_gateway_orders_status ON gateway_orders(status, updated_at);

-- Idempotency key for webhook delivery. PRIMARY KEY on the pair means a second INSERT for
-- the same (gateway, gateway_payment_id) fails the insert — the route treats that as
-- "already handled" and returns 200 with no side effect, per spec §2.5 rule 2.
CREATE TABLE IF NOT EXISTS gateway_webhook_events (
  gateway            TEXT NOT NULL,
  gateway_payment_id TEXT NOT NULL,
  order_id           TEXT NOT NULL,
  received_at        INTEGER NOT NULL,
  PRIMARY KEY (gateway, gateway_payment_id)
);
