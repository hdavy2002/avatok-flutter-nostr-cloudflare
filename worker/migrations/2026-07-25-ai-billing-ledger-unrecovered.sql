-- [AI-WALLET-SPENDABLE-2] Additive columns for Part VIII §52/§65/§66 of
-- Specs/ROOT-CAUSE-REPORT-RECURRING-ISSUES-2026-07-25.md — unrecovered-cost
-- and cost-provenance tracking. Same table/binding as
-- 2026-07-24-ai-billing-ledger.sql (DB_WALLET = avatok-wallet).
--
-- unrecovered_micro_usd — platform LOSS recorded when a settled job's actual
-- marked-up cost exceeded what the reservation + the user's spendable funds
-- could cover. This is NEVER hidden user debt (see acct.debt_micro_usd in
-- WalletDO, a separate <1-token remainder, invariant 0 <= debt_micro_usd <
-- 10,000) and NEVER consumes a future top-up — it is a pure accounting
-- record of money the platform absorbed, per §66.
--
-- cost_source — where the CHARGED amount actually came from: 'provider'
-- (OpenRouter usage.cost, ground truth), 'catalog' (AI_PRICE_CATALOG
-- estimate, used only when no provider cost was reported), 'unknown' (NEITHER
-- was available — the job was delivered free and AI_PRICE_UNKNOWN was
-- alerted, per §65), 'free' (a FREE_CAPABILITIES job — never reaches this
-- table via a real charge, but a caller may still log a row), or 'n/a'
-- (unmetered / aiWalletMeteringEnabled off).
--
-- Apply: scripts/cf.sh worker d1 execute DB_WALLET --remote \
--   --file=migrations/2026-07-25-ai-billing-ledger-unrecovered.sql
-- (staging is the default target; prod requires ALLOW_PROD=1 — never invoke
-- wrangler directly, per the repo's staging/prod rules.)
ALTER TABLE ai_billing_ledger ADD COLUMN unrecovered_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_billing_ledger ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'n/a';
CREATE INDEX IF NOT EXISTS idx_ai_billing_ledger_unrecovered ON ai_billing_ledger(unrecovered_micro_usd) WHERE unrecovered_micro_usd > 0;
