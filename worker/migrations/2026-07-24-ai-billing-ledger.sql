-- [AI-BILLING-CORE-1] Universal AIJob reserve/settle/release ledger (Specs/
-- AUDIT-MESSENGER-AI-MEDIA-UI-2026-07-24.md §H2/H3/H6, §J13).
--
-- Reservation ADMISSION is NOT this table — it lives in the WalletDO's
-- existing generic escrow primitives (reserve / consume_reserved /
-- release_reservation, worker/src/do/wallet.ts, tag [AVA-CAMP-B1-WALLET]),
-- reused as-is by worker/src/lib/ai_billing.ts. This table is the durable
-- support/reconciliation record carrying AI-specific billing detail (model
-- requested/actual, usage breakdown, provider cost, markup, terminal status)
-- that the generic WalletDO resv table does not know about.
--
-- D1 binding: DB_WALLET = avatok-wallet (same binding as wallet_ledger.sql).
-- op_id is the PK and is the SAME id used as the WalletDO op_id prefix
-- (`${opId}:reserve` / `:settle` / `:release`) — ai_billing.ts writes this row
-- via `INSERT ... ON CONFLICT(op_id) DO UPDATE`, so every terminal transition
-- for one AI job lands on exactly one row (idempotent replay-safe by
-- construction, never a duplicate).
--
-- Apply: scripts/cf.sh worker d1 execute DB_WALLET --remote \
--   --file=migrations/2026-07-24-ai-billing-ledger.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules.)
CREATE TABLE IF NOT EXISTS ai_billing_ledger (
  op_id                TEXT PRIMARY KEY,
  uid                  TEXT NOT NULL,
  capability           TEXT NOT NULL,          -- 'chat_ava' | 'util' | ... (NEVER a safety capability — those bypass this contract entirely)
  modality             TEXT NOT NULL,          -- 'text' | 'image' | 'audio' | 'video' | 'ocr'
  model_requested       TEXT NOT NULL,
  model_actual          TEXT,                  -- filled in at settle time; NULL while status='reserved'
  usage_json            TEXT,                  -- JSON {inputTokens, outputTokens, images?, ocrPages?, avSeconds?}
  provider_cost_micro   INTEGER,               -- provider cost in micro-USD (USD * 1e6), pre-markup; NULL until settled
  markup_rate           INTEGER NOT NULL,      -- basis points of percent, e.g. 130 == 1.30x (the 30% markup)
  user_charge_tokens    INTEGER NOT NULL DEFAULT 0, -- wallet tokens actually debited (0 while reserved/released/failed_unbilled)
  status                TEXT NOT NULL,         -- reserved | settled | released | failed_billed | failed_unbilled
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_billing_ledger_uid_time ON ai_billing_ledger(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_billing_ledger_status ON ai_billing_ledger(status);
