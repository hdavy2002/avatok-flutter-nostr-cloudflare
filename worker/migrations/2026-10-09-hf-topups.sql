-- [HF-TOPUP-1] HF wallet top-ups (real money in, gateway-agnostic). DB_META. Spec: Specs/HF-WALLET-TOPUP.md
-- Apply with: scripts/cf.sh worker d1 execute DB_META --remote --file=migrations/2026-10-09-hf-topups.sql
-- Safe to re-run (IF NOT EXISTS). Nothing writes here until hfTopupEnabled is on.
CREATE TABLE IF NOT EXISTS hf_topups (
  id TEXT PRIMARY KEY,                 -- OUR order id, prefix hftop_ (also the gateway receipt / notes / order_id)
  uid TEXT NOT NULL,
  amount_rupees INTEGER NOT NULL,
  gateway TEXT NOT NULL,
  gateway_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',  -- created | paid | failed | refunded | expired
  credited INTEGER NOT NULL DEFAULT 0,     -- 1 once the WalletDO credit (op_id hftop:<id>) has been applied
  raw_status TEXT,                          -- last gateway-side status string seen
  gateway_payment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hf_topups_gateway_order ON hf_topups(gateway, gateway_order_id);
CREATE INDEX IF NOT EXISTS idx_hf_topups_uid ON hf_topups(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_hf_topups_status ON hf_topups(status, created_at);
