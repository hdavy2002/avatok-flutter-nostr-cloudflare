-- [DASH2-API 2026-09-25] Dashboard 2 (customer dashboard). DB: avatok-meta (DB_META).
-- CREATE-only file on purpose (CLAUDE.md rule 6: d1_apply_alters.py skips CREATEs).
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/<this file>
-- NOT APPLIED by the implementing agent. Idempotent (IF NOT EXISTS).
-- Customer refund REQUESTS and the admin record of a manual bank-app refund.
-- payment_id = the Dashboard 2 PaymentLine id (hdfc_sms_payment_intents.intent_id
-- when a UPI intent exists, else orders.id). Money is integer PAISE.
-- This table does NOT move money: the refund itself is made by hand from the bank
-- app and the admin route only records its UTR.
CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL,
  uid          TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0 AND typeof(amount_paise) = 'integer'),
  reason       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('requested','refunded','rejected')),
  refund_vpa   TEXT,
  refund_utr   TEXT,
  requested_at INTEGER NOT NULL,
  refunded_at  INTEGER,
  admin_uid    TEXT
);
-- One OPEN (requested) or completed (refunded) refund per payment; a rejected
-- request may be followed by a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_one_open ON refunds(payment_id) WHERE status IN ('requested','refunded');
CREATE INDEX IF NOT EXISTS idx_refunds_uid ON refunds(uid, requested_at);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status, requested_at);
