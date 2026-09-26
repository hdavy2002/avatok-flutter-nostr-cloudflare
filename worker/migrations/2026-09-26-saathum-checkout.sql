-- [SAATHUM-CHECKOUT-API 2026-09-26] Saa Thum event checkout, UPI payment (HDFC SMS
-- rail) and receipt/profile state. DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (per CLAUDE.md / DASH2 convention: the alter-applier
-- script skips any file containing a CREATE TABLE statement, and is instead run
-- against ALTER-only files). NOT applied by the implementing agent -- the
-- coordinator applies it with:
--   scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- Idempotent (IF NOT EXISTS throughout).
--
-- PAYMENT DESIGN NOTE (read before touching this table or the matching code in
-- routes/saathum_checkout.ts): `hdfc_sms_smoke_intents` (protocol v2, see
-- lib/hdfc_sms_smoke.ts) hard-caps amount_paise at exactly 100 via
-- `CHECK(amount_paise=100)` -- it is a Rs.1 admin/customer-test smoke harness, not
-- a real-amount payment ledger, and that CHECK cannot be relaxed without an
-- invasive table-rebuild migration on a live shared payments table. Saa Thum
-- therefore keeps its OWN amount/reference/expiry columns directly on
-- saathum_checkouts (below) instead of a row in hdfc_sms_smoke_intents, but still
-- verifies payment against the SAME shared bank-evidence table
-- `hdfc_sms_smoke_receipts` (which has no such amount cap -- it already stores
-- whatever amount_paise the bank SMS parser read) using the same
-- receiving_account_key. See the long comment in routes/saathum_checkout.ts
-- (finalizeSaathumCheckoutByIntent) for the exact matching predicate. This is a
-- deliberate deviation from the spec's literal "reuse
-- createPublicConcurrentIntent/matchIntent" instruction -- flagged in the agent's
-- final report for coordinator review.

CREATE TABLE IF NOT EXISTS saathum_checkouts (
  checkout_id           TEXT PRIMARY KEY,
  uid                   TEXT NOT NULL,
  listing_id            TEXT NOT NULL,
  request_key           TEXT NOT NULL,

  -- Frozen quote (server-computed; see lib/saathum_checkout_logic.ts computeQuote).
  quote_json            TEXT NOT NULL,
  subtotal_rupees       INTEGER NOT NULL CHECK (subtotal_rupees >= 0),
  gst_rupees            INTEGER NOT NULL CHECK (gst_rupees >= 0),
  total_rupees          INTEGER NOT NULL CHECK (total_rupees > 0),
  -- Portion of total_rupees that is the event ticket itself, i.e. listings.price at
  -- freeze time -- this is the only part that goes through the shared commercial
  -- ticket-provisioning/escrow pipeline (provisionFromGatewayPurchase, "ticket only"
  -- per spec). The remainder (chadhava + dakshina + prasad + their share of GST) is
  -- Saa Thum platform revenue tracked only on this row.
  ticket_rupees         INTEGER NOT NULL CHECK (ticket_rupees >= 0),

  sankalp_json          TEXT NOT NULL,
  prasad                INTEGER NOT NULL DEFAULT 0 CHECK (prasad IN (0,1)),
  address_json          TEXT,

  status                TEXT NOT NULL DEFAULT 'awaiting_payment'
                         CHECK (status IN ('awaiting_payment','confirmed','review_pending','expired','cancelled')),

  -- Payment (HDFC UPI SMS rail; see design note above).
  receiving_account_key TEXT NOT NULL,
  amount_paise          INTEGER NOT NULL CHECK (amount_paise > 0),
  payer_reference        TEXT CHECK (payer_reference IS NULL OR (length(payer_reference)=12 AND payer_reference NOT GLOB '*[^0-9]*')),
  reference_revision     INTEGER NOT NULL DEFAULT 0 CHECK (reference_revision >= 0),
  reason_code             TEXT,
  utr                    TEXT,
  commercial_order_id    TEXT,
  receipt_no             TEXT,

  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  confirmed_at           INTEGER,
  email_sent_at          INTEGER,
  reminder_sent_at       INTEGER, -- [SAATHUM-CHECKOUT-API follow-up] 30-min-before reminder email

  UNIQUE (uid, request_key)
);
CREATE INDEX IF NOT EXISTS idx_saathum_checkouts_uid ON saathum_checkouts(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saathum_checkouts_listing ON saathum_checkouts(listing_id, created_at DESC);
-- One live payer_reference (UTR) claim per Saa Thum checkout ever, so the same bank
-- transaction can never be typed into two different checkouts and confirm both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saathum_checkouts_reference
  ON saathum_checkouts(receiving_account_key, payer_reference) WHERE payer_reference IS NOT NULL;
-- Fast lookup for the hdfcSmsIncoming hook: "is any checkout waiting on this
-- (account, reference, amount)?"
CREATE INDEX IF NOT EXISTS idx_saathum_checkouts_awaiting
  ON saathum_checkouts(receiving_account_key, payer_reference, amount_paise, status);

-- Sankalp + address are saved into the existing profile store (user_profile_extras,
-- user_addresses) by routes/saathum_checkout.ts saveToProfile — no separate table.
