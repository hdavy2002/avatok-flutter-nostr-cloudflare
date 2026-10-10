-- [HF-TOK-MATH-1] hf_calls pricing snapshot + per-second settlement results. DB_META. NOT APPLIED by this issue: HF-TOK-CALLS-1 applies it.
-- ALTER lines fail harmlessly if re-run once the columns exist; run once, one statement at a time if needed.
-- Snapshot (taken at call start, so a later config change never alters a running call):
ALTER TABLE hf_calls ADD COLUMN rate_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN call_cost_paise_per_min INTEGER;
ALTER TABLE hf_calls ADD COLUMN host_share_bps INTEGER;
ALTER TABLE hf_calls ADD COLUMN tax_mode TEXT;
ALTER TABLE hf_calls ADD COLUMN split_rule_version TEXT;
-- Results (written once at settle):
ALTER TABLE hf_calls ADD COLUMN billable_seconds INTEGER;
ALTER TABLE hf_calls ADD COLUMN consumed_value_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN call_cost_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN host_earning_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN platform_paise INTEGER;
ALTER TABLE hf_calls ADD COLUMN tokens_spent_micro INTEGER;
ALTER TABLE hf_calls ADD COLUMN lots_used TEXT;      -- JSON: [{lotId, micro, valuePaise}]
